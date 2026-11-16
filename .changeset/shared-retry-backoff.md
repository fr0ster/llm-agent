---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": patch
---

Export the shared exponentialBackoffMs helper and reuse it in RetryLlm,
RetryEmbedder and throttle fallback policy, preserving ordinary retry delays.
Retry decorators now use the shared bounded HTTP status/cause reader, including
SDK response.status metadata, instead of maintaining another status walker.

With a throttle configured, ordinary transient retries now wait through the
configured `retry.waitStrategy`, and an abort during throttle retry backoff
rethrows the caller's original `signal.reason`. RetryLlm preserves its Result
contract: cancellation returns or yields ABORTED with the original
`signal.reason` as the error cause.
