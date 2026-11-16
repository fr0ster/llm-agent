---
"@mcp-abap-adt/llm-agent": minor
---

`CallOptions`, `LLMCallOptions`, and `LLMProviderConfig` carry only `promptCaching?: boolean` for prompt caching. The effective setting is `options.promptCaching ?? config.promptCaching ?? true`; each provider owns its caching mechanism. `false` disables client-controlled caching; automatic provider caching may remain active. `addTokenUsage` preserves optional `cachedInputTokens` and `cacheCreationInputTokens`, including per-model sums. These are breakdown counters and must not be added to normalized prompt totals again.
