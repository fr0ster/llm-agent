---
"@mcp-abap-adt/deepseek-llm": minor
---

DeepSeek caches matching prefixes automatically. `prompt_cache_hit_tokens` is preserved as `cachedInputTokens` in normalized chat/stream usage and physical usage records. OpenAI-specific cache controls are not sent.
