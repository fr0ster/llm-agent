---
"@mcp-abap-adt/ollama-embedder": major
---

Remove provider-internal retries and the constructor `retry` option. Each non-empty
`embed`/`embedBatch` invocation makes one HTTP request; network, HTTP and decoding
failures surface immediately. HTTP RagError metadata (`status`, `headers`,
`retryAfterSeconds`) is preserved using the shared Retry-After parser.

Migration: wrap `new OllamaEmbedder(...)` with `composeEmbedder` from
`@mcp-abap-adt/llm-agent-rag`, or `composeResilientEmbedder` from core, to get
retries. Remove `retry` from constructor configs; configure retry/throttle policy
on the composition instead. Existing resolver/server paths already compose retries.

`OllamaRag` now composes core resilience internally to retain convenience retries.
