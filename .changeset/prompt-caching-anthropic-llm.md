---
"@mcp-abap-adt/anthropic-llm": minor
---

Prompt caching is enabled by default on chat and streams. `promptCaching?: boolean` uses call options before provider config, then defaults to `true`. Enabled requests include top-level `cache_control: { type: 'ephemeral' }` with the provider's documented default lifetime; `false` omits it. There is no TTL option. Responses and usage records preserve cache read/creation counters; normalized prompt totals include both.
