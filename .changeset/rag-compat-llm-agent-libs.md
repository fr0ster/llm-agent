---
"@mcp-abap-adt/llm-agent-libs": major
---

Preserve optional store capabilities through `StrategyRag`, reject decorator cycles, and apply the retrieval strategy once on either circuit-breaker route. `StrategyRag.writer` is now absent when the wrapped store has no writer method. Use `writer?.()` when the wrapped store's write capability is optional.
