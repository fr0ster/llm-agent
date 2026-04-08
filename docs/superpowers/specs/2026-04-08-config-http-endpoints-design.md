# HTTP Endpoints for Runtime Configuration (#78)

## Context

v5.18.4 added `SmartAgent.reconfigure()` and `getActiveConfig()` as programmatic APIs (#76). SmartServer does not expose these via HTTP, so external clients (UIs, compat layers) cannot use them without code changes.

## Endpoints

### GET /v1/config

Returns current active configuration. Aliases: `/config`.

This endpoint should expose a **stable runtime DTO**, not the full internal
`SmartAgentConfig` object. Internal implementation details must not become
public API by accident.

**Response (200):**

```json
{
  "models": {
    "mainModel": "anthropic--claude-4.6-sonnet",
    "classifierModel": "gpt-4.1-mini",
    "helperModel": "gpt-4.1-mini"
  },
  "agent": {
    "maxIterations": 10,
    "classificationEnabled": true
  },
  "llmDefaults": {
    "temperature": 0.7,
    "maxTokens": 32768
  }
}
```

- `models` — from `SmartAgent.getActiveConfig()`
- `agent` — explicit whitelist of runtime-safe `SmartAgentConfig` fields
- `llmDefaults` — optional server-side runtime state for LLM defaults; not sourced
  from `SmartAgentConfig`

### Runtime DTO contract

The response must not expose "all fields" from `SmartAgentConfig`.
Only explicitly supported fields are part of the HTTP contract.

Initial whitelist:

- `agent.maxIterations`
- `agent.maxToolCalls`
- `agent.ragQueryK`
- `agent.toolUnavailableTtlMs`
- `agent.showReasoning`
- `agent.historyAutoSummarizeLimit`
- `agent.classificationEnabled`
- `agent.ragRetrievalMode`
- `agent.ragTranslationEnabled`
- `agent.ragUpsertEnabled`
- `llmDefaults.temperature`
- `llmDefaults.maxTokens`

Rationale:

- `temperature` / `maxTokens` are request/LLM defaults, not `SmartAgentConfig`
  fields
- exposing the full internal config would create an unstable public API
- deprecated/internal-only fields must stay private unless explicitly promoted

### PUT /v1/config

Partial runtime reconfiguration. Aliases: `/config`.

**Request body:**

```json
{
  "models": {
    "classifierModel": "gpt-4o"
  },
  "agent": {
    "classificationEnabled": false
  },
  "llmDefaults": {
    "temperature": 0.5
  }
}
```

Both blocks are optional. Omitted fields keep current values.

- `models` fields → resolved via `IModelResolver` → passed to `SmartAgent.reconfigure()`
- `agent` fields → validated against whitelist → passed to `SmartAgent.applyConfigUpdate()`
- `llmDefaults` fields → applied to server-held runtime defaults used for new requests

### Update semantics

`PUT /v1/config` is **atomic**:

- validate request body first
- resolve all requested model changes first
- if any validation/resolution step fails, apply nothing
- only after all checks succeed, commit model + agent + llm default updates

This avoids partial runtime state changes when one of several requested updates
fails.

### Reconfigure safety

Current `SmartAgent.reconfigure()` replaces live LLM instances but does not
preserve builder-time wrappers automatically (retry, circuit breaker, rate
limiter, etc.).

Therefore one of these must be true in implementation:

- `IModelResolver` returns fully wrapped production-ready `ILlm` instances, or
- `SmartServer` reapplies the same wrappers before calling `reconfigure()`

Using raw provider instances here would silently change runtime behavior after a
successful config update.

**Response (200):** updated config in the same format as GET.

**Errors:**

| Status | Condition |
|--------|-----------|
| 400 | Invalid JSON body |
| 400 | Unknown or unsupported fields in `agent` / `llmDefaults` |
| 400 | `models` sent but `IModelResolver` not configured |
| 400 / 422 | Requested model name is invalid or unsupported |
| 405 | Wrong HTTP method (not GET/PUT) |
| 500 | Internal model resolution failure (provider/resolver crashed, timed out, etc.) |

## IModelResolver Interface

```typescript
export interface IModelResolver {
  resolve(modelName: string, role: 'main' | 'classifier' | 'helper'): Promise<ILlm>;
}
```

### DefaultModelResolver

Default implementation in `src/smart-agent/providers.ts`.
It should be built on top of existing provider factory APIs (`makeLlm()` /
`makeDefaultLlm()`), not on imaginary `resolve*Llm()` helpers.

It requires access to current provider settings (API keys, base URLs, per-role
provider config) and should return the same wrapper shape expected in normal
server startup.

### Integration

- `SmartServerConfig` gets optional `modelResolver?: IModelResolver` field
- `SmartServer` uses it only in `PUT /v1/config` for model fields
- If not configured and client sends model fields → 400

`SmartAgentBuilder.withModelResolver()` is not required unless a separate
builder-level use case appears. The HTTP endpoint is owned by `SmartServer`,
so server-level DI is sufficient.

### Exports

`IModelResolver` and `DefaultModelResolver` added to `src/index.ts`.

## Routing

Added to `SmartServer._handle()` alongside existing endpoints:

- `GET /v1/config` or `/config` → return active config
- `PUT /v1/config` or `/config` → apply partial update
- Other methods on `/v1/config` → 405

Implementation notes:

- follow existing patterns: `readBody()`, `JSON.parse()`, `jsonError()`, CORS
  headers
- for `405`, include `Allow: GET, PUT, OPTIONS`
- `/config` remains an alias to `/v1/config`
- path-specific `405` handling is expected even though unrelated unmatched
  routes still return `404`

## Out of Scope

- **Authentication/authorization** — separate issue; no endpoints currently have auth. Planned as `IAuthMiddleware` interface with no-op default.
- **`_meta` in `/v1/models`** — rejected; config and models are separate resources.
- **Persisting HTTP config updates back to YAML** — this endpoint changes only
  in-memory runtime state for the active server process
- **Reconfiguring arbitrary provider credentials over HTTP** — only model
  selection and explicit runtime-safe fields are in scope

## Tests

File: `src/smart-agent/__tests__/config-endpoints.test.ts`

Test cases:
- `GET /v1/config` returns 200 with models + parameters
- `PUT /v1/config` with parameters only — updates parameters, returns updated config
- `PUT /v1/config` with models + resolver — resolves and reconfigures
- `PUT /v1/config` with models but no resolver — 400
- `PUT /v1/config` with invalid JSON — 400
- `PUT /v1/config` with unsupported field in agent/llmDefaults — 400
- `PUT /v1/config` with unknown model name — 400 or 422
- `PUT /v1/config` with resolver internal error — 500
- `PUT /v1/config` is atomic when one model resolution fails
- `PUT /v1/config` preserves configured wrappers for reconfigured models
- `GET /v1/config` returns only whitelisted fields, not raw full `SmartAgentConfig`
- `GET /config` alias works
