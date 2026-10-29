---
"@mcp-abap-adt/llm-agent-libs": minor
"@mcp-abap-adt/llm-agent": minor
---

All agents now receive static request-time guidance in their system prompt and one request-time line in request content, stable across tool rounds. Guidance now emits a system message even when no preamble or retrieved context existed. Dialogue workers inherit the owning request's openedAt through typed task options, including queued work. Add deployment timeZone configuration (UTC by default) with shared validation. Hosts no longer need to append the guidance.
