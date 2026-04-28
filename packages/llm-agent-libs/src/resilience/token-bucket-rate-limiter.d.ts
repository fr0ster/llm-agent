import type { ILlmRateLimiter } from '@mcp-abap-adt/llm-agent';
export interface TokenBucketConfig {
  /** Maximum requests allowed per window. */
  maxRequests: number;
  /** Window duration in milliseconds. Default: 60_000 (1 minute). */
  windowMs?: number;
}
/**
 * Token-bucket rate limiter.
 *
 * Allows up to `maxRequests` in a rolling `windowMs` window.
 * When the bucket is empty, `acquire()` blocks until a slot frees up.
 */
export declare class TokenBucketRateLimiter implements ILlmRateLimiter {
  private readonly maxRequests;
  private readonly windowMs;
  private timestamps;
  constructor(config: TokenBucketConfig);
  acquire(): Promise<void>;
}
//# sourceMappingURL=token-bucket-rate-limiter.d.ts.map
