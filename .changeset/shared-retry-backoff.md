---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": patch
---

Export the shared exponentialBackoffMs helper and reuse it in RetryLlm,
RetryEmbedder and throttle fallback policy, preserving ordinary retry delays.
Retry decorators now use the shared bounded HTTP status/cause reader, including
SDK response.status metadata, instead of maintaining another status walker.
