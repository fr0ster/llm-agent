---
"@mcp-abap-adt/llm-agent": minor
---

Expose optional model output token limits and allow legacy provider bridges to forward a finish reason. Preserve retry waits longer than the Node timer range.

Keep structured HTTP metadata through provider wrappers without retaining the original transport error. Honor explicit zero-second Retry-After values in WaitAsTold and allow callers to cancel consecutive immediate retries.
