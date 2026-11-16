---
"@mcp-abap-adt/llm-agent-server": minor
---

The composition root forwards the shared `llm.promptCaching?: boolean` switch to every provider. Chat call options override provider config, with `true` as the default. Each provider decides its request behavior. Cache read/creation counters remain visible in usage summaries.
