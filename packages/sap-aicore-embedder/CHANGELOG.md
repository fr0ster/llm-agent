# @mcp-abap-adt/sap-aicore-embedder

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
  model: 'gemini-embedding',
  scenario: 'foundation-models',
});
```

## 11.0.0

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0
