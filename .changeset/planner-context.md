---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": minor
---

Prepare planner context from bounded request transcripts, with a persisted request journal and final message archive. Retain conversation mode for compatibility.

Index live session inputs, replies, finished tasks and closed plans into optional planner memory. Retrieve session memory and curated planning knowledge once per turn with bounded, escaped context blocks, deadlines and embedding usage attribution.

Add paged message and request reads, bounded delegation inputs by message id, and on-demand planning knowledge search in both planner context modes.

Add explicit new_request boundaries with controlled planner restarts and persist task request ownership so late task events cannot mutate a new request plan.
