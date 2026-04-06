# Design: Token Categorization, Batch Embedding & SAP AI Core Direct Provider

Covers GitHub issues: #52, #53, #54

## Problem Statement

Three related issues around token tracking and performance:

1. **#53** — `byComponent` in session logs is empty `{}`. Root cause requires explicit diagnostic confirmation before structural changes. Separately, the logger lacks higher-level categorization that separates initialization, auxiliary, and request tokens.
2. **#52** — 146 sequential `embed()` calls at startup → 146 HTTP requests → ~2.5 min with throttling. All three embedding providers (OpenAI, Ollama, SAP AI Core) support array input natively.
3. **#54** — SAP AI Core Orchestration Service adds ~14K phantom tokens per request via internal prompt wrapping. A direct inference provider would yield accurate token counts.

## Design

### 1. Token Categorization and Logger Diagnostics (#53)

#### Root cause investigation

Before changing the logger model, confirm the actual root cause for empty `byComponent`:

- Confirm whether `logLlmCall()` is executed on all expected paths (classifier, tool-loop, translate, etc.).
- Confirm whether `startRequest()` / `reset()` clears data too early.
- Confirm whether the affected observation comes from structured pipeline, legacy agent paths, or `/v1/usage`.

`byCategory` is an observability enhancement. It does not replace root-cause analysis for missing `byComponent` entries.

#### Token categories

```typescript
type TokenCategory = 'initialization' | 'auxiliary' | 'request';
```

Component-to-category mapping:

| Component | Category | Rationale |
|-----------|----------|-----------|
| `tool-loop` | `request` | Main LLM work per user request |
| `classifier` | `auxiliary` | Pipeline orchestration overhead |
| `translate` | `auxiliary` | RAG query translation overhead |
| `query-expander` | `auxiliary` | RAG query expansion overhead |
| `helper` | `auxiliary` | History summarization overhead |
| `embedding` | `initialization` | Tool/skill vectorization at startup |

#### TokenBucket with physical/logical counters

```typescript
interface TokenBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;   // physical outbound API calls
  items?: number;     // logical texts processed (relevant for batch embeddings)
}
```

For normal LLM calls, `items` remains undefined or equals `1`. For batch embedding, one `request` may cover many `items`.

#### RequestSummary changes

```typescript
export interface RequestSummary {
  byModel: Record<string, TokenBucket>;
  byComponent: Record<string, TokenBucket>;
  byCategory: Record<TokenCategory, TokenBucket>;
  ragQueries: number;
  toolCalls: number;
  totalDurationMs: number;
}
```

#### Component-to-category mapping in DefaultRequestLogger

A static map inside `getSummary()` derives `byCategory` from existing `byComponent` data. No changes to call sites.

```typescript
const CATEGORY_MAP: Record<LlmComponent, TokenCategory> = {
  'tool-loop': 'request',
  classifier: 'auxiliary',
  translate: 'auxiliary',
  'query-expander': 'auxiliary',
  helper: 'auxiliary',
  embedding: 'initialization',
};
```

#### LlmCallEntry — estimated token flag

```typescript
interface LlmCallEntry {
  component: LlmComponent;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  estimated?: boolean;  // true for embedding token estimates
  scope?: 'initialization' | 'request'; // explicit lifecycle scope
  detail?: string; // optional finer label, e.g. 'tools' | 'skills'
}
```

For embedding entries: `estimated: true`, `completionTokens: 0`, `promptTokens === totalTokens`. This prevents consumers from treating embedding counts as precise billing numbers.

#### Embedding token tracking

Add `'embedding'` to `LlmComponent` type. In `builder.ts` tool/skill vectorization, call `requestLogger.logLlmCall()` with:

- `component: 'embedding'`
- `scope: 'initialization'`
- `detail: 'tools' | 'skills'`
- `estimated: true`

Token estimate: `Math.ceil(text.length / 4)` (~4 chars/token approximation).

#### Initialization scope boundaries

What counts as `initialization`:
- Tool vectorization at builder startup.
- Skill vectorization at builder startup.

What is excluded:
- Health checks and warmups.
- Lazy first-use embedding during requests (these are `request`-scoped).

Tools vs skills are distinguished through `detail` metadata on `LlmCallEntry` (for example `detail: 'tools'` and `detail: 'skills'`), not separate top-level categories.

#### Separate initialization from per-request storage

`DefaultRequestLogger` splits internal storage:

- `initLlmCalls: LlmCallEntry[]` — never reset by `startRequest()`.
- `requestLlmCalls: LlmCallEntry[]` — reset on `startRequest()`.

`logLlmCall()` routes based on explicit `scope`:

- `scope: 'initialization'` → `initLlmCalls`
- `scope: 'request'` or undefined → `requestLlmCalls`

This avoids overloading `component === 'embedding'` for two different lifecycles. Runtime embedding triggered during request handling remains request-scoped.

#### Client-facing usage — semantics unchanged

OpenAI-protocol response `usage` continues to represent only the current request's generation cost. It is sourced from actual request-time stream chunks, not derived from `RequestSummary`.

- `byCategory` is exposed only in diagnostics / session logs / `/v1/usage`.
- Initialization token estimates are observability-only, never included in client `usage`.
- `/v1/usage` is treated as diagnostics-oriented and may include lifecycle-level initialization metrics if clearly labeled.

Token metrics are scoped per agent instance (created in builder, lives as long as SmartAgent).

### 2. Batch Embedding (#52)

#### IEmbedderBatch interface

```typescript
export interface IEmbedderBatch extends IEmbedder {
  embedBatch(texts: string[], options?: CallOptions): Promise<number[][]>;
}
```

Extends `IEmbedder` — every batch embedder is also a single embedder. Backward compatible.

#### Type guard

```typescript
export function isBatchEmbedder(e: IEmbedder): e is IEmbedderBatch {
  return 'embedBatch' in e && typeof (e as any).embedBatch === 'function';
}
```

#### Implementations

**OpenAiEmbedder** — add `embedBatch()`:
- POST `{ model, input: texts[] }` → response `{ data: [{ embedding, index }] }` sorted by `index`.
- Same retry logic as `embed()`.
- Configurable chunk size (default conservative value). Chunks processed sequentially.

**OllamaEmbedder** — add `embedBatch()`:
- Ollama `/api/embed` endpoint accepts `{ model, input: string[] }` → `{ embeddings: number[][] }`.
- Use `/api/embed` (not `/api/embeddings` which is single-only).
- Fallback to smaller chunks on 413/timeout.

**SapAiCoreEmbedder** — add `embedBatch()`:
- `OrchestrationEmbeddingClient.embed({ input: texts[] })` → `EmbeddingData[]` sorted by `index`.
- Configurable chunk size. Fallback to single-item mode if batch input fails.

**CircuitBreakerEmbedder** — proxy `embedBatch()` if inner supports it.

#### Batch sizing and fallback

Configuration:

```yaml
rag:
  embeddingBatchSize: 100
  embeddingBatchEnabled: true
```

If a batch request fails, the builder degrades gracefully: retry with smaller batches, then fall back to single-item embedding. Startup is never aborted due to batch failure alone.

#### IPrecomputedVectorRag — narrower interface

Instead of expanding `IRag` globally, define a separate interface:

```typescript
export interface IPrecomputedVectorRag extends IRag {
  upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>>;
}
```

Type guard in the builder:

```typescript
function supportsPrecomputed(rag: IRag): rag is IPrecomputedVectorRag {
  return 'upsertPrecomputed' in rag;
}
```

This keeps `IRag` minimal. Only `VectorRag` and `QdrantRag` implement `IPrecomputedVectorRag`.

#### Shared internal write path in VectorRag

Factor storage logic into an internal helper to avoid drift:

```typescript
private upsertKnownVector(
  text: string,
  vector: number[],
  metadata: RagMetadata,
): Result<void, RagError> { /* dedup, ID replacement, index update */ }
```

- `upsert()` computes the vector and delegates to `upsertKnownVector()`.
- `upsertPrecomputed()` validates vector shape and delegates to `upsertKnownVector()`.

#### Builder changes

The builder must use the same embedder instance that backs the target vector store. It must not independently resolve a second embedder with potentially different model/configuration, because that would produce incompatible vectors.

Practical rule:

- if the selected store implements `IPrecomputedVectorRag`, the builder may batch-embed only when it can access that store's effective embedder or an equivalent shared embedder instance configured for that store;
- otherwise, it must fall back to normal store-managed `upsert()`.

```typescript
if (isBatchEmbedder(embedderForToolStore)) {
  const texts = tools.map(t => `Tool: ${t.name} — ${t.description}`);
  const vectors = await embedderForToolStore.embedBatch(texts);
  for (let i = 0; i < tools.length; i++) {
    if (supportsPrecomputed(toolStore)) {
      await toolStore.upsertPrecomputed(texts[i], vectors[i], { id: `tool:${tools[i].name}` });
    } else {
      await toolStore.upsert(texts[i], { id: `tool:${tools[i].name}` });
      // warning: precomputed vectors not used, re-embedding individual texts
    }
  }
} else {
  // existing sequential loop with 5/500ms throttling
}
```

If `upsertPrecomputed()` is unavailable on the target store, fall back to normal `upsert()` with a warning log.

Important clarification:

- this fallback preserves correctness;
- it does **not** fully solve `#52` end-to-end for that store, because the store may re-embed each text individually;
- `#52` is considered fully addressed only when both conditions hold:
  - the embedder supports batch embedding;
  - the target store supports precomputed-vector writes.

### 3. SAP AI Core Direct Provider (#54)

#### Architecture boundary — compatibility-first path

Add `src/llm-providers/sap-ai-core-direct.ts`, wrap it with `OpenAIAgent`, and expose it through `LlmAdapter`, matching the existing `providers.ts` composition style. This follows the current provider resolution flow that constructs legacy providers and adapts them through `LlmAdapter`.

#### New provider: `sap-ai-core-direct`

Uses `resolveDeploymentUrl()` from `@sap-ai-sdk/ai-api` to get the model's inference endpoint, then sends OpenAI-compatible HTTP requests directly — bypassing OrchestrationClient entirely.

```
Consumer → SapAiCoreDirectProvider.chat(messages, tools)
         → resolveDeploymentUrl({ model, resourceGroup })
         → POST {deploymentUrl}/chat/completions (OpenAI format)
         ← Standard OpenAI response with accurate token counts
```

#### Key differences from existing `sap-core-ai` provider

| Aspect | `sap-core-ai` (Orchestration) | `sap-ai-core-direct` (Direct) |
|--------|-------------------------------|-------------------------------|
| SDK | `@sap-ai-sdk/orchestration` | `@sap-ai-sdk/ai-api` + raw HTTP |
| Token overhead | ~14K phantom tokens | Accurate counts |
| Tool calling | Via promptTemplating module | Native OpenAI function calling |
| Content filtering | Built-in | None (consumer responsibility) |
| Model access | Via scenario name | Via deployment URL |

#### Implementation

```typescript
export class SapAiCoreDirectProvider implements ILlmProvider {
  private deploymentUrl: string | null = null;

  constructor(private config: SapAiCoreDirectConfig) {}

  async chat(messages, tools?, options?): Promise<LlmResponse> {
    const url = await this.resolveUrl();
    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, messages, tools, ...params }),
    });
    return this.parseResponse(await response.json());
  }

  async *streamChat(messages, tools?, options?): AsyncIterable<LlmStreamChunk> {
    const url = await this.resolveUrl();
    // SSE stream with per-request HTTP agent (same isolation as sap-core-ai)
    // Parse OpenAI SSE chunks
  }
}
```

#### Authentication

Reuse existing XSUAA token resolution from `@sap-ai-sdk/core`. The SDK handles token caching internally when using `resolveDeploymentUrl()`.

#### Deployment URL caching

Cache `resolveDeploymentUrl()` result for the lifetime of the provider instance. Deployment URLs are stable — they only change on redeployment. Implement refresh-on-error for resilience after redeployments.

#### Agent: extends OpenAIAgent

The direct API is OpenAI-compatible. Use `OpenAIAgent` directly — no custom agent subclass needed unless SAP-specific behavior diverges.

#### Configuration — single source of truth

Provider selection via YAML provider name only:

```yaml
llm:
  provider: sap-ai-core-direct
  model: gpt-4o
  resourceGroup: default
```

No boolean env var for provider selection. Env vars are used only for credentials and connection settings (`AICORE_SERVICE_KEY`, etc.).

#### Parity requirements

Before broader adoption, the direct provider must pass parity checks:

- Chat completion works with plain prompts.
- Streaming works with OpenAI-style SSE framing.
- Tool calling works with the same request/response shape expected by `OpenAIAgent`.
- Per-request model override behavior remains compatible.
- Model discovery: day one returns a minimal fallback set from the configured model. Full discovery deferred.

#### Provider registration

Add to `providers.ts` factory map alongside existing providers. Builder resolves by name.

## Data Flow

### Token tracking flow (per request)

```
startup:
  builder.ts → embedBatch() → requestLogger.logLlmCall({
    component: 'embedding',
    scope: 'initialization',
    detail: 'tools',
    estimated: true
  })
  → stored in initLlmCalls[] (never reset)

per request:
  startRequest() → reset requestLlmCalls[] only
  classifier → logLlmCall({ component: 'classifier' }) → requestLlmCalls[]
  translate → logLlmCall({ component: 'translate' }) → requestLlmCalls[]
  tool-loop → logLlmCall({ component: 'tool-loop' }) → requestLlmCalls[]
  runtime embedding (if any) → logLlmCall({
    component: 'embedding',
    scope: 'request'
  }) → requestLlmCalls[]
  getSummary() → merge initLlmCalls + requestLlmCalls
    → byCategory, byComponent, byModel

client response usage ← sourced from stream chunks (not RequestSummary)
session log / /v1/usage ← includes byCategory with initialization
```

### Batch embedding flow (startup)

```
builder.ts:
  tools = mcpClient.listTools()              // 146 tools
  if isBatchEmbedder(embedder):
    texts = tools.map(formatToolText)         // 146 strings
    vectors = embedder.embedBatch(texts)      // 1 HTTP request (or chunked)
    for each (text, vector, tool):
      if supportsPrecomputed(store):
        store.upsertPrecomputed(text, vector, metadata)
      else:
        store.upsert(text, metadata)          // fallback + warning
  else:
    // existing sequential loop with 5/500ms throttling
```

## Files to Change

| File | Change |
|------|--------|
| `src/smart-agent/interfaces/request-logger.ts` | Add `TokenCategory`, `TokenBucket`, `byCategory`, `estimated` flag, `'embedding'` to `LlmComponent` |
| `src/smart-agent/logger/default-request-logger.ts` | Split init/request arrays, `byCategory` aggregation, `items` counter |
| `src/smart-agent/logger/noop-request-logger.ts` | Return empty `byCategory` |
| `src/smart-agent/interfaces/rag.ts` | Add `IEmbedderBatch`, `isBatchEmbedder()`, `IPrecomputedVectorRag`, `supportsPrecomputed()` |
| `src/smart-agent/rag/openai-embedder.ts` | Implement `IEmbedderBatch` |
| `src/smart-agent/rag/ollama-rag.ts` | Implement `IEmbedderBatch` |
| `src/smart-agent/rag/sap-ai-core-embedder.ts` | Implement `IEmbedderBatch` |
| `src/smart-agent/rag/vector-rag.ts` | Extract `upsertKnownVector()`, implement `IPrecomputedVectorRag` |
| `src/smart-agent/rag/qdrant-rag.ts` | Implement `IPrecomputedVectorRag` |
| `src/smart-agent/resilience/circuit-breaker-embedder.ts` | Proxy `embedBatch()` |
| `src/smart-agent/resilience/fallback-rag.ts` | Proxy `upsertPrecomputed()` if inner supports it |
| `src/smart-agent/builder.ts` | Batch embedding path, embedding token logging |
| `src/llm-providers/sap-ai-core-direct.ts` | **NEW** — Direct inference provider |
| `src/smart-agent/providers.ts` | Register `sap-ai-core-direct` provider and embedder factories |
| `src/index.ts` | Export new types and classes |

## Non-goals

- Migration tool from Orchestration to Direct provider.
- Content filtering in Direct provider (consumer responsibility).
- Embedder token counts from API (use estimation until providers expose this).
- Changes to existing `sap-core-ai` Orchestration provider.
- Full model discovery for `sap-ai-core-direct` on day one.

## Acceptance criteria

- `RequestSummary.byCategory` is populated for request-scoped LLM activity without breaking existing `byModel` and `byComponent` outputs.
- Empty `byComponent` root cause is diagnosed and covered by a test reproducing the original failure mode.
- Estimated embedding tokens are clearly marked with `estimated: true` and never included in client-facing `usage`.
- `/v1/usage` clearly distinguishes estimated initialization tokens from exact request-time LLM usage.
- Startup vectorization performs batched embedding when the embedder supports it and falls back safely when it does not.
- Batched embedding preserves idempotent `metadata.id` replacement semantics in vector-backed stores.
- Runtime embedding, if logged, is stored as request-scoped rather than initialization-scoped.
- `sap-ai-core-direct` supports chat, streaming, and tool-calling paths expected by the current adapter stack.
- Switching from `sap-ai-sdk` to `sap-ai-core-direct` requires only provider config changes, not application code changes.

## Risks

- Estimated embedding tokens may be misread as billable usage if the API output is not clearly labeled.
- Batch embedding may increase retry blast radius: one failed request can affect many pending vectors.
- Precomputed-vector write paths can drift from normal `upsert()` behavior if logic is duplicated.
- Direct SAP inference may differ from orchestration in safety filters, request shaping, or tool-call edge cases.
- Caching deployment URLs for too long may break after redeployments unless refresh-on-error is implemented.

## Rollout stages

1. Diagnose #53 root cause; add `byCategory`, `TokenBucket`, and `estimated` flag without changing client `usage`.
2. Add `IEmbedderBatch` plus provider implementations with chunking/fallback.
3. Add `IPrecomputedVectorRag` with shared `upsertKnownVector()` write path.
4. Switch builder startup vectorization to batch mode.
5. Introduce `sap-ai-core-direct` behind explicit opt-in provider name.
6. Compare direct vs orchestration token counts and tool-calling parity before broader adoption.
