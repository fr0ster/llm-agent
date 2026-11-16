---
"@mcp-abap-adt/ollama-embedder": minor
---

Add retry: false for a single HTTP attempt in embed and embedBatch. Preserve HTTP status, response headers and shared-parser retryAfterSeconds on RagError so core throttle composition can handle rate limits. Default provider retries remain enabled.
