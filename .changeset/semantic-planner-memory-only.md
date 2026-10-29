---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": minor
---

Read earlier planner content only through semantic retrieval. Remove get_message and get_request,
delegate_task inputs and history, and the session message archive and closed request transcripts
and plans. Workers receive a brief and retrieve additional content themselves.

Remove TaskRequest.history (no production callers outside the dialogue planner), DialogueState.messages,
PlannerRequestRecord.replies/closedPlan/transcriptExpired and PlannerMemoryEntry.expired;
PlannerRequestRecord.transcript is now optional and present only for open requests. These fields are
removed, not deprecated. Legacy persisted archive fields are ignored on restore and omitted on save.
