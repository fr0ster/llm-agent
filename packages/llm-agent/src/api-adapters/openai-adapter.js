// src/smart-agent/api-adapters/openai-adapter.ts
import { randomUUID } from 'node:crypto';
import { AdapterValidationError } from '../interfaces/api-adapter.js';
import { toToolCallDelta } from '../tool-call-deltas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mapStopReason(r) {
  switch (r) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'error':
      return 'stop';
    default:
      return 'length';
  }
}
// ---------------------------------------------------------------------------
// OpenAiApiAdapter
// ---------------------------------------------------------------------------
export class OpenAiApiAdapter {
  name = 'openai';
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
    const messages = body.messages;
    if (messages.length === 0) {
      throw new AdapterValidationError('messages must be a non-empty array');
    }
    const options = {};
    if (body.temperature !== undefined) options.temperature = body.temperature;
    if (body.max_tokens !== undefined) options.maxTokens = body.max_tokens;
    if (body.top_p !== undefined) options.topP = body.top_p;
    if (Array.isArray(body.tools)) options.externalTools = body.tools;
    if (body.model !== undefined) options.model = body.model;
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const context = {
      adapterName: this.name,
      protocol: {
        id,
        created,
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
    const { id, created, model } = context.protocol;
    const message = {
      role: 'assistant',
      content: response.content,
    };
    if (response.toolCalls) {
      message.tool_calls = response.toolCalls;
      if (!message.content) message.content = null;
    }
    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: mapStopReason(response.stopReason),
        },
      ],
      usage: {
        prompt_tokens: response.usage?.promptTokens ?? 0,
        completion_tokens: response.usage?.completionTokens ?? 0,
        total_tokens: response.usage?.totalTokens ?? 0,
      },
    };
  }
  // -------------------------------------------------------------------------
  // formatError
  // -------------------------------------------------------------------------
  formatError(error, _context) {
    return {
      error: {
        message: error.message,
        type: 'server_error',
        code: error.code,
      },
    };
  }
  // -------------------------------------------------------------------------
  // transformStream
  // -------------------------------------------------------------------------
  async *transformStream(source, context) {
    const { id, created, model } = context.protocol;
    const baseResponse = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      usage: null,
    };
    let firstChunk = true;
    let finishReasonSent = false;
    let lastUsage = null;
    for await (const chunk of source) {
      // Error chunk
      if (!chunk.ok) {
        const errorPayload = {
          ...baseResponse,
          choices: [
            {
              index: 0,
              delta: { content: `[Error] ${chunk.error.message}` },
              finish_reason: 'stop',
            },
          ],
        };
        yield { data: JSON.stringify(errorPayload) };
        finishReasonSent = true;
        break;
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
      // Capture usage for final emission
      if (val.usage) {
        lastUsage = {
          prompt_tokens: val.usage.promptTokens,
          completion_tokens: val.usage.completionTokens,
          total_tokens: val.usage.totalTokens,
        };
      }
      // Skip chunks that carry only usage (no content, no tool_calls, no finishReason)
      if (!val.content && !val.toolCalls && !val.finishReason) {
        continue;
      }
      // First chunk includes role: 'assistant'
      if (firstChunk) {
        const firstDelta = {
          role: 'assistant',
          content: val.content || '',
        };
        if (val.toolCalls) {
          firstDelta.tool_calls = val.toolCalls.map((call, index) => {
            const tc = toToolCallDelta(call, index);
            return {
              index: tc.index,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: tc.arguments || '',
              },
            };
          });
        }
        yield {
          data: JSON.stringify({
            ...baseResponse,
            choices: [
              {
                index: 0,
                delta: firstDelta,
                finish_reason: null,
              },
            ],
          }),
        };
        firstChunk = false;
        if (!val.finishReason) continue;
      }
      // Regular content / tool call delta
      if ((val.content || val.toolCalls) && !firstChunk) {
        const delta = {};
        if (val.content) delta.content = val.content;
        if (val.toolCalls) {
          delta.tool_calls = val.toolCalls.map((call, index) => {
            const tc = toToolCallDelta(call, index);
            return {
              index: tc.index,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: tc.arguments || '',
              },
            };
          });
        }
        yield {
          data: JSON.stringify({
            ...baseResponse,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: null,
              },
            ],
          }),
        };
      }
      // Finish reason in separate chunk
      if (val.finishReason) {
        yield {
          data: JSON.stringify({
            ...baseResponse,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: mapStopReason(val.finishReason),
              },
            ],
          }),
        };
        finishReasonSent = true;
      }
    }
    // Default finish reason if none was sent
    if (!finishReasonSent) {
      yield {
        data: JSON.stringify({
          ...baseResponse,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
      };
    }
    // Usage chunk
    if (lastUsage) {
      yield {
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: lastUsage,
        }),
      };
    }
    // Terminal sentinel
    yield { data: '[DONE]' };
  }
}
//# sourceMappingURL=openai-adapter.js.map
