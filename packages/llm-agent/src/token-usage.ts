import type { ModelUsageEntry, TokenUsage } from './interfaces/types.js';

type CacheTokens = Pick<
  TokenUsage,
  'cachedInputTokens' | 'cacheCreationInputTokens'
>;

/** Sum cache counters while preserving absent fields for older providers/records. */
export function addCacheTokenUsage(
  a?: Partial<TokenUsage>,
  b?: Partial<TokenUsage>,
): CacheTokens {
  return {
    ...(a?.cachedInputTokens !== undefined || b?.cachedInputTokens !== undefined
      ? {
          cachedInputTokens:
            (a?.cachedInputTokens ?? 0) + (b?.cachedInputTokens ?? 0),
        }
      : {}),
    ...(a?.cacheCreationInputTokens !== undefined ||
    b?.cacheCreationInputTokens !== undefined
      ? {
          cacheCreationInputTokens:
            (a?.cacheCreationInputTokens ?? 0) +
            (b?.cacheCreationInputTokens ?? 0),
        }
      : {}),
  };
}

/** Sum usage without mutating either operand or filling absent usage. */
export function addTokenUsage(
  a?: TokenUsage,
  b?: TokenUsage,
): TokenUsage | undefined {
  if (!a && !b) return undefined;
  const models = new Map<string, ModelUsageEntry>();
  for (const usage of [a, b]) {
    for (const [model, entry] of Object.entries(usage?.models ?? {})) {
      const previous = models.get(model);
      models.set(model, {
        ...addCacheTokenUsage(previous, entry),
        promptTokens: (previous?.promptTokens ?? 0) + entry.promptTokens,
        completionTokens:
          (previous?.completionTokens ?? 0) + entry.completionTokens,
        totalTokens: (previous?.totalTokens ?? 0) + entry.totalTokens,
        requests: (previous?.requests ?? 0) + entry.requests,
      });
    }
  }
  return {
    ...addCacheTokenUsage(a, b),
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
    ...(a?.models || b?.models ? { models: Object.fromEntries(models) } : {}),
  };
}
