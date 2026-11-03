---
'@mcp-abap-adt/llm-agent': minor
'@mcp-abap-adt/llm-agent-libs': minor
---

Add the catalog v1 dialogue.task.finish signal and typed per-run task context.
Both worker tool loops consume retained task completion before the next LLM call,
preserving normal successful task settlement and execution evidence. Document
host tool emission, stale signal exclusion and degradation without retention.
