---
"@mcp-abap-adt/llm-agent-libs": major
---

Remove default adaptive run and LLM retry caps, including the exported MAX_RUNS_CAP. Explicit adaptive limits and non-429 retry caps remain available. Honor Retry-After on HTTP 429 until the caller aborts or the provider stops returning 429. Surface truncated output, empty worker responses, and missing verdicts as failures, and report malformed tool-call metadata with a corrective tool result.

Classify HTTP retries using structured status metadata. Retry HTTP 408 by default and stop on permanent client or authentication failures, including after a stream has produced output.

Stop coordinator retries on permanent HTTP failures, check for truncation before output validation, and persist terminal planner failures across dialogue session restores.
