---
"@mcp-abap-adt/llm-agent-server-libs": minor
---

Flat and named `llm` YAML entries accept `promptCaching` (Anthropic: `5m` default, `1h`, `off`), `promptCacheKey`, and `promptCacheRetention` (OpenAI: `in_memory`, `24h`). HTTP chat requests can override them; OpenAI wire aliases `prompt_cache_key` and `prompt_cache_retention` are accepted. Usage summaries preserve cache counters by model.
