# @mcp-abap-adt/qdrant-rag

## 11.1.0

### Minor Changes

- fix: `_ensureCollection` now reads the existing collection's `vectors.size` and throws a clear `RagError` when it doesn't match the embedder's output dimension. Previously, switching embedding models against a collection of a different vector size silently dropped every upsert on the server side, leaving stores empty and breaking RAG retrieval. Operators now see a precise error pointing at the conflict and the resolution (drop/recreate the collection, or point the store at a per-embedder collection).

## 11.0.0

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0
