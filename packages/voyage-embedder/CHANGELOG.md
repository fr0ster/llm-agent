# @mcp-abap-adt/voyage-embedder

## 0.1.1

### Patch Changes

- 3b46360: Stop adaptive runs on a failed work step or check exception. Preserve error details and account for failed calls once. Follow recovery branches only after a semantic check verdict.
  
  Report explicit embedding input-size rejections from Ollama, OpenAI, SAP AI Core, and Voyage as the terminal `EMBEDDING_CONTEXT_EXCEEDED` error.

## 0.1.0

### Minor Changes

- c84c2a0: Add Voyage AI text embeddings and reranking, with asymmetric retrieval, request batching, and usage recording. Select the built-in embedder with `rag.embedder.provider: voyage`.
