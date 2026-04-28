/**
 * PipelineExecutor — walks a stage definition tree and dispatches to handlers.
 *
 * The executor is the engine that interprets the structured pipeline YAML.
 * It handles three execution modes:
 *
 * 1. **Sequential** (default) — stages in a list run one after another.
 * 2. **Parallel** — child stages run concurrently via `Promise.all`.
 *    Optional `after` stages run sequentially after all children complete.
 * 3. **Repeat** — child stages run in a loop until a condition or max iterations.
 *
 * ## Condition evaluation
 *
 * Each stage can have a `when` field — a condition expression evaluated
 * against the {@link PipelineContext}. If the condition is falsy, the stage
 * is skipped. See {@link evaluateCondition} for supported expression syntax.
 *
 * ## Error handling
 *
 * If a handler returns `false` or sets `ctx.error`, the executor stops
 * processing and propagates the error back to the caller.
 *
 * ## Tracing
 *
 * Each stage execution is wrapped in a tracer span named `pipeline.<stage.id>`.
 * The span is passed to the handler for sub-span creation.
 */
import type { ISpan, ITracer } from '../tracer/types.js';
import type { PipelineContext } from './context.js';
import type { StageHandlerRegistry } from './handlers/index.js';
import type { StageDefinition } from './types.js';
export declare class PipelineExecutor {
    private readonly handlers;
    private readonly tracer;
    constructor(handlers: StageHandlerRegistry, tracer: ITracer);
    /**
     * Execute a list of stages sequentially.
     *
     * @param stages    - Stage definitions to execute in order.
     * @param ctx       - Mutable pipeline context.
     * @param parentSpan - Parent tracing span.
     * @returns `true` if all stages completed successfully, `false` if aborted.
     */
    executeStages(stages: StageDefinition[], ctx: PipelineContext, parentSpan: ISpan): Promise<boolean>;
    /**
     * Execute child stages in parallel, then run `after` stages sequentially.
     */
    private _executeParallel;
    /**
     * Execute child stages in a loop until condition or max iterations.
     */
    private _executeRepeat;
}
//# sourceMappingURL=executor.d.ts.map