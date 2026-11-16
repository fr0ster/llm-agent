---
"@mcp-abap-adt/llm-agent": minor
---

`CallOptions` and `LLMCallOptions` carry Anthropic `promptCaching` (`5m`, `1h`, `off`) and optional OpenAI `promptCacheKey`/`promptCacheRetention`. `addTokenUsage` preserves optional `cachedInputTokens` and `cacheCreationInputTokens`, including per-model sums. These are breakdown counters and must not be added to normalized prompt totals again.
