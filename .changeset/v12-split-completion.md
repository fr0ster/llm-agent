---
'@mcp-abap-adt/llm-agent': patch
'@mcp-abap-adt/llm-agent-mcp': patch
'@mcp-abap-adt/llm-agent-rag': patch
'@mcp-abap-adt/llm-agent-libs': patch
'@mcp-abap-adt/llm-agent-server': patch
---

Complete the v12 package split: introduce `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, and `@mcp-abap-adt/llm-agent-libs`. `@mcp-abap-adt/llm-agent-server` becomes binary-only — composition surface lives in `llm-agent-libs`, MCP in `llm-agent-mcp`, RAG/embedder in `llm-agent-rag`, interfaces and DTOs in `llm-agent`. Top-level `makeLlm` / `makeDefaultLlm` / `makeRag` are now async (`Promise<...>`); `resolveEmbedder` remains synchronous and uses the existing prefetch contract. `SmartAgentBuilder.build()` was already async — consumers using only the builder are unaffected. Closes #125.
