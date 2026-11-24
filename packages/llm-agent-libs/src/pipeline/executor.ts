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

import {
  McpError,
  OrchestratorError,
  type SmartAgentError,
  terminalRunError,
  toRunError,
} from '@mcp-abap-adt/llm-agent';
import { normalizeMaxIterations } from '../config/normalize-max-iterations.js';
import type { ISpan, ITracer } from '../tracer/types.js';
import { runInterruption } from '../utils/with-abort.js';
import { evaluateCondition } from './condition-evaluator.js';
import type { PipelineContext } from './context.js';
import type { StageHandlerRegistry } from './handlers/index.js';
import type { StageDefinition } from './types.js';

export class PipelineExecutor {
  constructor(
    private readonly handlers: StageHandlerRegistry,
    private readonly tracer: ITracer,
  ) {}

  /**
   * Execute a list of stages sequentially.
   *
   * @param stages    - Stage definitions to execute in order.
   * @param ctx       - Mutable pipeline context.
   * @param parentSpan - Parent tracing span.
   * @returns `true` on success, `false` with `ctx.error` on failure.
   */
  async executeStages(
    stages: StageDefinition[],
    ctx: PipelineContext,
    parentSpan: ISpan,
  ): Promise<boolean> {
    for (const stage of stages) {
      if (ctx.error) return false;
      const signal = ctx.options?.signal;
      if (signal?.aborted) {
        ctx.error = runInterruption(signal);
        return false;
      }

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

      let ok: boolean;
      try {
        if (stage.type === 'parallel') {
          ok = await this._executeParallel(stage, ctx, span);
        } else if (stage.type === 'repeat') {
          ok = await this._executeRepeat(stage, ctx, span);
        } else {
          const handler = this.handlers.get(stage.type);
          if (!handler) {
            throw new Error(
              `Unknown stage type "${stage.type}" in stage "${stage.id}". ` +
                `Available types: ${[...this.handlers.keys()].join(', ')}, parallel, repeat`,
            );
          }
          ok = await handler.execute(ctx, stage.config ?? {}, span);
        }
      } catch (err) {
        span.setStatus('error', String(err));
        span.end();
        const priorityError = runInterruption(signal, [err, ctx.error]);
        const reported =
          priorityError ??
          terminalRunError(err) ??
          (err instanceof McpError ? err : undefined);
        ctx.error =
          priorityError ??
          ctx.error ??
          reported ??
          toRunError(err, 'PIPELINE_STAGE_FAILED');
        if (reported) ctx.yield({ ok: false, error: reported });
        ctx.options?.sessionLogger?.logStep(`stage_error_${stage.id}`, {
          error: String(err),
        });
        return false;
      }

      ctx.timing.push({
        phase: stage.id,
        duration: Date.now() - stageStart,
      });
      if (!ok) {
        if (signal?.aborted) {
          ctx.error = runInterruption(signal, [ctx.error]);
        } else {
          ctx.error ??= new OrchestratorError(
            `Pipeline stage "${stage.id}" failed.`,
            'PIPELINE_STAGE_FAILED',
          );
        }
      }
      span.setStatus(ctx.error ? 'error' : 'ok');
      span.end();

      if (ctx.error) return false;
    }
    return true;
  }

  /**
   * Execute child stages in parallel, then run `after` stages sequentially.
   */
  private async _executeParallel(
    stage: StageDefinition,
    ctx: PipelineContext,
    parentSpan: ISpan,
  ): Promise<boolean> {
    if (!stage.stages?.length) return true;

    const children = stage.stages;
    const signal = ctx.options?.signal;
    const results = await new Promise<boolean[]>((resolve, reject) => {
      let overflow: SmartAgentError | undefined;
      // Let the enclosing stage report the overflow once, even for a nested parallel stage.
      const stop = (failure: SmartAgentError) => {
        if (!overflow) {
          overflow = failure;
          reject(failure);
        }
      };
      const yieldChunk: PipelineContext['yield'] = (chunk) => {
        if (!chunk.ok) {
          const failure = runInterruption(signal, [chunk.error]);
          if (failure?.code === 'ABORTED' && signal?.aborted) return;
          if (failure && failure.code !== 'ABORTED') stop(failure);
        }
        if (!overflow) ctx.yield(chunk);
      };
      const parallelCtx = new Proxy(ctx, {
        get(target, key, receiver) {
          return key === 'yield'
            ? yieldChunk
            : Reflect.get(target, key, receiver);
        },
        set(target, key, value, receiver) {
          if (key === 'error') {
            const failure = runInterruption(signal, [value]);
            if (failure && failure.code !== 'ABORTED') stop(failure);
            if (overflow) return Reflect.set(target, key, overflow, receiver);
            if (target.error) return true;
          }
          return Reflect.set(target, key, value, receiver);
        },
      });
      void Promise.all(
        children.map((child) =>
          this.executeStages([child], parallelCtx, parentSpan),
        ),
      ).then(resolve, reject);
    });
    if (results.some((r) => !r)) return false;

    // Run sequential `after` stages after all parallel children complete
    if (stage.after?.length) {
      return this.executeStages(stage.after, ctx, parentSpan);
    }
    return true;
  }

  /**
   * Execute child stages in a loop until condition or max iterations.
   */
  private async _executeRepeat(
    stage: StageDefinition,
    ctx: PipelineContext,
    parentSpan: ISpan,
  ): Promise<boolean> {
    const max = normalizeMaxIterations(stage.maxIterations);
    if (!stage.stages?.length) return true;
    for (let i = 0; max === undefined || i < max; i++) {
      if (ctx.error || ctx.options?.signal?.aborted) return false;
      // Check `until` stop condition
      if (stage.until && evaluateCondition(stage.until, ctx)) {
        break;
      }
      if (stage.stages) {
        const ok = await this.executeStages(stage.stages, ctx, parentSpan);
        if (!ok) return false;
      }
    }
    return true;
  }
}
