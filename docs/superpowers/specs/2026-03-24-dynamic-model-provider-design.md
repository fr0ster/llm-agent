# Dynamic Model Provider — Design Spec

## Problem

SmartServer exposes a hardcoded `"smart-agent"` model name on `GET /v1/models` and in all chat completion responses. Consumers cannot discover which real models the underlying LLM provider offers, nor can they select a different model per request. This limits transparency, OpenAI API compatibility, and flexibility for multi-model use cases.

## Goals

1. Expose real provider models via `GET /v1/models` instead of hardcoded `"smart-agent"`.
2. Allow per-request model override in `POST /v1/chat/completions` (affects main LLM only; classifier/helper stay fixed).
3. Zero breaking changes — existing consumers work without modification after package update.
4. Follow existing DI/interface patterns — new `IModelProvider` interface, consumer can inject custom implementation.

## Non-Goals

- Switching classifier or helper models per request.
- Model validation on our side — provider returns errors for invalid models.
- Caching policy in the interface — caching is an implementation detail per provider.

## Design

### 1. New Interface: `IModelProvider`

File: `src/smart-agent/interfaces/model-provider.ts`

```typescript
import type { CallOptions, LlmError, Result } from './types.js';

export interface IModelInfo {
  id: string;
  owned_by?: string;
}

export interface IModelProvider {
  /** Currently configured (default) model name. */
  getModel(): string;

  /** Fetch available models from the provider. Called on demand. */
  getModels(options?: CallOptions): Promise<Result<IModelInfo[], LlmError>>;
}
```

### 2. CallOptions Extension

File: `src/smart-agent/interfaces/types.ts`

Add optional `model` field to the existing `CallOptions` interface:

```typescript
export interface CallOptions {
  // ... all existing fields unchanged
  /** Per-request model override. Affects only the main LLM. */
  model?: string;
}
```

`ILlm` interface is **not modified** — it already accepts `CallOptions` as a parameter.

### 3. Provider Changes

#### Per-request model override

Each provider uses `options.model ?? this.model` when constructing the HTTP request body, instead of always using `this.model`.

Affected providers: `OpenAIProvider`, `DeepSeekProvider`, `AnthropicProvider`, `SapCoreAIProvider`.

The `options` parameter (type `CallOptions`) is propagated through: `SmartServer → SmartAgent.process() → mainLlm.chat(messages, tools, options) → LlmAdapter → BaseAgent → Provider`.

#### `getModels()` return type update

Change from `Promise<string[]>` to returning `IModelInfo[]`:

| Provider | Implementation |
|----------|----------------|
| OpenAI | `GET /models` → map to `IModelInfo[]` (id + owned_by) |
| DeepSeek | `GET /models` → map to `IModelInfo[]` |
| Anthropic | `GET /models` → map to `IModelInfo[]` |
| SAP AI Core | `ScenarioApi.scenarioQueryModels('foundation-models')` from `@sap-ai-sdk/ai-api` → map to `IModelInfo[]`. Add TTL cache (60s) due to strict rate limits. |

Providers decide independently whether to cache `getModels()` results. SAP AI Core and OpenAI/Anthropic benefit from caching; DeepSeek and local providers (Ollama) do not need it.

### 4. LlmAdapter

File: `src/smart-agent/adapters/llm-adapter.ts`

`LlmAdapter` implements both `ILlm` and `IModelProvider`:

```typescript
export class LlmAdapter implements ILlm, IModelProvider {
  getModel(): string {
    return this.provider?.model ?? 'unknown';
  }

  async getModels(options?: CallOptions): Promise<Result<IModelInfo[], LlmError>> {
    // Delegates to provider.getModels(), wraps in Result
  }

  // chat() and streamChat() propagate options.model through to the agent/provider
}
```

`LlmAdapterProviderInfo.getModels` return type changes from `Promise<string[]>` to `Promise<IModelInfo[]>`.

### 5. TokenCountingLlm

File: `src/smart-agent/llm/token-counting-llm.ts`

Add accessor to unwrap the inner LLM:

```typescript
get inner(): ILlm { return this._inner; }
```

This allows the builder to auto-detect `IModelProvider` on the wrapped LLM.

### 6. SmartAgentBuilder

File: `src/smart-agent/builder.ts`

New fluent setter:

```typescript
withModelProvider(provider: IModelProvider): this
```

Auto-detection in `build()`: if `withModelProvider()` was not called, check if `mainLlm` (unwrapping `TokenCountingLlm` via `.inner`) implements `IModelProvider` (duck-typing check for `getModel` and `getModels` methods). If so, use it automatically.

```typescript
function isModelProvider(obj: unknown): obj is IModelProvider {
  return (
    typeof (obj as IModelProvider).getModels === 'function' &&
    typeof (obj as IModelProvider).getModel === 'function'
  );
}
```

### 7. SmartAgentHandle

File: `src/smart-agent/builder.ts`

Add optional field:

```typescript
export interface SmartAgentHandle {
  // ... existing fields unchanged
  /** Model provider for discovery. Undefined when not available. */
  modelProvider?: IModelProvider;
}
```

### 8. SmartServer

File: `src/smart-agent/smart-server.ts`

**`GET /v1/models`**: delegate to `handle.modelProvider.getModels()`. On error or when provider is unavailable, fall back to `[{ id: 'smart-agent' }]`.

**`POST /v1/chat/completions`**: extract `body.model` and pass it via `options.model` to `smartAgent.process()` / `smartAgent.streamProcess()`.

**Response `model` field**: use `body.model ?? handle.modelProvider?.getModel() ?? 'smart-agent'` instead of hardcoded `'smart-agent'` in both streaming and non-streaming responses.

### 9. Agent Hierarchy — model propagation

`LlmAdapter.chat()` already passes `options` to `agent.callWithTools(messages, mcpTools, options)`. Each agent subclass (`OpenAIAgent`, `DeepSeekAgent`, `AnthropicAgent`, `SapCoreAIAgent`) must propagate `options.model` to the provider when constructing the LLM HTTP request.

`SmartAgent.process()` / `streamProcess()` pass `options` (including `model`) only to `mainLlm`. Classifier and helper LLMs ignore `options.model` — they always use their configured model.

### 10. Exports

File: `src/index.ts`

Add:

```typescript
export type { IModelInfo, IModelProvider } from './smart-agent/interfaces/model-provider.js';
```

## Security Considerations

- **Model name injection**: model name is a JSON string field in the HTTP request body. Serialized via `JSON.stringify()` — no injection risk. Not used in URL paths or SQL.
- **Enumeration**: `/v1/models` reveals real provider models. Consumer can inject a filtering `IModelProvider` to restrict visibility. Additional authorization is the consumer's responsibility.
- **Cost escalation**: consumer controls the API key and can restrict models via custom `IModelProvider` or provider-side API key permissions.
- **Rate limiting for `getModels()`**: implementation detail per provider. Providers with strict rate limits (SAP AI Core, OpenAI, Anthropic) cache results with TTL. Interface does not prescribe caching.

## Backward Compatibility

All changes are additive:

- `CallOptions.model` — new optional field, existing code unaffected.
- `IModelProvider` — new interface, not required by any existing API.
- `SmartAgentHandle.modelProvider` — new optional field.
- `SmartAgentBuilder.withModelProvider()` — new optional method.
- `/v1/models` response — same shape, different `id` values (real models instead of `"smart-agent"`).
- When `IModelProvider` is not available — falls back to current `"smart-agent"` behavior.

**Semver**: minor version bump → `3.2.0`.

## File Change Summary

| # | File | Change |
|---|------|--------|
| 1 | `src/smart-agent/interfaces/model-provider.ts` | **New** — `IModelProvider`, `IModelInfo` |
| 2 | `src/smart-agent/interfaces/types.ts` | `CallOptions` + `model?: string` |
| 3 | `src/llm-providers/openai.ts` | `getModels()` → `IModelInfo[]`, per-request model override |
| 4 | `src/llm-providers/deepseek.ts` | Same as OpenAI |
| 5 | `src/llm-providers/anthropic.ts` | Same as OpenAI |
| 6 | `src/llm-providers/sap-core-ai.ts` | `getModels()` via `@sap-ai-sdk/ai-api`, TTL cache, per-request override |
| 7 | `src/smart-agent/adapters/llm-adapter.ts` | `implements IModelProvider`, propagate `options.model` |
| 8 | `src/smart-agent/llm/token-counting-llm.ts` | `get inner(): ILlm` accessor |
| 9 | `src/smart-agent/builder.ts` | `.withModelProvider()`, auto-detect, expose in `SmartAgentHandle` |
| 10 | `src/smart-agent/smart-server.ts` | `/v1/models` delegates to provider, `/v1/chat/completions` propagates `body.model`, response uses real model name |
| 11 | `src/agents/*.ts` | Propagate `options.model` to provider in HTTP requests |
| 12 | `src/index.ts` | Export `IModelProvider`, `IModelInfo` |
| 13 | `package.json` | `@sap-ai-sdk/ai-api` dependency, version `3.2.0` |
