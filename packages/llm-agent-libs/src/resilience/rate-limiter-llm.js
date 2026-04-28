/**
 * RateLimiterLlm — ILlm decorator that throttles outbound requests.
 *
 * Composition order: RateLimiterLlm → RetryLlm → CircuitBreakerLlm → LlmAdapter
 * Rate limiter sits outermost so that retry attempts also respect the limit.
 */
export class RateLimiterLlm {
  inner;
  limiter;
  healthCheck;
  constructor(inner, limiter) {
    this.inner = inner;
    this.limiter = limiter;
    if (inner.healthCheck) {
      this.healthCheck = inner.healthCheck.bind(inner);
    }
  }
  get model() {
    return this.inner.model;
  }
  async chat(messages, tools, options) {
    await this.limiter.acquire();
    return this.inner.chat(messages, tools, options);
  }
  async *streamChat(messages, tools, options) {
    await this.limiter.acquire();
    yield* this.inner.streamChat(messages, tools, options);
  }
}
//# sourceMappingURL=rate-limiter-llm.js.map
