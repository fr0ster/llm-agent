---
"@mcp-abap-adt/anthropic-llm": minor
---

Automatic prompt caching is enabled on raw HTTP chat and streams by default (5m). Set `promptCaching: '1h'` or `'off'` in `AnthropicConfig` or call options; calls override config. Responses and usage records preserve cache read/creation counters. Normalized prompt totals include both.
