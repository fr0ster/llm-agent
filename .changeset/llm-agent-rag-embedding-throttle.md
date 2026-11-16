---
"@mcp-abap-adt/llm-agent-rag": minor
---

Forward retry and throttle options from composeEmbedder to the existing core resilience chain. Consumers can retain input caps and batch chunking while disabling ordinary retries and independently waiting on provider 429 responses.
