---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/sap-aicore-llm": minor
"@mcp-abap-adt/llm-agent-rag": minor
"@mcp-abap-adt/llm-usage": minor
---

SAP AI Core streaming: recover the HTTP status and Retry-After of an empty-body error response, so an empty 429 takes the throttle path instead of failing with "Unexpected end of JSON input". Retry transient failures (5xx, unreadable error bodies, connection resets) once before the first response chunk, with visible physical attempts. Usage records of failed LLM and embedding calls carry errorStatus and errorName (no message text); CSV exports include both. Cap single embedding inputs at 24000 characters by default (maxInputChars) and stop retrying input-too-long errors.
