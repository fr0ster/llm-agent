// src/smart-agent/api-adapters/anthropic-adapter.ts
import { randomUUID } from 'node:crypto';
import { AdapterValidationError } from '../interfaces/api-adapter.js';
import { toToolCallDelta } from '../tool-call-deltas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mapStopReason(r) {
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
function sse(event, data) {
  return { event, data: JSON.stringify(data) };
}
// ---------------------------------------------------------------------------
// AnthropicApiAdapter
// ---------------------------------------------------------------------------
export class AnthropicApiAdapter {
  name = 'anthropic';
  // -------------------------------------------------------------------------
  // normalizeRequest
  // -------------------------------------------------------------------------
  normalizeRequest(request) {
    if (typeof request !== 'object' || request === null) {
      throw new AdapterValidationError('Request body must be a JSON object');
    }
    const body = request;
    if (!Array.isArray(body.messages)) {
      throw new AdapterValidationError('messages must be a non-empty array');
    }
    if (body.messages.length === 0) {
      throw new AdapterValidationError('messages must be a non-empty array');
    }
    const messages = [];
    // Extract system field (Anthropic has it separate from messages)
    if (typeof body.system === 'string' && body.system) {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      // system can be an array of content blocks [{type: "text", text: "..."}]
      const systemText = body.system
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (systemText) {
        messages.push({ role: 'system', content: systemText });
      }
    }
    // Convert Anthropic messages to normalized format
    for (const msg of body.messages) {
      const role = msg.role;
      if (role === 'user') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const blocks = msg.content;
          const textParts = [];
          for (const block of blocks) {
            if (block.type === 'text') {
              textParts.push(block.text);
            } else if (block.type === 'tool_result') {
              // tool_result blocks become separate tool messages
              const toolContent =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);
              messages.push({
                role: 'tool',
                content: toolContent,
                tool_call_id: block.tool_use_id,
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
          const blocks = msg.content;
          const textParts = [];
          const toolCalls = [];
          for (const block of blocks) {
            if (block.type === 'text') {
              textParts.push(block.text);
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                },
              });
            }
          }
          const assistantMsg = {
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
    const options = {};
    if (body.temperature !== undefined) options.temperature = body.temperature;
    if (body.max_tokens !== undefined) options.maxTokens = body.max_tokens;
    if (body.top_p !== undefined) options.topP = body.top_p;
    if (Array.isArray(body.stop_sequences)) options.stop = body.stop_sequences;
    if (Array.isArray(body.tools)) options.externalTools = body.tools;
    if (body.model !== undefined) options.model = body.model;
    const id = `msg_${randomUUID()}`;
    const context = {
      adapterName: this.name,
      protocol: {
        id,
        model: body.model ?? 'smart-agent',
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
  formatResult(response, context) {
    const { id, model } = context.protocol;
    const content = [];
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
  formatError(error, _context) {
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
  async *transformStream(source, context) {
    const { id, model } = context.protocol;
    let messageStarted = false;
    let blockIndex = 0;
    let blockOpen = false;
    let blockType = 'text';
    let lastUsage = null;
    // Helpers to emit block lifecycle events
    const openTextBlock = () => {
      blockOpen = true;
      blockType = 'text';
      return sse('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      });
    };
    const closeBlock = () => {
      blockOpen = false;
      const evt = sse('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
      return evt;
    };
    const emitMessageStart = () => {
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
            stop_reason: mapStopReason(val.finishReason),
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
//# sourceMappingURL=anthropic-adapter.js.map
