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
import type { ISpan, IStageHandler, PipelineContext } from '@mcp-abap-adt/llm-agent-server';
declare class RateLimiterHandler implements IStageHandler {
    execute(ctx: PipelineContext, config: Record<string, unknown>, span: ISpan): Promise<boolean>;
}
export declare const stageHandlers: {
    'rate-limiter': RateLimiterHandler;
};
export {};
//# sourceMappingURL=04-rate-limiter.d.ts.map