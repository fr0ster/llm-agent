# @mcp-abap-adt/sap-aicore-embedder

## 11.1.1

### Patch Changes

- Fix streaming `tool_calls` regression introduced in the 10.x provider split (#119) and surface MCP setup failures that were previously swallowed (#118).

  - **Streaming providers now emit normalized `toolCalls` deltas.** `sap-aicore-llm` reads `chunk.getDeltaToolCalls()`, `openai-llm` (and `deepseek-llm` by inheritance) reads `choice.delta.tool_calls`, and `anthropic-llm` tracks `tool_use` content blocks plus `input_json_delta` — populating the new optional `LLMResponse.toolCalls` field. `LlmProviderBridge` accumulates from this normalized field instead of digging into provider-specific `raw` payloads (it previously handled only the OpenAI shape, so SAP and Anthropic streaming tool calls were dropped). Anthropic also normalizes `stop_reason: 'tool_use'` → `finishReason: 'tool_calls'`.
  - **`SmartAgentBuilder.build()` no longer swallows MCP setup errors.** Connect failures (unreachable host, bad auth, container-network mismatch) and post-connect failures (tool vectorization throwing) now produce a `warning` log entry — `MCP setup failed for <url-or-command>: <error message>` — instead of disappearing into a bare `catch {}`. Graceful-degradation contract preserved.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@11.1.1

## 11.1.0

### Minor Changes

- feat: add `scenario` config option (`'foundation-models'` | `'orchestration'`). **Default is `'orchestration'`** — preserves v11.0.0 behavior for existing consumers; no config change needed.
- feat: when `scenario: 'foundation-models'`, the embedder calls the AI Core REST inference API directly (resolves deployment id from `/v2/lm/deployments?scenarioId=foundation-models&status=RUNNING`, POSTs to `/v2/inference/deployments/{id}/embeddings`).
- feat: support explicit `credentials` option for foundation-models scenario; falls back to parsing `AICORE_SERVICE_KEY` env var.
- fix: #116 — embedders deployed under `foundation-models` scenario can now be used by setting `scenario: 'foundation-models'` (previously the package only worked with orchestration-scenario embedding deployments).

### Migration

If your embedding model is deployed under the `foundation-models` scenario, add `scenario: 'foundation-models'` to your `SapAiCoreEmbedder` config:

```ts
const embedder = new SapAiCoreEmbedder({
  model: "gemini-embedding",
  scenario: "foundation-models",
});
```

## 11.0.0

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0
