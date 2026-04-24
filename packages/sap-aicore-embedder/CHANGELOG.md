# @mcp-abap-adt/sap-aicore-embedder

## 11.1.0

### Minor Changes

- feat: add `scenario` config option (`'foundation-models'` | `'orchestration'`), default `'foundation-models'`.
- feat: foundation-models scenario uses the AI Core REST inference API directly (`/v2/inference/deployments/{id}/embeddings`), resolving the deployment id from `/v2/lm/deployments?scenarioId=foundation-models&status=RUNNING`.
- feat: support explicit `credentials` option; falls back to parsing `AICORE_SERVICE_KEY` env var.
- fix: #116 — embedder no longer fails with `TypeError: fetch failed` on tenants where embedding models live under `foundation-models`.

## 11.0.0

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@12.0.0
