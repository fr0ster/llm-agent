---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": major
---

Attribute coordinator usage to the model reported by each role call and resolve dynamic adaptive controller models for each request. Include every worker tool-loop round in adaptive and DAG request usage, including when the worker has its own logger. Workers can return per-model usage or indicate that their usage is already recorded in the request logger.

**BREAKING**. Subclasses of `LlmAdaptiveController`, `LlmDagPlanner`, and `LlmReviewStrategy` must override `model` with a getter instead of a field. Replace `override readonly model = 'custom'` with `override get model() { return 'custom'; }`.
