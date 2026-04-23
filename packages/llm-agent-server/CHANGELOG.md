# @mcp-abap-adt/llm-agent-server

## 11.0.0

### Major Changes

- Complete provider and backend extraction. Eight new packages shipped:
  @mcp-abap-adt/openai-llm, anthropic-llm, deepseek-llm, sap-aicore-llm,
  openai-embedder, ollama-embedder, sap-aicore-embedder, qdrant-rag.

  Breaking changes:

  - Back-compat re-exports from v10.0 removed. Each symbol lives in exactly
    one package. See docs/MIGRATION-v11.md for the symbol-by-symbol table.
  - Non-Smart Agent hierarchy removed. Use SmartAgent + a provider class
    directly.
  - Core runtime dep shrinks to zod only; axios and @sap-ai-sdk/\* move to
    their respective extracted packages.
  - Server provider dependencies are optional peer deps. Install only the
    peers your smart-server.yaml names. Missing peer throws
    MissingProviderError at startup.

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0
  - @mcp-abap-adt/openai-llm@12.0.0
  - @mcp-abap-adt/anthropic-llm@12.0.0
  - @mcp-abap-adt/deepseek-llm@12.0.0
  - @mcp-abap-adt/sap-aicore-llm@12.0.0
  - @mcp-abap-adt/openai-embedder@12.0.0
  - @mcp-abap-adt/ollama-embedder@12.0.0
  - @mcp-abap-adt/sap-aicore-embedder@12.0.0
  - @mcp-abap-adt/qdrant-rag@12.0.0

## 10.0.0

### Major Changes

- Split single package into a monorepo with two initial packages:

  - `@mcp-abap-adt/llm-agent` — interfaces, types, and lightweight RAG default implementations.
  - `@mcp-abap-adt/llm-agent-server` — default SmartAgent, pipeline, LLM providers, MCP client, HTTP server, and CLIs.

  Consumers of the v9 single package must switch their imports to one or both v10 packages. See `docs/MIGRATION-v10.md` for the symbol-by-symbol mapping and install-command changes.

  CLI bins (`llm-agent`, `llm-agent-check`, `claude-via-agent`) remain available and are now shipped by `@mcp-abap-adt/llm-agent-server`.

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@10.0.0
