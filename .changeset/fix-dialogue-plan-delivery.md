---
"@mcp-abap-adt/llm-agent-libs": patch
"@mcp-abap-adt/llm-agent": patch
---

Preserve structured steps when updating only plan status or the user question. Deliver each task output at most once per request, including correction calls and restored sessions. Add the optional, backward-compatible `PlannerRequestRecord.deliveredTaskIds` field to persist delivery history.
