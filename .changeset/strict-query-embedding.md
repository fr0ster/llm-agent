---
'@mcp-abap-adt/llm-agent': minor
'@mcp-abap-adt/qdrant-rag': minor
'@mcp-abap-adt/pg-vector-rag': minor
'@mcp-abap-adt/hana-vector-rag': minor
---

Add `fallbackOnQueryEmbeddingError?: boolean` to vector RAG store configs, defaulting to `true` for compatibility. Set it to `false` to return a caller-supplied query embedding's first failure as a failed `Result` without calling the store embedder again. Explicit `TextOnlyEmbedding` queries still use the store embedder once. Transformed `VectorRag` queries still embed the transformed text once and propagate failures.
