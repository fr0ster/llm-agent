/**
 * ToolLoopHandler — streaming LLM call + MCP tool execution loop.
 *
 * This is the "terminal" pipeline stage. It takes over the streaming yield
 * mechanism to push SSE chunks back to the consumer.
 *
 * Reads: `ctx.assembledMessages`, `ctx.activeTools`, `ctx.toolClientMap`,
 *        `ctx.externalTools`, `ctx.mainLlm`
 * Writes: yields chunks via `ctx.yield()`, updates `ctx.timing`
 *
 * ## Config
 *
 * | Field              | Type   | Default     | Description                     |
 * |--------------------|--------|-------------|---------------------------------|
 * | `maxIterations`    | number | from ctx    | Max tool-loop iterations        |
 * | `maxToolCalls`     | number | from ctx    | Max total tool calls per request|
 * | `heartbeatIntervalMs` | number | 5000     | SSE heartbeat interval (ms)     |
 *
 * ## Includes
 *
 * - Output validation (re-prompts on invalid LLM output)
 * - Tool call classification (internal / external / hallucinated / blocked)
 * - Concurrent tool execution with heartbeat
 * - Tool availability tracking (temporary blacklist)
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class ToolLoopHandler implements IStageHandler {
  execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    parentSpan: ISpan,
  ): Promise<boolean>;
}
//# sourceMappingURL=tool-loop.d.ts.map
