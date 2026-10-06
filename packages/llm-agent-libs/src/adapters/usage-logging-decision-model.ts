import type {
  CallOptions,
  DecisionError,
  DecisionRequest,
  DecisionResult,
  IProbabilityDecision,
  IRelevanceDecision,
  RelevanceRequest,
  RelevanceResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

const BRAND = Symbol.for('@mcp-abap-adt/usage-logging-decision-model');
const RELEVANCE_BRAND = Symbol.for(
  '@mcp-abap-adt/usage-logging-relevance-decision',
);

/**
 * The one accounting body of both wrappers: a successful call → one
 * `component: 'decision'` entry; measured usage when the provider reports it,
 * otherwise an estimate (`estimated: true`). No logger → nothing.
 */
function logDecisionUsage(
  request: unknown,
  value: {
    model: string;
    usage?: { inputTokens: number; outputTokens?: number };
  },
  started: number,
  options?: CallOptions,
): void {
  const logger = options?.requestLogger;
  if (!logger) return;
  const usage = value.usage;
  const promptTokens =
    usage?.inputTokens ?? Math.ceil(JSON.stringify(request).length / 4);
  const completionTokens = usage?.outputTokens ?? 0;
  logger.logLlmCall({
    component: 'decision',
    model: value.model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    durationMs: Date.now() - started,
    scope: 'request',
    requestId: options?.trace?.traceId,
    ...(usage === undefined ? { estimated: true } : {}),
  });
}

class UsageLoggingProbabilityDecision implements IProbabilityDecision {
  readonly [BRAND] = true;
  constructor(private readonly inner: IProbabilityDecision) {}

  get model(): string | undefined {
    return this.inner.model;
  }

  async decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>> {
    const started = Date.now();
    const r = await this.inner.decide(request, options);
    if (r.ok) logDecisionUsage(request, r.value, started, options);
    return r;
  }
}

class UsageLoggingRelevanceDecision implements IRelevanceDecision {
  readonly [RELEVANCE_BRAND] = true;
  constructor(private readonly inner: IRelevanceDecision) {}

  get model(): string | undefined {
    return this.inner.model;
  }

  async score(
    request: RelevanceRequest,
    options?: CallOptions,
  ): Promise<Result<RelevanceResult, DecisionError>> {
    const started = Date.now();
    const r = await this.inner.score(request, options);
    if (r.ok) logDecisionUsage(request, r.value, started, options);
    return r;
  }
}

/**
 * Account every successful probability-decision call to the request's logger
 * (`component: 'decision'`). No logger → no-op. Idempotent.
 */
export function wrapProbabilityDecision(
  inner: IProbabilityDecision,
): IProbabilityDecision {
  if ((inner as { [BRAND]?: boolean })[BRAND]) return inner;
  return new UsageLoggingProbabilityDecision(inner);
}

/** Account every successful relevance call to the request's logger
 *  (`component: 'decision'`). No logger → no-op. Idempotent. */
export function wrapRelevanceDecision(
  inner: IRelevanceDecision,
): IRelevanceDecision {
  if ((inner as { [RELEVANCE_BRAND]?: boolean })[RELEVANCE_BRAND]) return inner;
  return new UsageLoggingRelevanceDecision(inner);
}
