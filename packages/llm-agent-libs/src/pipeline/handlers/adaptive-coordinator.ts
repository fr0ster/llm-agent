import { randomUUID } from 'node:crypto';
import type {
  AdaptiveBudget,
  AdaptivePlan,
  IAdaptiveController,
  IFinalizer,
  IRunRecordStore,
  ISubAgent,
  LlmComponent,
  LlmUsage,
  RunRecord,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import {
  AdaptiveEpicFailError,
  DEFAULT_BUDGET,
  runAdaptivePlan,
} from '../../coordinator/adaptive/adaptive-interpreter.js';
import { fallbackPlan } from '../../coordinator/adaptive/parse-plan.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
import { terminalUsage } from './dag-coordinator.js';

/** Optional dependencies for the adaptive coordinator stage. */
export interface AdaptiveCoordinatorDeps {
  controller: IAdaptiveController;
  workers: Map<string, ISubAgent>;
  finalizer?: IFinalizer;
  runRecords?: IRunRecordStore;
  budget?: Partial<AdaptiveBudget>;
  fallbackWorker?: string;
  /** Workers whose returned usage is logged here instead of by the workers themselves. */
  logWorkerUsage?: ReadonlySet<string>;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Plan and execute one bounded adaptive run through the stepper coordinator slot. */
export class AdaptiveCoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: AdaptiveCoordinatorDeps) {}

  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    _span: ISpan,
  ): Promise<boolean> {
    const request = ctx.inputText;
    const history = [...ctx.history];
    const tail = history.at(-1);
    if (tail?.role === 'user' && tail.content === request) history.pop();
    const { controller, workers, runRecords, finalizer } = this.deps;
    const traceId = ctx.options?.trace?.traceId;
    const log = (key: string, data: Record<string, unknown>) =>
      ctx.options?.sessionLogger?.logStep(key, data);
    const logUsage = (
      usage: LlmUsage | undefined,
      component: LlmComponent,
      model?: string,
    ) => {
      if (usage)
        ctx.requestLogger.logLlmCall({
          component,
          model: model ?? 'unknown',
          ...usage,
          durationMs: 0,
          requestId: traceId,
        });
    };
    try {
      let previousRun: RunRecord | undefined;
      if (runRecords && ctx.sessionId) {
        try {
          previousRun = await runRecords.load(ctx.sessionId);
        } catch (error) {
          log('adaptive_record_load_failed', { message: message(error) });
        }
      }
      let plan: AdaptivePlan;
      try {
        const planned = await controller.plan({
          request,
          history,
          workers: [...workers.values()].map(({ name, description }) => ({
            name,
            description,
          })),
          previousRun,
          signal: ctx.options?.signal,
        });
        plan = planned.plan;
        logUsage(planned.usage, 'planner', controller.model);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        logUsage(
          (error as { usage?: LlmUsage } | null)?.usage,
          'planner',
          controller.model,
        );
        log('adaptive_plan_fallback', { message: message(error) });
        plan = fallbackPlan(request, this.deps.fallbackWorker ?? 'executor');
      }
      if (plan.spec) plan.spec.raw = request;
      log('adaptive_plan', {
        steps: plan.steps.map(({ id, kind }) => ({ id, kind })),
      });
      const forward =
        !finalizer || finalizer.streamsInterpreterContent === true;
      let fatal: AdaptiveEpicFailError | undefined;
      const result = await runAdaptivePlan({
        request,
        history,
        plan,
        workers,
        controller: {
          name: controller.name,
          model: controller.model,
          plan: (input) => controller.plan(input),
          check: async (input) => {
            try {
              const value = await controller.check(input);
              logUsage(value.usage, 'reviewer', controller.model);
              return value;
            } catch (error) {
              logUsage(
                (error as { usage?: LlmUsage } | null)?.usage,
                'reviewer',
                controller.model,
              );
              throw error;
            }
          },
          revise: async (input) => {
            try {
              const value = await controller.revise(input);
              logUsage(value.usage, 'planner', controller.model);
              return value;
            } catch (error) {
              logUsage(
                (error as { usage?: LlmUsage } | null)?.usage,
                'planner',
                controller.model,
              );
              throw error;
            }
          },
          report: async (input) => {
            const value = await controller.report(input);
            logUsage(value.usage, 'finalizer', controller.model);
            return value;
          },
        },
        budget: { ...DEFAULT_BUDGET, ...this.deps.budget },
        sessionId: ctx.sessionId,
        signal: ctx.options?.signal,
        trace: ctx.options?.trace,
        sessionLogger: ctx.options?.sessionLogger,
        externalTools: ctx.externalTools,
        externalResults: ctx.externalResults,
        onStatus: (status) =>
          ctx.yield({ ok: true, value: { content: '', status } }),
        onContent: (delta, ephemeral) => {
          if (forward)
            ctx.yield({
              ok: true,
              value: {
                content: delta,
                ...(ephemeral ? { ephemeral: true } : {}),
              },
            });
        },
      }).catch((error: unknown) => {
        if (!(error instanceof AdaptiveEpicFailError)) throw error;
        fatal = error;
        return error.result;
      });
      // Default to DAG ownership; only explicitly listed workers delegate accounting here.
      for (const entry of result.workerUsage) {
        if (this.deps.logWorkerUsage?.has(entry.worker))
          logUsage(entry.usage, 'executor', entry.model);
      }
      log('adaptive_run', {
        outcome: result.outcome,
        stopReason: result.stopReason,
        records: result.records.length,
      });
      if (runRecords && ctx.sessionId) {
        try {
          await runRecords.save(ctx.sessionId, {
            runId: traceId ?? randomUUID(),
            request,
            plan: result.plan,
            steps: result.records,
            outcome: result.outcome,
            stopReason: result.stopReason,
            finishedAt: Date.now(),
          });
        } catch (error) {
          log('adaptive_record_save_failed', { message: message(error) });
        }
      }
      if (fatal) throw fatal;
      if (result.outcome !== 'awaiting-external')
        ctx.assistantText = result.output;
      if (result.outcome === 'awaiting-external') {
        ctx.yield({
          ok: true,
          value: {
            content: '',
            toolCalls: (result.pendingExternalToolCalls ?? []).map(
              (tc, index) => ({
                index,
                id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              }),
            ),
          },
        });
      } else if (result.outcome === 'answered' && finalizer) {
        const finalized = await finalizer.finalize({
          prompt: request,
          objective: result.plan.spec?.objective ?? request,
          interpreterOutput: result.output,
          ...(finalizer.streamsInterpreterContent
            ? { interpreterContentStreamed: result.answerStreamed }
            : {}),
          executionTrace: result.records.map((record) => {
            const step = result.plan.steps.find((s) => s.id === record.stepId);
            return {
              nodeId: record.stepId,
              goal: step && 'goal' in step ? step.goal : '',
              output: record.output,
            };
          }),
          sessionId: ctx.sessionId,
          signal: ctx.options?.signal,
          trace: ctx.options?.trace,
          onPartial: (chunk) => {
            if (chunk.kind === 'content')
              ctx.yield({
                ok: true,
                value: {
                  content: chunk.delta,
                  ...(chunk.ephemeral ? { ephemeral: true } : {}),
                },
              });
          },
        });
        ctx.assistantText = finalized.output;
        logUsage(finalized.usage, 'finalizer', finalizer.model);
      } else if (result.outcome !== 'answered' || !result.answerStreamed) {
        ctx.yield({ ok: true, value: { content: result.output } });
      }
      const usage = terminalUsage(ctx, traceId);
      ctx.yield({
        ok: true,
        value: {
          content: '',
          finishReason:
            result.outcome === 'awaiting-external' ? 'tool_calls' : 'stop',
          ...(usage ? { usage } : {}),
        },
      });
      return true;
    } catch (error) {
      ctx.error =
        error instanceof OrchestratorError
          ? error
          : new OrchestratorError(
              message(error),
              ctx.options?.signal?.aborted ||
                (error instanceof Error && error.name === 'AbortError')
                ? 'ABORTED'
                : 'COORDINATOR_STEP_FAILED',
            );
      return false;
    }
  }
}
