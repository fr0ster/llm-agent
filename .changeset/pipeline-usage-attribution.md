---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": major
"@mcp-abap-adt/llm-agent-server-libs": patch
---

Attribute coordinator usage to the model reported by each role call and resolve dynamic adaptive controller models for each request. Include every worker tool-loop round in adaptive and DAG request usage, including when the worker has its own logger. Call IDs let coordinators safely import role and worker usage from results and errors even when those calls were also forwarded to the request logger. Workers can still return per-model usage without call IDs.

**BREAKING**. Subclasses of `LlmAdaptiveController`, `LlmDagPlanner`, and `LlmReviewStrategy` must override `model` with a getter instead of a field. Replace `override readonly model = 'custom'` with `override get model() { return 'custom'; }`.
