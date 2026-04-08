// src/smart-agent/api-adapters/anthropic-adapter.ts

import { randomUUID } from 'node:crypto';

import type { Message } from '../../types.js';
import type {
  AgentCallOptions,
  OrchestratorError,
  SmartAgentResponse,
  StopReason,
} from '../interfaces/agent-contracts.js';
import {
  AdapterValidationError,
  type ApiRequestContext,
  type ApiSseEvent,
  type ILlmApiAdapter,
  type NormalizedRequest,
} from '../interfaces/api-adapter.js';
import type { LlmStreamChunk, Result } from '../interfaces/types.js';
import { toToolCallDelta } from '../utils/tool-call-deltas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStopReason(
  r: StopReason | 'error',
): 'end_turn' | 'tool_use' | 'max_tokens' {
  switch (r) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'error':
      return 'end_turn';
    default:
      return 'max_tokens';
  }
}

function sse(event: string, data: unknown): ApiSseEvent {
  return { event, data: JSON.stringify(data) };
}

// ---------------------------------------------------------------------------
// AnthropicApiAdapter
// ---------------------------------------------------------------------------

export class AnthropicApiAdapter implements ILlmApiAdapter {
  readonly name = 'anthropic';

  // -------------------------------------------------------------------------
  // normalizeRequest
  // -------------------------------------------------------------------------

  normalizeRequest(request: unknown): NormalizedRequest {
    if (typeof request !== 'object' || request === null) {
      throw new AdapterValidationError('Request body must be a JSON object');
    }

    const body = request as Record<string, unknown>;

    if (!Array.isArray(body.messages)) {
      throw new AdapterValidationError('messages must be a non-empty array');
    }

    if (body.messages.length === 0) {
      throw new AdapterValidationError('messages must be a non-empty array');
    }

    const messages: Message[] = [];

    // Extract system field (Anthropic has it separate from messages)
    if (typeof body.system === 'string' && body.system) {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      // system can be an array of content blocks [{type: "text", text: "..."}]
      const systemText = (body.system as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('\n');
      if (systemText) {
        messages.push({ role: 'system', content: systemText });
      }
    }

    // Convert Anthropic messages to normalized format
    for (const msg of body.messages as Array<Record<string, unknown>>) {
      const role = msg.role as string;

      if (role === 'user') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const blocks = msg.content as Array<Record<string, unknown>>;
          const textParts: string[] = [];

          for (const block of blocks) {
            if (block.type === 'text') {
              textParts.push(block.text as string);
            } else if (block.type === 'tool_result') {
              // tool_result blocks become separate tool messages
              const toolContent =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);
              messages.push({
                role: 'tool',
                content: toolContent,
                tool_call_id: block.tool_use_id as string,
              });
            }
          }

          if (textParts.length > 0) {
            messages.push({ role: 'user', content: textParts.join('\n') });
          }
        }
      } else if (role === 'assistant') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'assistant', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const blocks = msg.content as Array<Record<string, unknown>>;
          const textParts: string[] = [];
          const toolCalls: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }> = [];

          for (const block of blocks) {
            if (block.type === 'text') {
              textParts.push(block.text as string);
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id as string,
                type: 'function',
                function: {
                  name: block.name as string,
                  arguments: JSON.stringify(block.input),
                },
              });
            }
          }

          const assistantMsg: Message = {
            role: 'assistant',
            content: textParts.join('\n') || null,
          };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
          }
          messages.push(assistantMsg);
        }
      }
    }

    const options: AgentCallOptions = {};
    if (body.temperature !== undefined)
      options.temperature = body.temperature as number;
    if (body.max_tokens !== undefined)
      options.maxTokens = body.max_tokens as number;
    if (body.top_p !== undefined) options.topP = body.top_p as number;
    if (Array.isArray(body.stop_sequences))
      options.stop = body.stop_sequences as string[];
    if (Array.isArray(body.tools)) options.externalTools = body.tools;
    // Do NOT pass body.model to options — it would override the pipeline LLM model.
    // The request model name is stored in context.protocol for response formatting only.

    const id = `msg_${randomUUID()}`;

    const context: ApiRequestContext = {
      adapterName: this.name,
      protocol: {
        id,
        model: (body.model as string) ?? 'smart-agent',
      },
    };

    return {
      messages,
      stream: body.stream === true,
      options,
      context,
    };
  }

  // -------------------------------------------------------------------------
  // formatResult
  // -------------------------------------------------------------------------

  formatResult(
    response: SmartAgentResponse,
    context: ApiRequestContext,
  ): unknown {
    const { id, model } = context.protocol as {
      id: string;
      model: string;
    };

    const content: Array<Record<string, unknown>> = [];

    if (response.content) {
      content.push({ type: 'text', text: response.content });
    }

    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    // Ensure at least one content block
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: mapStopReason(response.stopReason),
      usage: {
        input_tokens: response.usage?.promptTokens ?? 0,
        output_tokens: response.usage?.completionTokens ?? 0,
      },
    };
  }

  // -------------------------------------------------------------------------
  // formatError
  // -------------------------------------------------------------------------

  formatError(error: OrchestratorError, _context: ApiRequestContext): unknown {
    return {
      type: 'error',
      error: {
        type: 'api_error',
        message: error.message,
      },
    };
  }

  // -------------------------------------------------------------------------
  // transformStream
  // -------------------------------------------------------------------------

  async *transformStream(
    source: AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>,
    context: ApiRequestContext,
  ): AsyncIterable<ApiSseEvent> {
    const { id, model } = context.protocol as {
      id: string;
      model: string;
    };

    let messageStarted = false;
    let blockIndex = 0;
    let blockOpen = false;
    let blockType: 'text' | 'tool_use' = 'text';

    let lastUsage: { input_tokens: number; output_tokens: number } | null =
      null;

    // Helpers to emit block lifecycle events
    const openTextBlock = (): ApiSseEvent => {
      blockOpen = true;
      blockType = 'text';
      return sse('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      });
    };

    const closeBlock = (): ApiSseEvent => {
      blockOpen = false;
      const evt = sse('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
      return evt;
    };

    const emitMessageStart = (): ApiSseEvent => {
      messageStarted = true;
      return sse('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    };

    for await (const chunk of source) {
      // Error chunk
      if (!chunk.ok) {
        if (!messageStarted) yield emitMessageStart();
        if (blockOpen) yield closeBlock();

        yield sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: lastUsage ?? { input_tokens: 0, output_tokens: 0 },
        });
        yield sse('message_stop', { type: 'message_stop' });
        return;
      }

      const val = chunk.value;

      // Skip heartbeat-only and timing-only chunks
      if (
        !val.content &&
        !val.toolCalls &&
        !val.finishReason &&
        !val.usage &&
        (val.heartbeat || val.timing)
      ) {
        continue;
      }

      // Capture usage
      if (val.usage) {
        lastUsage = {
          input_tokens: val.usage.promptTokens,
          output_tokens: val.usage.completionTokens,
        };
      }

      // Skip chunks that carry only usage
      if (!val.content && !val.toolCalls && !val.finishReason) {
        continue;
      }

      // Ensure message_start is emitted
      if (!messageStarted) yield emitMessageStart();

      // Text content
      if (val.content) {
        if (!blockOpen || blockType !== 'text') {
          if (blockOpen) yield closeBlock();
          yield openTextBlock();
        }
        yield sse('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: val.content },
        });
      }

      // Tool calls
      if (val.toolCalls) {
        // Close text block if open
        if (blockOpen && blockType === 'text') {
          yield closeBlock();
        }

        for (const call of val.toolCalls) {
          const tc = toToolCallDelta(call, 0);

          // Open tool_use block
          blockOpen = true;
          blockType = 'tool_use';
          yield sse('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: tc.id ?? `toolu_${randomUUID()}`,
              name: tc.name ?? '',
            },
          });

          // Emit input_json_delta
          if (tc.arguments) {
            yield sse('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: tc.arguments,
              },
            });
          }

          // Close tool_use block
          yield closeBlock();
        }
      }

      // Finish reason
      if (val.finishReason) {
        if (blockOpen) yield closeBlock();

        yield sse('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: mapStopReason(
              val.finishReason as StopReason | 'error',
            ),
          },
          usage: lastUsage ?? { input_tokens: 0, output_tokens: 0 },
        });
        yield sse('message_stop', { type: 'message_stop' });
        return;
      }
    }

    // Stream ended without finishReason — emit closing events
    if (!messageStarted) yield emitMessageStart();
    if (blockOpen) yield closeBlock();

    yield sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: lastUsage ?? { input_tokens: 0, output_tokens: 0 },
    });
    yield sse('message_stop', { type: 'message_stop' });
  }
}
