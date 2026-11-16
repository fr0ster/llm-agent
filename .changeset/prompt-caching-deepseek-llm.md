---
"@mcp-abap-adt/deepseek-llm": minor
---

DeepSeek caches matching prefixes automatically. The shared `promptCaching?: boolean` switch has no request effect: the client cannot turn off provider caching. No cache parameters are sent. `prompt_cache_hit_tokens` is preserved as `cachedInputTokens` in normalized chat/stream usage and physical usage records.
