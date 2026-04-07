/**
 * RateLimiterLlm — ILlm decorator that throttles outbound requests.
 *
 * Composition order: RateLimiterLlm → RetryLlm → CircuitBreakerLlm → LlmAdapter
 * Rate limiter sits outermost so that retry attempts also respect the limit.
 */

import type { Message } from '../../types.js';
import type { ILlm } from '../interfaces/llm.js';
import type { ILlmRateLimiter } from '../interfaces/rate-limiter.js';
import type {
  CallOptions,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '../interfaces/types.js';

export class RateLimiterLlm implements ILlm {
  constructor(
    private readonly inner: ILlm,
    private readonly limiter: ILlmRateLimiter,
  ) {}

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
