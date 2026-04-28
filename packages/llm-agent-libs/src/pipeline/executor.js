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
import { evaluateCondition } from './condition-evaluator.js';
export class PipelineExecutor {
    handlers;
    tracer;
    constructor(handlers, tracer) {
        this.handlers = handlers;
        this.tracer = tracer;
    }
    /**
     * Execute a list of stages sequentially.
     *
     * @param stages    - Stage definitions to execute in order.
     * @param ctx       - Mutable pipeline context.
     * @param parentSpan - Parent tracing span.
     * @returns `true` if all stages completed successfully, `false` if aborted.
     */
    async executeStages(stages, ctx, parentSpan) {
        for (const stage of stages) {
            if (ctx.error)
                return false;
            if (ctx.options?.signal?.aborted)
                return false;
            // Evaluate `when` condition
            const shouldRun = evaluateCondition(stage.when, ctx);
            if (!shouldRun) {
                ctx.options?.sessionLogger?.logStep(`stage_skipped_${stage.id}`, {
                    reason: stage.when,
                });
                continue;
            }
            const span = this.tracer.startSpan(`pipeline.${stage.id}`, {
                parent: parentSpan,
                attributes: { 'stage.type': stage.type },
            });
            const stageStart = Date.now();
            let ok;
            try {
                if (stage.type === 'parallel') {
                    ok = await this._executeParallel(stage, ctx, span);
                }
                else if (stage.type === 'repeat') {
                    ok = await this._executeRepeat(stage, ctx, span);
                }
                else {
                    const handler = this.handlers.get(stage.type);
                    if (!handler) {
                        throw new Error(`Unknown stage type "${stage.type}" in stage "${stage.id}". ` +
                            `Available types: ${[...this.handlers.keys()].join(', ')}, parallel, repeat`);
                    }
                    ok = await handler.execute(ctx, stage.config ?? {}, span);
                }
            }
            catch (err) {
                span.setStatus('error', String(err));
                span.end();
                ctx.options?.sessionLogger?.logStep(`stage_error_${stage.id}`, {
                    error: String(err),
                });
                return false;
            }
            ctx.timing.push({
                phase: stage.id,
                duration: Date.now() - stageStart,
            });
            span.setStatus(ok ? 'ok' : 'error');
            span.end();
            if (!ok)
                return false;
        }
        return true;
    }
    /**
     * Execute child stages in parallel, then run `after` stages sequentially.
     */
    async _executeParallel(stage, ctx, parentSpan) {
        if (!stage.stages?.length)
            return true;
        const results = await Promise.all(stage.stages.map((child) => this.executeStages([child], ctx, parentSpan)));
        if (results.some((r) => !r))
            return false;
        // Run sequential `after` stages after all parallel children complete
        if (stage.after?.length) {
            return this.executeStages(stage.after, ctx, parentSpan);
        }
        return true;
    }
    /**
     * Execute child stages in a loop until condition or max iterations.
     */
    async _executeRepeat(stage, ctx, parentSpan) {
        const max = stage.maxIterations ?? 10;
        for (let i = 0; i < max; i++) {
            // Check `until` stop condition
            if (stage.until && evaluateCondition(stage.until, ctx)) {
                break;
            }
            if (stage.stages) {
                const ok = await this.executeStages(stage.stages, ctx, parentSpan);
                if (!ok)
                    return false;
            }
        }
        return true;
    }
}
//# sourceMappingURL=executor.js.map