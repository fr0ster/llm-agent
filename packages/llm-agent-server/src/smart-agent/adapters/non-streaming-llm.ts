/**
 * NonStreamingLlm — ILlm decorator that converts streamChat() to chat().
 *
 * When a provider's streaming is unreliable, wrap it with this adapter.
 * chat() works as-is. streamChat() calls chat() and yields the result
 * as a single chunk.
 */

import type {
  CallOptions,
  ILlm,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';

export class NonStreamingLlm implements ILlm {
  healthCheck?: ILlm['healthCheck'];
  getModels?: ILlm['getModels'];

  constructor(private readonly inner: ILlm) {
    if (inner.healthCheck) {
      this.healthCheck = inner.healthCheck.bind(inner);
    }
    if (inner.getModels) {
      this.getModels = inner.getModels.bind(inner);
    }
  }

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
