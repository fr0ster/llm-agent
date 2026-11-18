---
"@mcp-abap-adt/llm-agent-libs": major
---

Remove default adaptive run and LLM retry caps, including the exported MAX_RUNS_CAP. Explicit adaptive limits and non-429 retry caps remain available. Honor Retry-After on HTTP 429 until the caller aborts or the provider stops returning 429. Surface truncated output, empty worker responses, and missing verdicts as failures, and report malformed tool-call metadata with a corrective tool result.
