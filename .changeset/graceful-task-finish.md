---
'@mcp-abap-adt/llm-agent': minor
'@mcp-abap-adt/llm-agent-libs': minor
---

Add the catalog v1 dialogue.task.finish signal and typed per-run task context.
Both worker tool loops consume retained task completion before every LLM call,
including the first, after synchronous activity and tools-selected callbacks.
Retention uses the unique context runId as key and the session as source, with
payload taskId/runId checks. Late emissions from previous runs cannot overwrite
a current finish, even with the same source and task id. In-flight tool batches
settle normally; already started LLM calls are not interrupted,
preserving normal successful task settlement and execution evidence. Document
host tool emission, run identity isolation and degradation without retention.
