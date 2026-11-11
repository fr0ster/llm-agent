---
"@mcp-abap-adt/llm-agent-server-libs": patch
"@mcp-abap-adt/llm-agent-libs": patch
"@mcp-abap-adt/llm-agent": patch
"@mcp-abap-adt/llm-agent-rag": patch
---

Guard worker embedders with identity-shared circuit breakers and wire worker RAG fallback to the same breaker. Report additional embedder breakers with identifying health labels.

Preserve shared collections' embedder breaker bindings and canonicalize provider identities independently of batching options.
