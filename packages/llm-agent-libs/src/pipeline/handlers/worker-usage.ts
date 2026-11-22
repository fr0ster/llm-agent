import type {
  ISubAgent,
  ISubAgentResult,
  LlmUsageAttribution,
} from '@mcp-abap-adt/llm-agent';
import {
  usageCallRecords,
  withUsageCalls,
} from '../../logger/llm-call-usage.js';
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
    ) => {
      if (!entry) return;
      const calls =
        entry.usageCalls ??
        (!logLegacyUsage || logLegacyUsage.has(name)
          ? usageCallRecords(
              {
                usage: entry.usage,
                usageByModel:
                  entry.usageByModel ??
                  (entry.usage?.models &&
                  Object.keys(entry.usage.models).length > 0
                    ? entry.usage.models
                    : undefined),
                model:
                  entry.model ??
                  (typeof entry.metadata?.model === 'string'
                    ? entry.metadata.model
                    : worker.model),
              },
              'executor',
              durationMs,
            )
          : []);
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
        let value: ISubAgentResult;
        try {
          value = await worker.run({
            ...input,
            trace,
            requestLogger: ctx.requestLogger,
          });
        } catch (error) {
          const calls = logUsage(
            error as WorkerUsage | null,
            trace?.traceId,
            Date.now() - start,
          );
          throw withUsageCalls(error, calls ?? []);
        }
        logUsage(value, trace?.traceId, Date.now() - start);
        return value;
      },
    });
  }

  return result;
}
