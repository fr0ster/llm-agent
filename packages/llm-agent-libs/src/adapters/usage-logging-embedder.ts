import type {
  CallOptions,
  IEmbedder,
  IEmbedderBatch,
  IEmbedResult,
} from '@mcp-abap-adt/llm-agent';
import { isBatchEmbedder } from '@mcp-abap-adt/llm-agent';

const BRAND = Symbol.for('@mcp-abap-adt/usage-logging-embedder');

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Log one embedding entry from a result (or an estimate when usage is absent). */
function logEmbed(
  options: CallOptions | undefined,
  text: string,
  usage: IEmbedResult['usage'],
): void {
  const logger = options?.requestLogger;
  if (!logger) return; // outside a request (e.g. startup vectorization) -> no-op
  const measured = usage?.totalTokens;
  const totalTokens = measured ?? estimateTokens(text);
  logger.logLlmCall({
    component: 'embedding',
    model: 'embedder',
    promptTokens: usage?.promptTokens ?? totalTokens,
    completionTokens: 0,
    totalTokens,
    durationMs: 0,
    scope: 'request',
    requestId: options?.trace?.traceId,
    ...(measured === undefined ? { estimated: true } : {}),
  });
}

class UsageLoggingEmbedder implements IEmbedder {
  readonly [BRAND] = true;
  constructor(protected readonly inner: IEmbedder) {}
  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    const r = await this.inner.embed(text, options);
    logEmbed(options, text, r.usage);
    return r;
  }
}

class UsageLoggingBatchEmbedder
  extends UsageLoggingEmbedder
  implements IEmbedderBatch
{
  constructor(protected readonly inner: IEmbedderBatch) {
    super(inner);
  }
  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    const results = await this.inner.embedBatch(texts, options);
    const logger = options?.requestLogger;
    if (logger) {
      let prompt = 0;
      let total = 0;
      let anyEstimated = false;
      results.forEach((r, i) => {
        if (r.usage?.totalTokens !== undefined) {
          prompt += r.usage.promptTokens;
          total += r.usage.totalTokens;
        } else {
          const est = estimateTokens(texts[i] ?? '');
          prompt += est;
          total += est;
          anyEstimated = true;
        }
      });
      logger.logLlmCall({
        component: 'embedding',
        model: 'embedder',
        promptTokens: prompt,
        completionTokens: 0,
        totalTokens: total,
        durationMs: 0,
        scope: 'request',
        requestId: options?.trace?.traceId,
        // estimated if ANY item lacked provider usage (the total is partly an estimate).
        ...(anyEstimated ? { estimated: true } : {}),
      });
    }
    return results;
  }
}

/**
 * Idempotent: returns `inner` unchanged if already wrapped; batch-capable when
 * `inner` is an IEmbedderBatch (preserves `isBatchEmbedder`).
 */
export function wrapEmbedder(inner: IEmbedder): IEmbedder {
  if ((inner as { [BRAND]?: boolean })[BRAND]) return inner;
  return isBatchEmbedder(inner)
    ? new UsageLoggingBatchEmbedder(inner)
    : new UsageLoggingEmbedder(inner);
}
