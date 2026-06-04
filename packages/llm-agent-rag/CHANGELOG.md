# @mcp-abap-adt/llm-agent-rag

## 18.2.0

Client-provided external tools under the DAG coordinator (#171). External (client) tools are now mode-independent (always offered; `hard` governs only internal MCP execution), consumer-executed (the worker surfaces a standard tool_call via the normal OpenAI/Anthropic round-trip — no custom transport), and carry deterministic content-addressed `ext:` ids for stateless re-run correlation. Parallel DAG workers' external calls are collected into one terminal assistant turn; incoming external results are adjacency-validated and the consumed turns stripped from internal LLM message lists.

## 18.1.2

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.2
  - @mcp-abap-adt/openai-embedder@18.1.2
  - @mcp-abap-adt/ollama-embedder@18.1.2
  - @mcp-abap-adt/sap-aicore-embedder@18.1.2
  - @mcp-abap-adt/qdrant-rag@18.1.2
  - @mcp-abap-adt/hana-vector-rag@18.1.2
  - @mcp-abap-adt/pg-vector-rag@18.1.2

## 18.1.1

### Patch Changes

- Version alignment — unify ALL workspace packages to a single version.

  18.1.0 bumped only the six core packages (the changeset `fixed` group at the time), leaving the eleven provider / embedder / RAG-backend packages at 18.0.2. The `fixed` group now contains all 17 packages so every release moves them together. This release carries no functional change — it only realigns the provider/embedder/backend packages (18.0.2 → 18.1.1) and the core packages (18.1.0 → 18.1.1) to one version.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.1
  - @mcp-abap-adt/openai-embedder@18.1.1
  - @mcp-abap-adt/ollama-embedder@18.1.1
  - @mcp-abap-adt/sap-aicore-embedder@18.1.1
  - @mcp-abap-adt/qdrant-rag@18.1.1
  - @mcp-abap-adt/hana-vector-rag@18.1.1
  - @mcp-abap-adt/pg-vector-rag@18.1.1

## 18.1.0

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.0

## 12.0.3

### Patch Changes

- 108cd1d: Complete the v12 package split: introduce `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, and `@mcp-abap-adt/llm-agent-libs`. `@mcp-abap-adt/llm-agent-server` becomes binary-only — composition surface lives in `llm-agent-libs`, MCP in `llm-agent-mcp`, RAG/embedder in `llm-agent-rag`, interfaces and DTOs in `llm-agent`. Top-level `makeLlm` / `makeDefaultLlm` / `makeRag` are now async (`Promise<...>`); `resolveEmbedder` remains synchronous and uses the existing prefetch contract. `SmartAgentBuilder.build()` was already async — consumers using only the builder are unaffected. Closes #125.
- Updated dependencies [108cd1d]
  - @mcp-abap-adt/llm-agent@12.0.1
