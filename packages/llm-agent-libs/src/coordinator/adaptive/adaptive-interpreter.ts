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
  StepRecord,
  StepStatus,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import { composeStepInput } from './compose-step-input.js';
import { parseVerdict, validateSteps } from './parse-plan.js';

/** Dependencies and request context for one sequential adaptive run. */
export interface AdaptiveRunInput {
  request: string;
  history: Message[];
  plan: AdaptivePlan;
  workers: ReadonlyMap<string, ISubAgent>;
  controller: IAdaptiveController;
  budget: AdaptiveBudget;
  sessionId?: string;
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
  ) {
    super(result.stopReason ?? 'epicfail', 'COORDINATOR_STEP_FAILED');
  }
}

/** Default limits for one request. */
export const DEFAULT_BUDGET: AdaptiveBudget = {
  maxSteps: 20,
  maxRevisions: 3,
  maxDurationMs: 300000,
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Execute a plan until it answers, asks, awaits tools, or needs a stop report. */
export async function runAdaptivePlan(
  input: AdaptiveRunInput,
): Promise<AdaptiveRunResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
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
  const stop = async (stopReason: string): Promise<AdaptiveRunResult> => {
    let output: string;
    try {
      const report = await input.controller.report({
        request: input.request,
        plan,
        records,
        stopReason,
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      collect(report.usage);
      output = report.text;
    } catch {
      input.signal?.throwIfAborted();
      output = [
        `Stopped: ${stopReason}`,
        ...records.map(
          (record) =>
            `- ${record.stepId} (${record.kind}) ${record.status}${record.verdict ? `: ${record.verdict.verdict} — ${record.verdict.reason}` : ''}`,
        ),
      ].join('\n');
    }
    return { ...result('stopped', output), stopReason };
  };

  while (cursor < plan.steps.length) {
    input.signal?.throwIfAborted();
    if (records.length >= input.budget.maxSteps) return stop('budget: steps');
    if (now() - startedAt >= input.budget.maxDurationMs)
      return stop('budget: time');
    const step = plan.steps[cursor];
    if (!step) break;
    const run = (runs.get(step.id) ?? 0) + 1;
    runs.set(step.id, run);
    const maxRuns =
      'maxRuns' in step
        ? (step.maxRuns ?? (step.kind === 'check' ? 3 : 1))
        : step.kind === 'check'
          ? 3
          : 1;
    if (run > maxRuns) return stop(`step ${step.id} exceeded ${maxRuns} runs`);
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
            signal: input.signal,
          });
          collect(checked.usage);
          record.verdict = checked.verdict;
          record.output = JSON.stringify(checked.verdict);
        } catch (error) {
          input.signal?.throwIfAborted();
          collect((error as { usage?: LlmUsage } | null)?.usage);
          record.verdict = {
            verdict: 'fail',
            reason: `controller check failed: ${message(error)}`,
          };
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
        try {
          const worker = input.workers.get(step.worker);
          if (!worker) throw new Error(`unknown worker ${step.worker}`);
          const worked = await worker.run({
            ...composeStepInput({
              request: input.request,
              spec: plan.spec,
              step,
              latest: orderedLatest,
              history: input.history,
              checkReason: reason,
            }),
            sessionId: input.sessionId,
            signal: input.signal,
            trace: input.trace,
            sessionLogger: input.sessionLogger,
            externalTools: input.externalTools,
            externalResults: input.externalResults,
            onPartial,
          });
          collect(worked.usage);
          if (worked.usage)
            workerUsage.push({
              worker: step.worker,
              usage: worked.usage,
              model:
                typeof worked.metadata?.model === 'string'
                  ? worked.metadata.model
                  : undefined,
            });
          if (worked.errorClass === 'epicfail') {
            record.status = 'failed';
            record.error = 'epicfail';
            finish();
            throw new AdaptiveEpicFailError(
              {
                ...result('stopped', ''),
                stopReason: `step ${step.id} epicfail`,
              },
              worked.epicFailTrace,
            );
          }
          record.output = worked.output;
          if (worked.status === 'awaiting-external') {
            finish();
            return {
              ...result('awaiting-external', worked.output),
              pendingExternalToolCalls: worked.pendingExternalToolCalls,
            };
          }
          if (step.kind === 'check')
            record.verdict = parseVerdict(worked.output) ?? {
              verdict: 'fail',
              reason: 'unparsable verdict',
            };
        } catch (error) {
          if (error instanceof AdaptiveEpicFailError) throw error;
          const failed = error as { usage?: LlmUsage; model?: string } | null;
          if (failed?.usage) {
            collect(failed.usage);
            workerUsage.push({
              worker: step.worker,
              usage: failed.usage,
              model: failed.model,
            });
          }
          input.signal?.throwIfAborted();
          record.status = 'failed';
          record.output = '';
          record.error = message(error);
          if (step.kind === 'check')
            record.verdict = {
              verdict: 'fail',
              reason: `worker check failed: ${message(error)}`,
            };
        }
      }
      finish();
      if (
        step.kind === 'work' &&
        record.status === 'failed' &&
        !plan.steps
          .slice(cursor + 1)
          .some(
            (candidate) =>
              candidate.kind === 'check' && candidate.targets.includes(step.id),
          )
      ) {
        return stop(`step ${step.id} failed: ${record.error}`);
      }
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
        input.signal?.throwIfAborted();
        record.status = 'failed';
        collect((error as { usage?: LlmUsage } | null)?.usage);
        record.error = message(error);
        finish();
        return stop(`revise failed: ${record.error}`);
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
