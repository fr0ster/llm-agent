/**
 * NonStreamingLlm — ILlm decorator that converts streamChat() to chat().
 *
 * When a provider's streaming is unreliable, wrap it with this adapter.
 * chat() works as-is. streamChat() calls chat() and yields the result
 * as a single chunk.
 */

import type { Message } from '../../types.js';
import type { ILlm } from '../interfaces/llm.js';
import type {
  CallOptions,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '../interfaces/types.js';

export class NonStreamingLlm implements ILlm {
  constructor(private readonly inner: ILlm) {}

  get model(): string | undefined {
    return this.inner.model;
  }

  chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    return this.inner.chat(messages, tools, options);
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    const result = await this.inner.chat(messages, tools, options);
    if (!result.ok) {
      yield result;
      return;
    }
    yield {
      ok: true,
      value: {
        content: result.value.content,
        finishReason: result.value.finishReason,
        toolCalls: result.value.toolCalls,
        usage: result.value.usage,
      },
    };
  }
}
