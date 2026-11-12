---
"@mcp-abap-adt/llm-agent": patch
"@mcp-abap-adt/llm-agent-libs": patch
"@mcp-abap-adt/llm-agent-server-libs": patch
---

Preserve the trusted caller object and its session ID when dialogue sessions create or revise plans. Reject conflicting callers before dispatch. Forward callers to adaptive finalizers and through recursive steppers to plan reviewers, refusing review when its trusted caller is missing or belongs to another session.
