import type {
  AdaptiveBudget,
  AdaptivePlan,
  EpicFailTrace,
  IAdaptiveController,
  ISubAgent,
  ISubAgentInput,
  LlmToolCall,
  LlmUsage,
  Message,
  OnPartial,
  RunOutcome,
  SmartAgentError,
  StepRecord,
  StepStatus,
} from '@mcp-abap-adt/llm-agent';
import {
  copyErrorUsage,
  httpStatusOf,
  toRunError,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import { errorUsage } from '../../logger/llm-call-usage.js';
import { runInterruption } from '../../utils/with-abort.js';
import { composeStepInput } from './compose-step-input.js';
import { parseVerdict, validateSteps } from './parse-plan.js';

/** Dependencies and request context for one sequential adaptive run. */
export interface AdaptiveRunInput {
  caller: ISubAgentInput['caller'];
  request: string;
  history: Message[];
  plan: AdaptivePlan;
  workers: ReadonlyMap<string, ISubAgent>;
  controller: IAdaptiveController;
  budget: AdaptiveBudget;
  sessionId?: string;
  usage?: ISubAgentInput['usage'];
  signal?: AbortSignal;
  trace?: { traceId: string };
  sessionLogger?: ISubAgentInput['sessionLogger'];
  externalTools?: ISubAgentInput['externalTools'];
  externalResults?: ISubAgentInput['externalResults'];
  onStatus?: (s: StepStatus) => void;
  onContent?: (delta: string, ephemeral: boolean) => void;
  now?: () => number;
}

/** Terminal result, including every executed step and returned token usage. */
export interface AdaptiveRunResult {
  outcome: RunOutcome;
  output: string;
  plan: AdaptivePlan;
  records: StepRecord[];
  stopReason?: string;
  error?: SmartAgentError & { readonly stepId?: string };
  answerStreamed: boolean;
  usage: LlmUsage[];
  workerUsage: { worker: string; usage: LlmUsage; model?: string }[];
  pendingExternalToolCalls?: LlmToolCall[];
}

/** Fatal worker failure with the stopped run available for accounting and persistence. */
export class AdaptiveEpicFailError extends OrchestratorError {
  constructor(
    readonly result: AdaptiveRunResult,
    readonly epicFailTrace?: EpicFailTrace,
    readonly stepId?: string,
    error?: SmartAgentError,
    signal?: AbortSignal,
  ) {
    const interruption = runInterruption(signal, [error]);
    const failure =
      interruption ?? (error && toRunError(error, 'COORDINATOR_STEP_FAILED'));
    super(
      failure?.message ?? result.stopReason ?? 'epicfail',
      failure?.code ?? 'COORDINATOR_STEP_FAILED',
      {
        cause: failure?.code === 'ABORTED' ? failure : error,
        status: failure?.status ?? error?.status,
      },
    );
    Object.assign(this, copyErrorUsage({}, error, failure));
  }
}

/** No run-wide limits unless configured. */
export const DEFAULT_BUDGET: AdaptiveBudget = {
  maxSteps: Infinity,
  maxRevisions: Infinity,
};

/** Execute a plan until it answers, asks, awaits tools, or needs a stop report. */
export async function runAdaptivePlan(
  input: AdaptiveRunInput,
): Promise<AdaptiveRunResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  // Compared with elapsed time, not a Node timer: any positive finite value
  // is a valid budget; anything else means no budget.
  const requestedDurationMs = input.budget.maxDurationMs;
  const maxDurationMs =
    requestedDurationMs !== undefined &&
    Number.isFinite(requestedDurationMs) &&
    requestedDurationMs > 0
      ? requestedDurationMs
      : undefined;
  const plan: AdaptivePlan = { ...input.plan, steps: [...input.plan.steps] };
  const records: StepRecord[] = [];
  const latest = new Map<string, StepRecord>();
  const runs = new Map<string, number>();
  const streamed = new Map<string, string>();
  const usage: LlmUsage[] = [];
  const workerUsage: AdaptiveRunResult['workerUsage'] = [];
  let cursor = 0;
  let revisions = 0;
  let checkReason: { checkId: string; reason: string } | undefined;

  const collect = (value?: LlmUsage) => {
    if (value) usage.push(value);
  };
  const result = (
    outcome: RunOutcome,
    output: string,
    answerStreamed = false,
  ): AdaptiveRunResult => ({
    outcome,
    output,
    plan,
    records,
    answerStreamed,
    usage,
    workerUsage,
  });
  const failedRun = (
    error: NonNullable<AdaptiveRunResult['error']>,
  ): AdaptiveRunResult => ({
    ...result('stopped', error.message),
    stopReason: error.message,
    error,
  });
  const stop = async (stopReason: string): Promise<AdaptiveRunResult> => {
    try {
      const report = await input.controller.report({
        request: input.request,
        plan,
        records,
        stopReason,
        usage: input.usage,
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      collect(report.usage);
      return { ...result('stopped', report.text), stopReason };
    } catch (error) {
      const failure =
        runInterruption(input.signal, [error], 'throw-signal-abort') ??
        toRunError(error, 'COORDINATOR_REPORT_FAILED');
      collect(errorUsage(error).usage);
      return failedRun(failure);
    }
  };

  while (cursor < plan.steps.length) {
    input.signal?.throwIfAborted();
    if (records.length >= input.budget.maxSteps) return stop('budget: steps');
    if (maxDurationMs !== undefined && now() - startedAt >= maxDurationMs)
      return stop('budget: time');
    const step = plan.steps[cursor];
    if (!step) break;
    const run = (runs.get(step.id) ?? 0) + 1;
    runs.set(step.id, run);
    if ('maxRuns' in step && step.maxRuns !== undefined && run > step.maxRuns)
      return stop(`step ${step.id} exceeded ${step.maxRuns} runs`);
    const reason = checkReason;
    checkReason = undefined;
    const stepStartedAt = now();
    const goal = 'goal' in step ? step.goal : undefined;
    input.onStatus?.({
      stepId: step.id,
      kind: step.kind,
      state: 'started',
      ...(goal === undefined ? {} : { goal }),
    });
    const record: StepRecord = {
      stepId: step.id,
      kind: step.kind,
      run,
      status: 'done',
      output: '',
      durationMs: 0,
    };
    const finish = () => {
      record.durationMs = now() - stepStartedAt;
      records.push(record);
      latest.set(step.id, record);
      input.onStatus?.({
        stepId: step.id,
        kind: step.kind,
        state: record.status,
        ...(goal === undefined ? {} : { goal }),
        ...(record.verdict ? { verdict: record.verdict.verdict } : {}),
      });
    };

    const failStep = <T>(error: T, fallbackCode: string): AdaptiveRunResult => {
      const failure =
        runInterruption(input.signal, [error], 'throw-signal-abort') ??
        toRunError(error, fallbackCode);
      record.status = 'failed';
      record.output = '';
      record.error = failure.message;
      finish();
      return failedRun(
        copyErrorUsage(
          Object.assign(
            new OrchestratorError(failure.message, failure.code, {
              cause: failure.code === 'ABORTED' ? failure : error,
              status:
                httpStatusOf(failure) ??
                (typeof error === 'object' && error !== null
                  ? httpStatusOf(error)
                  : undefined),
            }),
            { stepId: step.id },
          ),
          error,
          failure,
        ),
      );
    };

    if (step.kind === 'work' || step.kind === 'check') {
      // The composer uses map insertion order: retain current plan order even after jumps.
      const orderedLatest = new Map(
        plan.steps.flatMap((candidate) => {
          const previous = latest.get(candidate.id);
          return previous ? [[candidate.id, previous] as const] : [];
        }),
      );
      if (step.kind === 'check' && step.worker === 'self') {
        try {
          const checked = await input.controller.check({
            request: input.request,
            spec: step.context?.spec === false ? undefined : plan.spec,
            ...composeStepInput({
              request: input.request,
              spec: plan.spec,
              step,
              latest: orderedLatest,
              history: input.history,
              checkReason: reason,
            }),
            step,
            targets: step.targets.flatMap((id) => {
              const target = latest.get(id);
              return target ? [target] : [];
            }),
            usage: input.usage,
            signal: input.signal,
          });
          collect(checked.usage);
          record.verdict = checked.verdict;
          record.output = JSON.stringify(checked.verdict);
        } catch (error) {
          collect(errorUsage(error).usage);
          return failStep(error, 'COORDINATOR_CHECK_FAILED');
        }
      } else {
        const source = plan.steps.find(
          (candidate) =>
            candidate.kind === 'answer' && candidate.from === step.id,
        );
        const onPartial: OnPartial | undefined =
          source && run === 1 && input.onContent
            ? (chunk) => {
                if (chunk.kind !== 'content' || !chunk.delta) return;
                input.onContent?.(chunk.delta, chunk.ephemeral === true);
                if (chunk.ephemeral !== true)
                  streamed.set(
                    step.id,
                    (streamed.get(step.id) ?? '') + chunk.delta,
                  );
              }
            : undefined;
        let reportedUsage: LlmUsage | undefined;
        try {
          const worker = input.workers.get(step.worker);
          if (!worker) throw new Error(`unknown worker ${step.worker}`);
          const worked = await worker.run({
            caller: input.caller,
            ...composeStepInput({
              request: input.request,
              spec: plan.spec,
              step,
              latest: orderedLatest,
              history: input.history,
              checkReason: reason,
            }),
            sessionId: input.sessionId,
            usage: input.usage,
            signal: input.signal,
            trace: input.trace,
            sessionLogger: input.sessionLogger,
            externalTools: input.externalTools,
            externalResults: input.externalResults,
            onPartial,
          });
          const failed = errorUsage(worked.error);
          reportedUsage = worked.usage ?? failed.usage;
          collect(reportedUsage);
          if (reportedUsage)
            workerUsage.push({
              worker: step.worker,
              usage: reportedUsage,
              model: worked.usage
                ? (worked.model ??
                  (typeof worked.metadata?.model === 'string'
                    ? worked.metadata.model
                    : worker.model))
                : failed.model,
            });
          if (worked.errorClass === 'epicfail') {
            const failure = new AdaptiveEpicFailError(
              {
                ...result('stopped', ''),
                stopReason: `step ${step.id} epicfail`,
              },
              worked.epicFailTrace,
              step.id,
              worked.error,
              input.signal,
            );
            record.status = 'failed';
            record.error = worked.error ? failure.message : 'epicfail';
            finish();
            return failedRun(failure);
          }
          if (worked.error) throw worked.error;
          record.output = worked.output;
          if (worked.status === 'awaiting-external') {
            finish();
            return {
              ...result('awaiting-external', worked.output),
              pendingExternalToolCalls: worked.pendingExternalToolCalls,
            };
          }
          if (step.kind === 'check') {
            record.verdict = parseVerdict(worked.output);
            if (!record.verdict)
              throw new OrchestratorError(
                `Check ${step.id} failed to retrieve a verdict: unparsable verdict`,
                'VERDICT_RETRIEVAL_FAILED',
              );
          } else if (!worked.output.trim()) {
            throw new OrchestratorError(
              'Worker returned an empty terminal response.',
              'EMPTY_WORKER_OUTPUT',
            );
          }
        } catch (error) {
          const failed = errorUsage(error);
          if (!reportedUsage && failed.usage) {
            collect(failed.usage);
            workerUsage.push({
              worker: step.worker,
              usage: failed.usage,
              model: failed.model,
            });
          }
          return failStep(
            error,
            step.kind === 'check'
              ? 'COORDINATOR_CHECK_FAILED'
              : 'COORDINATOR_STEP_FAILED',
          );
        }
      }
      finish();
      if (step.kind === 'check' && record.verdict) {
        const verdict = record.verdict;
        const branch =
          verdict.verdict === 'pass'
            ? step.onPass
            : verdict.verdict === 'partial'
              ? (step.onPartial ?? step.onFail)
              : step.onFail;
        checkReason = { checkId: step.id, reason: verdict.reason };
        cursor =
          branch === 'next'
            ? cursor + 1
            : branch === 'end'
              ? plan.steps.length
              : plan.steps.findIndex((candidate) => candidate.id === branch);
        if (cursor < 0) return stop(`unknown branch ${branch}`);
        continue;
      }
    } else if (step.kind === 'ask') {
      record.output = step.question;
      finish();
      return result('asked', record.output);
    } else if (step.kind === 'revise') {
      if (++revisions > input.budget.maxRevisions) {
        record.status = 'failed';
        record.error = 'budget: revisions';
        finish();
        return stop('budget: revisions');
      }
      try {
        const revised = await input.controller.revise({
          request: input.request,
          plan,
          records,
          reason: step.reason,
          usage: input.usage,
          signal: input.signal,
        });
        collect(revised.usage);
        const takenIds = new Set(
          plan.steps.slice(0, cursor + 1).map((candidate) => candidate.id),
        );
        const validated = validateSteps(revised.steps, {
          workers: [...input.workers.keys()],
          takenIds,
          knownIds: takenIds,
        });
        if (!validated.ok) throw new Error(validated.error);
        plan.steps = [...plan.steps.slice(0, cursor + 1), ...validated.value];
      } catch (error) {
        collect(errorUsage(error).usage);
        return failStep(error, 'COORDINATOR_REVISE_FAILED');
      }
      finish();
    } else {
      const source =
        step.from === undefined ? undefined : latest.get(step.from);
      if (step.from !== undefined && (!source || source.status === 'failed')) {
        record.status = 'failed';
        record.error = `answer source ${step.from} has no result`;
        finish();
        return stop(record.error);
      }
      record.output = source?.output ?? step.text ?? '';
      finish();
      const answerStreamed =
        step.from !== undefined &&
        runs.get(step.from) === 1 &&
        record.output.trim().length > 0 &&
        (streamed.get(step.from) ?? '')
          .trimEnd()
          .endsWith(record.output.trim());
      return result('answered', record.output, answerStreamed);
    }
    cursor++;
  }
  return stop('plan ended without an answer');
}
