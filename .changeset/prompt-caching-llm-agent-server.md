---
"@mcp-abap-adt/llm-agent-server": minor
---

The composition root forwards Anthropic `llm.promptCaching` and OpenAI `llm.promptCacheKey`/`llm.promptCacheRetention` to their providers. Chat call options override provider config. Cache read/creation counters remain visible in usage summaries.
