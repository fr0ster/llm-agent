import { randomUUID } from 'node:crypto';
import type {
  AdaptiveBudget,
  AdaptivePlan,
  IAdaptiveController,
  IFinalizer,
  IRunRecordStore,
  ISubAgent,
  LlmComponent,
  LlmUsageAttribution,
  RunRecord,
} from '@mcp-abap-adt/llm-agent';
import {
  contextExceededError,
  embeddingContextExceededError,
  toRunError,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import {
  DEFAULT_BUDGET,
  runAdaptivePlan,
} from '../../coordinator/adaptive/adaptive-interpreter.js';
import { withUsageCalls } from '../../logger/llm-call-usage.js';
import {
  callerIdentityKey,
  resolveCallerIdentity,
} from '../../policy/caller-identity.js';
import type { ISpan } from '../../tracer/types.js';
import { isAbortReason } from '../../utils/with-abort.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
import { terminalUsage } from './dag-coordinator.js';
import { logRoleUsage } from './role-usage.js';
import { meterWorkers } from './worker-usage.js';

/** Optional dependencies for the adaptive coordinator stage. */
export interface AdaptiveCoordinatorDeps {
  controller: IAdaptiveController;
  workers: Map<string, ISubAgent>;
  finalizer?: IFinalizer;
  runRecords?: IRunRecordStore;
  budget?: Partial<AdaptiveBudget>;
  /** @deprecated Planner failures always propagate. */
  fallbackWorker?: string;
  /** Optional allowlist for legacy workers that return usage without call ids. */
  logWorkerUsage?: ReadonlySet<string>;
}
/** Plan and execute one adaptive run through the stepper coordinator slot. */
export class AdaptiveCoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: AdaptiveCoordinatorDeps) {}

  async execute(
    ctx: PipelineContext,
    _config: Parameters<IStageHandler['execute']>[1],
    _span: ISpan,
  ): Promise<boolean> {
    const identity =
      ctx.callerResolution ?? resolveCallerIdentity(ctx.options, ctx.sessionId);
    if (identity.kind !== 'caller') {
      ctx.error = new OrchestratorError(
        'Trusted caller is required',
        'RAG_ACCESS_DENIED',
      );
      return false;
    }
    const { caller } = identity;
    const recordKey = callerIdentityKey(caller);
    const request = ctx.inputText;
    const history = [...ctx.history];
    const tail = history.at(-1);
    if (tail?.role === 'user' && tail.content === request) history.pop();
    const { controller, workers, runRecords, finalizer } = this.deps;
    const traceId = ctx.options?.trace?.traceId;
    const log = (key: string, data: object) =>
      ctx.options?.sessionLogger?.logStep(key, data);
    const runRole = async <T extends LlmUsageAttribution>(
      component: LlmComponent,
      run: () => Promise<T>,
      role: { readonly model?: string } = controller,
    ): Promise<T> => {
      try {
        const value = await run();
        logRoleUsage(ctx, component, value, role.model);
        return value;
      } catch (error) {
        const failed = error as LlmUsageAttribution | null;
        throw withUsageCalls(
          error,
          logRoleUsage(ctx, component, failed, role.model),
        );
      }
    };
    try {
      let previousRun: RunRecord | undefined;
      if (runRecords && recordKey !== undefined) {
        try {
          previousRun = await runRecords.load(recordKey);
        } catch (error) {
          throw toRunError(error, 'COORDINATOR_RECORD_LOAD_FAILED');
        }
      }
      let plan: AdaptivePlan;
      try {
        const planned = await runRole('planner', () =>
          controller.plan({
            request,
            history,
            workers: [...workers.values()].map(({ name, description }) => ({
              name,
              description,
            })),
            previousRun,
            usage: ctx.options?.usage,
            signal: ctx.options?.signal,
          }),
        );
        plan = planned.plan;
      } catch (error) {
        if (
          !contextExceededError(error) &&
          !embeddingContextExceededError(error)
        )
          ctx.options?.signal?.throwIfAborted();
        throw toRunError(error, 'COORDINATOR_PLAN_FAILED');
      }
      if (plan.spec) plan.spec.raw = request;
      log('adaptive_plan', {
        steps: plan.steps.map(({ id, kind }) => ({ id, kind })),
      });
      const forward =
        !finalizer || finalizer.streamsInterpreterContent === true;
      const result = await runAdaptivePlan({
        request,
        history,
        plan,
        workers: meterWorkers(workers, ctx, this.deps.logWorkerUsage),
        controller: {
          name: controller.name,
          model: controller.model,
          plan: (input) => controller.plan(input),
          check: (input) => runRole('reviewer', () => controller.check(input)),
          revise: (input) => runRole('planner', () => controller.revise(input)),
          report: (input) =>
            runRole('finalizer', () => controller.report(input)),
        },
        budget: { ...DEFAULT_BUDGET, ...this.deps.budget },
        caller: caller,
        sessionId: ctx.sessionId,
        usage: ctx.options?.usage,
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
      });
      log('adaptive_run', {
        outcome: result.outcome,
        stopReason: result.stopReason,
        records: result.records.length,
      });
      if (runRecords && recordKey !== undefined) {
        try {
          await runRecords.save(recordKey, {
            runId: traceId ?? randomUUID(),
            request,
            plan: result.plan,
            steps: result.records,
            outcome: result.outcome,
            stopReason: result.stopReason,
            finishedAt: Date.now(),
          });
        } catch (error) {
          const failure = toRunError(error, 'COORDINATOR_RECORD_SAVE_FAILED');
          if (!result.error) throw failure;
          log('adaptive_record_save_failed', { message: failure.message });
        }
      }
      if (result.error) {
        ctx.error = result.error;
        if (!isAbortReason(result.error, ctx.options?.signal))
          ctx.yield({ ok: false, error: result.error });
        return false;
      }
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
        const finalized = await runRole(
          'finalizer',
          () =>
            finalizer.finalize({
              caller,
              prompt: request,
              objective: result.plan.spec?.objective ?? request,
              interpreterOutput: result.output,
              ...(finalizer.streamsInterpreterContent
                ? { interpreterContentStreamed: result.answerStreamed }
                : {}),
              executionTrace: result.records.map((record) => {
                const step = result.plan.steps.find(
                  (s) => s.id === record.stepId,
                );
                return {
                  nodeId: record.stepId,
                  goal: step && 'goal' in step ? step.goal : '',
                  output: record.output,
                };
              }),
              sessionId: ctx.sessionId,
              usage: ctx.options?.usage,
              signal: ctx.options?.signal,
              trace: ctx.options?.trace,
              onPartial: (chunk) => {
                if (chunk.kind === 'iteration-end' && chunk.outcome === 'retry')
                  ctx.yield({
                    ok: true,
                    value: { content: '', iterationEnd: 'retry' },
                  });
                if (chunk.kind === 'content')
                  ctx.yield({
                    ok: true,
                    value: {
                      content: chunk.delta,
                      ...(chunk.ephemeral ? { ephemeral: true } : {}),
                    },
                  });
              },
            }),
          finalizer,
        );
        ctx.assistantText = finalized.output;
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
      ctx.error = toRunError(
        error,
        ctx.options?.signal?.aborted ? 'ABORTED' : 'COORDINATOR_STEP_FAILED',
      );
      return false;
    }
  }
}
