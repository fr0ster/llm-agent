# @mcp-abap-adt/pg-vector-rag

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

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0

## 11.1.2

### Patch Changes

- Bump dependencies: biome 2.4.13, typescript 6.0.3, @types/node 25, rimraf 6, zod 4.3. MCP SDK 1.29 supports zod 3 || 4; smoke-tested via `npm run dev` against real MCP server.
- Updated dependencies
  - @mcp-abap-adt/llm-agent@11.1.2

## 11.1.1

### Patch Changes

- Fix streaming `tool_calls` regression introduced in the 10.x provider split (#119) and surface MCP setup failures that were previously swallowed (#118).

  - **Streaming providers now emit normalized `toolCalls` deltas.** `sap-aicore-llm` reads `chunk.getDeltaToolCalls()`, `openai-llm` (and `deepseek-llm` by inheritance) reads `choice.delta.tool_calls`, and `anthropic-llm` tracks `tool_use` content blocks plus `input_json_delta` — populating the new optional `LLMResponse.toolCalls` field. `LlmProviderBridge` accumulates from this normalized field instead of digging into provider-specific `raw` payloads (it previously handled only the OpenAI shape, so SAP and Anthropic streaming tool calls were dropped). Anthropic also normalizes `stop_reason: 'tool_use'` → `finishReason: 'tool_calls'`.
  - **`SmartAgentBuilder.build()` no longer swallows MCP setup errors.** Connect failures (unreachable host, bad auth, container-network mismatch) and post-connect failures (tool vectorization throwing) now produce a `warning` log entry — `MCP setup failed for <url-or-command>: <error message>` — instead of disappearing into a bare `catch {}`. Graceful-degradation contract preserved.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@11.1.1

## 11.1.0

### Patch Changes

- Released alongside the @mcp-abap-adt/sap-aicore-embedder + @mcp-abap-adt/llm-agent-server foundation-models scenario fix (#116, #117) and the @mcp-abap-adt/qdrant-rag dimension mismatch guard. No source changes in this package — version sync per the changesets fixed group.

## 11.0.0

### Initial Release

- PgVectorRag + PgVectorRagProvider (#115).
