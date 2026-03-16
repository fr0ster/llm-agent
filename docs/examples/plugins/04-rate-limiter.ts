/**
 * Plugin: rate-limiter — limits requests per session with a sliding window.
 *
 * Registers a custom stage handler that tracks request counts per session
 * and aborts the pipeline when the limit is exceeded.
 *
 * Usage in YAML:
 *   stages:
 *     - id: rate-limit
 *       type: rate-limiter
 *       config:
 *         maxRequests: 100       # max requests per window (default: 100)
 *         windowMs: 3600000      # window size in ms (default: 1 hour)
 *     - id: classify
 *       type: classify
 *     # ...
 *
 * Drop this file into your plugin directory.
 */

import type {
  ISpan,
  IStageHandler,
  PipelineContext,
} from '@mcp-abap-adt/llm-agent';

/** Sliding window entry: timestamp of each request */
const sessionWindows = new Map<string, number[]>();

class RateLimiterHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const maxRequests = (config.maxRequests as number) ?? 100;
    const windowMs = (config.windowMs as number) ?? 3_600_000; // 1 hour
    const now = Date.now();
    const cutoff = now - windowMs;

    // Get or create window for this session
    let timestamps = sessionWindows.get(ctx.sessionId) ?? [];

    // Remove expired entries
    timestamps = timestamps.filter((t) => t > cutoff);

    if (timestamps.length >= maxRequests) {
      span.setAttribute('rate_limited', true);
      span.setAttribute('request_count', timestamps.length);

      ctx.error = {
        ok: false,
        error: {
          message: `Rate limit exceeded: ${timestamps.length}/${maxRequests} requests in the last ${windowMs / 1000}s. Please try again later.`,
          code: 'RATE_LIMIT_EXCEEDED',
        },
      };
      return false; // abort pipeline
    }

    // Record this request
    timestamps.push(now);
    sessionWindows.set(ctx.sessionId, timestamps);

    span.setAttribute('rate_limited', false);
    span.setAttribute('request_count', timestamps.length);
    span.setAttribute('remaining', maxRequests - timestamps.length);

    return true;
  }
}

// Plugin export
export const stageHandlers = {
  'rate-limiter': new RateLimiterHandler(),
};
