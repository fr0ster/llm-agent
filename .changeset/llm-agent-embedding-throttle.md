---
"@mcp-abap-adt/llm-agent": minor
---

Extend existing embedder retry composition with independent shared-quota throttling and retry: false. Add opt-in Retry-After fallback backoff to WaitAsTold, share transport metadata parsing with LLM providers, and preserve input caps, batch chunking, usage coordinates and caller cancellation. Unlimited quota waits have no library attempt or time budget.
