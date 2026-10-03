import type {
  CallOptions,
  DecisionError,
  DecisionRequest,
  DecisionResult,
  IDecisionModel,
  Result,
} from '@mcp-abap-adt/llm-agent';

const BRAND = Symbol.for('@mcp-abap-adt/usage-logging-decision-model');

class UsageLoggingDecisionModel implements IDecisionModel {
  readonly [BRAND] = true;
  constructor(private readonly inner: IDecisionModel) {}

  get model(): string | undefined {
    return this.inner.model;
  }

  async decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>> {
    const started = Date.now();
    const r = await this.inner.decide(request, options);
    const logger = options?.requestLogger;
    if (!r.ok || !logger) return r;
    const usage = r.value.usage;
    const promptTokens =
      usage?.inputTokens ?? Math.ceil(JSON.stringify(request).length / 4);
    const completionTokens = usage?.outputTokens ?? 0;
    logger.logLlmCall({
      component: 'decision',
      model: r.value.model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      durationMs: Date.now() - started,
      scope: 'request',
      requestId: options?.trace?.traceId,
      ...(usage === undefined ? { estimated: true } : {}),
    });
    return r;
  }
}

/**
 * Account every successful decision call to the request's logger
 * (`component: 'decision'`). No logger → no-op. Idempotent.
 */
export function wrapDecisionModel(inner: IDecisionModel): IDecisionModel {
  if ((inner as { [BRAND]?: boolean })[BRAND]) return inner;
  return new UsageLoggingDecisionModel(inner);
}
