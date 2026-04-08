# HTTP Endpoints for Runtime Configuration (#78)

## Context

v5.18.4 added `SmartAgent.reconfigure()` and `getActiveConfig()` as programmatic APIs (#76). SmartServer does not expose these via HTTP, so external clients (UIs, compat layers) cannot use them without code changes.

## Endpoints

### GET /v1/config

Returns current active configuration. Aliases: `/config`.

**Response (200):**

```json
{
  "models": {
    "mainModel": "anthropic--claude-4.6-sonnet",
    "classifierModel": "gpt-4.1-mini",
    "helperModel": "gpt-4.1-mini"
  },
  "parameters": {
    "temperature": 0.7,
    "max_tokens": 32768,
    "maxIterations": 10,
    "classificationEnabled": true
  }
}
```

- `models` — from `SmartAgent.getActiveConfig()`
- `parameters` — from `SmartAgentConfig` (all fields exposed, consumer decides what to use)

### PUT /v1/config

Partial runtime reconfiguration. Aliases: `/config`.

**Request body:**

```json
{
  "models": {
    "classifierModel": "gpt-4o"
  },
  "parameters": {
    "temperature": 0.5
  }
}
```

Both blocks are optional. Omitted fields keep current values.

- `models` fields → resolved via `IModelResolver` → passed to `SmartAgent.reconfigure()`
- `parameters` fields → passed to `SmartAgent.applyConfigUpdate()`

**Response (200):** updated config in the same format as GET.

**Errors:**

| Status | Condition |
|--------|-----------|
| 400 | Invalid JSON body |
| 400 | `models` sent but `IModelResolver` not configured |
| 405 | Wrong HTTP method (not GET/PUT) |
| 500 | Model resolution failed (e.g., unknown model, provider error) |

## IModelResolver Interface

```typescript
export interface IModelResolver {
  resolve(modelName: string, role: 'main' | 'classifier' | 'helper'): Promise<ILlm>;
}
```

### DefaultModelResolver

Default implementation in `src/smart-agent/providers.ts`. Wraps existing `resolve*Llm()` functions. Requires access to current config (API keys, provider settings).

### Integration

- `SmartServerConfig` gets optional `modelResolver?: IModelResolver` field
- `SmartAgentBuilder` gets `.withModelResolver()` setter
- Passed to `SmartServer`, used only in `PUT /v1/config` for model fields
- If not configured and client sends model fields → 400

### Exports

`IModelResolver` and `DefaultModelResolver` added to `src/index.ts`.

## Routing

Added to `SmartServer._handle()` alongside existing endpoints:

- `GET /v1/config` or `/config` → return active config
- `PUT /v1/config` or `/config` → apply partial update
- Other methods on `/v1/config` → 405

Follows existing patterns: `readBody()`, `JSON.parse()`, `jsonError()`, CORS headers.

## Out of Scope

- **Authentication/authorization** — separate issue; no endpoints currently have auth. Planned as `IAuthMiddleware` interface with no-op default.
- **`_meta` in `/v1/models`** — rejected; config and models are separate resources.

## Tests

File: `src/smart-agent/__tests__/config-endpoints.test.ts`

Test cases:
- `GET /v1/config` returns 200 with models + parameters
- `PUT /v1/config` with parameters only — updates parameters, returns updated config
- `PUT /v1/config` with models + resolver — resolves and reconfigures
- `PUT /v1/config` with models but no resolver — 400
- `PUT /v1/config` with invalid JSON — 400
- `PUT /v1/config` with unknown model (resolver throws) — 500
- `GET /config` alias works
