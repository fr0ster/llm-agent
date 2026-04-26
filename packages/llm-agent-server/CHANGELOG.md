# @mcp-abap-adt/llm-agent-server

## 11.1.1

### Patch Changes

- Fix streaming `tool_calls` regression introduced in the 10.x provider split (#119) and surface MCP setup failures that were previously swallowed (#118).

  - **Streaming providers now emit normalized `toolCalls` deltas.** `sap-aicore-llm` reads `chunk.getDeltaToolCalls()`, `openai-llm` (and `deepseek-llm` by inheritance) reads `choice.delta.tool_calls`, and `anthropic-llm` tracks `tool_use` content blocks plus `input_json_delta` — populating the new optional `LLMResponse.toolCalls` field. `LlmProviderBridge` accumulates from this normalized field instead of digging into provider-specific `raw` payloads (it previously handled only the OpenAI shape, so SAP and Anthropic streaming tool calls were dropped). Anthropic also normalizes `stop_reason: 'tool_use'` → `finishReason: 'tool_calls'`.
  - **`SmartAgentBuilder.build()` no longer swallows MCP setup errors.** Connect failures (unreachable host, bad auth, container-network mismatch) and post-connect failures (tool vectorization throwing) now produce a `warning` log entry — `MCP setup failed for <url-or-command>: <error message>` — instead of disappearing into a bare `catch {}`. Graceful-degradation contract preserved.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@11.1.1
  - @mcp-abap-adt/openai-llm@11.1.1
  - @mcp-abap-adt/anthropic-llm@11.1.1
  - @mcp-abap-adt/deepseek-llm@11.1.1
  - @mcp-abap-adt/sap-aicore-llm@11.1.1
  - @mcp-abap-adt/openai-embedder@11.1.1
  - @mcp-abap-adt/ollama-embedder@11.1.1
  - @mcp-abap-adt/sap-aicore-embedder@11.1.1
  - @mcp-abap-adt/qdrant-rag@11.1.1
  - @mcp-abap-adt/hana-vector-rag@11.1.1
  - @mcp-abap-adt/pg-vector-rag@11.1.1

## 11.1.0

### Minor Changes

- feat: forward `scenario` and `resourceGroup` from RAG store config to the SAP AI Core embedder, so consumers can target `scenario: 'foundation-models'` deployments via YAML/programmatic config (see #116).

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
