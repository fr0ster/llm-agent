---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": minor
---

Add dialogue wait status signals and non-terminal long-running task events. End repeated planner status polling with a normal turn result, and wake the planner on configurable long-running intervals without calling it for wait ticks. Require llm-agent ^30.15.0 in llm-agent-libs for the extended contracts.
