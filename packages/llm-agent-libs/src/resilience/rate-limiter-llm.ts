/**
 * RateLimiterLlm — ILlm decorator that throttles outbound requests.
 *
 * Composition order: RateLimiterLlm → CircuitBreakerLlm → RetryLlm → LlmAdapter
 * Rate limiter sits outermost: it takes one permit per outer call, so retry
 * attempts below it are not counted against the window.
 */

import type {
  CallOptions,
  ILlm,
  ILlmRateLimiter,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';

export class RateLimiterLlm implements ILlm {
  healthCheck?: ILlm['healthCheck'];

  constructor(
    private readonly inner: ILlm,
    private readonly limiter: ILlmRateLimiter,
  ) {
    if (inner.healthCheck) {
      this.healthCheck = inner.healthCheck.bind(inner);
    }
  }

  get model(): string | undefined {
    return this.inner.model;
  }

  async chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    await this.limiter.acquire();
    return this.inner.chat(messages, tools, options);
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    await this.limiter.acquire();
    yield* this.inner.streamChat(messages, tools, options);
  }
}
