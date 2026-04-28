# @mcp-abap-adt/llm-agent

## 12.0.2

### Patch Changes

- 108cd1d: Complete the v12 package split: introduce `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, and `@mcp-abap-adt/llm-agent-libs`. `@mcp-abap-adt/llm-agent-server` becomes binary-only — composition surface lives in `llm-agent-libs`, MCP in `llm-agent-mcp`, RAG/embedder in `llm-agent-rag`, interfaces and DTOs in `llm-agent`. Top-level `makeLlm` / `makeDefaultLlm` / `makeRag` are now async (`Promise<...>`); `resolveEmbedder` remains synchronous and uses the existing prefetch contract. `SmartAgentBuilder.build()` was already async — consumers using only the builder are unaffected. Closes #125.

## 12.0.0

### Major Changes

- Move library helpers from `@mcp-abap-adt/llm-agent-server` into `@mcp-abap-adt/llm-agent` (#123).

  **BREAKING CHANGE.** Embedded consumers that ship their own HTTP server can now depend on `@mcp-abap-adt/llm-agent` only and skip the server package entirely. The following symbols are no longer exported from `@mcp-abap-adt/llm-agent-server` — import them from `@mcp-abap-adt/llm-agent` instead:

  - **Resilience:** `CircuitBreaker`, `CircuitBreakerConfig`, `CircuitState`, `CircuitBreakerLlm`, `CircuitBreakerEmbedder`, `FallbackRag`
  - **LLM call policies:** `NonStreamingLlmCallStrategy`, `StreamingLlmCallStrategy`, `FallbackLlmCallStrategy`
  - **Tool cache:** `ToolCache`, `NoopToolCache`, `IToolCache`
  - **API adapters:** `AnthropicApiAdapter`, `OpenAiApiAdapter`, `AdapterValidationError`, `ApiRequestContext`, `ApiSseEvent`, `ILlmApiAdapter`, `NormalizedRequest`
  - **Client adapters:** `ClineClientAdapter`, `IClientAdapter`
  - **Tool utilities:** `normalizeAndValidateExternalTools`, `normalizeExternalTools`, `ExternalToolValidationCode`, `ExternalToolValidationError`, `CLIENT_PROVIDED_PREFIX`, `getStreamToolCallName`, `toToolCallDelta`
  - **Logger:** `ILogger`, `LogEvent`

  `@mcp-abap-adt/llm-agent` runtime dependencies remain unchanged (`zod` only). The runnable distribution (`SmartAgentBuilder`, `SmartServer`, providers/factories composition root, plugins, skills, sessions, metrics, tracer, validator, reranker, history, structured pipeline, health, config watcher, MCP client wrapper, CLI, bin entries) stays in `@mcp-abap-adt/llm-agent-server`.

## 11.1.2

### Patch Changes

- Bump dependencies: biome 2.4.13, typescript 6.0.3, @types/node 25, rimraf 6, zod 4.3. MCP SDK 1.29 supports zod 3 || 4; smoke-tested via `npm run dev` against real MCP server.

## 11.1.1

### Patch Changes

- Fix streaming `tool_calls` regression introduced in the 10.x provider split (#119) and surface MCP setup failures that were previously swallowed (#118).

  - **Streaming providers now emit normalized `toolCalls` deltas.** `sap-aicore-llm` reads `chunk.getDeltaToolCalls()`, `openai-llm` (and `deepseek-llm` by inheritance) reads `choice.delta.tool_calls`, and `anthropic-llm` tracks `tool_use` content blocks plus `input_json_delta` — populating the new optional `LLMResponse.toolCalls` field. `LlmProviderBridge` accumulates from this normalized field instead of digging into provider-specific `raw` payloads (it previously handled only the OpenAI shape, so SAP and Anthropic streaming tool calls were dropped). Anthropic also normalizes `stop_reason: 'tool_use'` → `finishReason: 'tool_calls'`.
  - **`SmartAgentBuilder.build()` no longer swallows MCP setup errors.** Connect failures (unreachable host, bad auth, container-network mismatch) and post-connect failures (tool vectorization throwing) now produce a `warning` log entry — `MCP setup failed for <url-or-command>: <error message>` — instead of disappearing into a bare `catch {}`. Graceful-degradation contract preserved.

## 11.1.0

### Patch Changes

- Released alongside the @mcp-abap-adt/sap-aicore-embedder + @mcp-abap-adt/llm-agent-server foundation-models scenario fix (#116, #117) and the @mcp-abap-adt/qdrant-rag dimension mismatch guard. No source changes in this package — version sync per the changesets fixed group.

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

## 10.0.0

### Major Changes

- Split single package into a monorepo with two initial packages:

  - `@mcp-abap-adt/llm-agent` — interfaces, types, and lightweight RAG default implementations.
  - `@mcp-abap-adt/llm-agent-server` — default SmartAgent, pipeline, LLM providers, MCP client, HTTP server, and CLIs.

  Consumers of the v9 single package must switch their imports to one or both v10 packages. See `docs/MIGRATION-v10.md` for the symbol-by-symbol mapping and install-command changes.

  CLI bins (`llm-agent`, `llm-agent-check`, `claude-via-agent`) remain available and are now shipped by `@mcp-abap-adt/llm-agent-server`.
