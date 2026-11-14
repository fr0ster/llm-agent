---
"@mcp-abap-adt/llm-agent-libs": patch
---

Order retrieved conversation history from newest to oldest, keep turn chunks together in chunk order, and evict whole oldest turns when the context token budget is exceeded. Other retrieved sections retain score-based ordering and eviction.
