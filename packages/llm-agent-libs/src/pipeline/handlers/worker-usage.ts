import type { ISubAgent, ISubAgentResult } from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '../context.js';

type WorkerUsage = Pick<
  ISubAgentResult,
  'usage' | 'model' | 'usageLogged' | 'metadata'
>;

/** Meter each dispatch, including failures and retries, regardless of the interpreter. */
export function meterWorkers(
  workers: ReadonlyMap<string, ISubAgent>,
  ctx: PipelineContext,
  logReturnedUsage?: ReadonlySet<string>,
): Map<string, ISubAgent> {
  const requestId = ctx.options?.trace?.traceId;
  const result = new Map<string, ISubAgent>();

  for (const [name, worker] of workers) {
    const logUsage = (
      entry: WorkerUsage | null | undefined,
      durationMs: number,
    ) => {
      if (
        !entry?.usage ||
        entry.usageLogged ||
        (logReturnedUsage && !logReturnedUsage.has(name))
      )
        return;
      const model =
        entry.model ??
        (typeof entry.metadata?.model === 'string'
          ? entry.metadata.model
          : worker.model);
      const models = Object.entries(entry.usage.models ?? {});
      if (models.length === 0) {
        ctx.requestLogger.logLlmCall({
          ...entry.usage,
          component: 'executor',
          model: model ?? 'unknown',
          durationMs,
          requestId,
        });
        return;
      }
      // The model breakdown already accounts for the flat total.
      for (const [usedModel, usage] of models) {
        ctx.requestLogger.logLlmCall({
          ...usage,
          component: 'executor',
          model: usedModel,
          durationMs: 0,
          requestId,
        });
      }
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
        let value: ISubAgentResult;
        try {
          value = await worker.run({
            ...input,
            trace: ctx.options?.trace ?? input.trace,
            requestLogger: ctx.requestLogger,
          });
        } catch (error) {
          logUsage(error as WorkerUsage | null, Date.now() - start);
          throw error;
        }
        logUsage(value, Date.now() - start);
        return value;
      },
    });
  }

  return result;
}
