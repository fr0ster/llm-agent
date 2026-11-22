import type {
  ISubAgent,
  ISubAgentResult,
  LlmCallRecord,
  LlmUsageAttribution,
} from '@mcp-abap-adt/llm-agent';
import {
  completeUsageCalls,
  withUsageCalls,
} from '../../logger/llm-call-usage.js';
import { observeRequestCalls } from '../../logger/request-call-scope.js';
import { WorkerRequestLogger } from '../../logger/worker-request-logger.js';
import type { PipelineContext } from '../context.js';

type WorkerUsage = Pick<ISubAgentResult, 'usage' | 'metadata'> &
  Omit<LlmUsageAttribution, 'usage'>;

/** Meter each dispatch, including failures and retries, regardless of the interpreter. */
export function meterWorkers(
  workers: ReadonlyMap<string, ISubAgent>,
  ctx: PipelineContext,
  logLegacyUsage?: ReadonlySet<string>,
): Map<string, ISubAgent> {
  const result = new Map<string, ISubAgent>();

  for (const [name, worker] of workers) {
    const logUsage = (
      entry: WorkerUsage | null | undefined,
      requestId: string | undefined,
      durationMs: number,
      observed: ReadonlyMap<string, LlmCallRecord>,
    ) => {
      if (!entry) return;
      const importUsage =
        entry.usageCalls || !logLegacyUsage || logLegacyUsage.has(name);
      const models = entry.usage?.models;
      const calls = completeUsageCalls(
        {
          usageCalls: entry.usageCalls,
          usage: importUsage ? entry.usage : undefined,
          usageByModel: importUsage
            ? (entry.usageByModel ??
              (models && Object.keys(models).length > 0 ? models : undefined))
            : undefined,
          model:
            entry.model ??
            (typeof entry.metadata?.model === 'string'
              ? entry.metadata.model
              : worker.model),
        },
        'executor',
        durationMs,
        [...observed.values()],
      );
      for (const call of calls)
        ctx.requestLogger.logLlmCall({ ...call, requestId });
      return calls;
    };

    result.set(name, {
      name: worker.name,
      description: worker.description,
      capabilities: worker.capabilities,
      get model() {
        return worker.model;
      },
      async run(input) {
        const start = Date.now();
        const trace = ctx.options?.trace ?? input.trace;
        const logger = ctx.requestLogger;
        const observed = new Map<string, LlmCallRecord>();
        const run = () =>
          worker.run({ ...input, trace, requestLogger: logger });
        let value: ISubAgentResult;
        try {
          value = await (logger instanceof WorkerRequestLogger
            ? logger.observeCalls(trace?.traceId, observed, run)
            : observeRequestCalls(
                new Set([logger]),
                trace?.traceId,
                observed,
                run,
              ));
        } catch (error) {
          const calls = logUsage(
            error as WorkerUsage | null,
            trace?.traceId,
            Date.now() - start,
            observed,
          );
          throw withUsageCalls(error, calls ?? []);
        }
        logUsage(value, trace?.traceId, Date.now() - start, observed);
        return value;
      },
    });
  }

  return result;
}
