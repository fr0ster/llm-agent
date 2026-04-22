/**
 * Rate limiter interface for throttling outbound LLM requests.
 * Implementations block until a request slot is available.
 */
export interface ILlmRateLimiter {
  /** Block until a request slot is available. */
  acquire(): Promise<void>;
}
