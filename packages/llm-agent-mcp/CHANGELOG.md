# @mcp-abap-adt/llm-agent-mcp

## 12.0.1

### Patch Changes

- 108cd1d: Complete the v12 package split: introduce `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, and `@mcp-abap-adt/llm-agent-libs`. `@mcp-abap-adt/llm-agent-server` becomes binary-only — composition surface lives in `llm-agent-libs`, MCP in `llm-agent-mcp`, RAG/embedder in `llm-agent-rag`, interfaces and DTOs in `llm-agent`. Top-level `makeLlm` / `makeDefaultLlm` / `makeRag` are now async (`Promise<...>`); `resolveEmbedder` remains synchronous and uses the existing prefetch contract. `SmartAgentBuilder.build()` was already async — consumers using only the builder are unaffected. Closes #125.
- Updated dependencies [108cd1d]
  - @mcp-abap-adt/llm-agent@12.0.1
