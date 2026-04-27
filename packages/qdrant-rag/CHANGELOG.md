# @mcp-abap-adt/qdrant-rag

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

### Minor Changes

- fix: `_ensureCollection` now reads the existing collection's `vectors.size` and throws a clear `RagError` when it doesn't match the embedder's output dimension. Previously, switching embedding models against a collection of a different vector size silently dropped every upsert on the server side, leaving stores empty and breaking RAG retrieval. Operators now see a precise error pointing at the conflict and the resolution (drop/recreate the collection, or point the store at a per-embedder collection).

## 11.0.0

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0
