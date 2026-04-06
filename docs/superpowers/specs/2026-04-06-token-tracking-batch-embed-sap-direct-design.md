# Design: Token Categorization, Batch Embedding & SAP AI Core Direct Provider

Covers GitHub issues: #52, #53, #54

## Problem Statement

Three related issues around token tracking and performance:

1. **#53** — `byComponent` in session logs is empty `{}`. While the single `DefaultRequestLogger` instance is correctly shared across classifier and tool-loop, the summary lacks a higher-level categorization that separates initialization, auxiliary, and request tokens.
2. **#52** — 146 sequential `embed()` calls at startup → 146 HTTP requests → ~2.5 min with throttling. All three embedding providers (OpenAI, Ollama, SAP AI Core) support array input natively.
3. **#54** — SAP AI Core Orchestration Service adds ~14K phantom tokens per request via internal prompt wrapping. A direct inference provider would yield accurate token counts.

## Design

### 1. Token Categorization (#53)

#### New types in `interfaces/request-logger.ts`

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

#### Changes to `RequestSummary`

Add `byCategory` field:

```typescript
export interface RequestSummary {
  byModel: Record<string, TokenBucket>;
  byComponent: Record<string, TokenBucket>;
  byCategory: Record<TokenCategory, TokenBucket>;  // NEW
  ragQueries: number;
  toolCalls: number;
  totalDurationMs: number;
}
```

Where `TokenBucket` is extracted to reduce repetition:

```typescript
interface TokenBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}
```

#### Component-to-category mapping in `DefaultRequestLogger`

A static map inside `getSummary()` derives `byCategory` from existing `byComponent` data. No changes to call sites — the mapping is internal to the logger.

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

#### Embedding token tracking

Add `'embedding'` to `LlmComponent` type. In `builder.ts` tool vectorization loop, call `requestLogger.logLlmCall()` with `component: 'embedding'` after each embed call (or batch call). Since embedders don't return token counts, estimate from text length: `Math.ceil(text.length / 4)` (standard ~4 chars/token approximation).

#### Separate initialization tokens from per-request

`RequestSummary.byCategory.initialization` accumulates during startup. `startRequest()` must NOT reset initialization entries — only reset `auxiliary` and `request` categories. This requires splitting internal storage:

- `initLlmCalls: LlmCallEntry[]` — never reset
- `requestLlmCalls: LlmCallEntry[]` — reset on `startRequest()`

`getSummary()` merges both arrays for aggregation.

#### Exclude embedder tokens from client-facing usage

In `tool-loop.ts` final response (line 463-474), the `usage` object sent to clients should only include `request` + `auxiliary` categories. `initialization` is logged to session log but excluded from the OpenAI-protocol `usage` field.

### 2. Batch Embedding (#52)

#### New interface in `interfaces/rag.ts`

```typescript
export interface IEmbedderBatch extends IEmbedder {
  embedBatch(texts: string[], options?: CallOptions): Promise<number[][]>;
}
```

`IEmbedderBatch` extends `IEmbedder` — every batch embedder is also a single embedder. This preserves backward compatibility: existing code using `IEmbedder` works unchanged.

#### Type guard

```typescript
export function isBatchEmbedder(e: IEmbedder): e is IEmbedderBatch {
  return 'embedBatch' in e && typeof (e as any).embedBatch === 'function';
}
```

#### Implementations

**OpenAiEmbedder** — add `embedBatch()`:
- POST `{ model, input: texts[] }` → response `{ data: [{ embedding }] }` sorted by `index`
- Same retry logic as `embed()`
- Chunk into batches of 100 (OpenAI limit) if `texts.length > 100`

**OllamaEmbedder** — add `embedBatch()`:
- Ollama `/api/embed` endpoint accepts `{ model, input: string[] }` → `{ embeddings: number[][] }`
- Use `/api/embed` (not `/api/embeddings` which is single-only)

**SapAiCoreEmbedder** — add `embedBatch()`:
- `OrchestrationEmbeddingClient.embed({ input: texts[] })` → `EmbeddingData[]` sorted by `index`

**CircuitBreakerEmbedder** — proxy `embedBatch()` if inner supports it.

#### Builder changes

In `builder.ts` tool vectorization (lines 698-718), replace the sequential loop:

```typescript
if (isBatchEmbedder(embedder)) {
  const texts = tools.map(t => `Tool: ${t.name} — ${t.description}`);
  const vectors = await embedder.embedBatch(texts);
  for (let i = 0; i < tools.length; i++) {
    await toolStore.upsertWithVector(texts[i], vectors[i], { id: `tool:${tools[i].name}` });
  }
} else {
  // existing sequential loop with throttling
}
```

This requires a new `upsertWithVector(text, vector, metadata)` method on `IRag` to skip re-embedding. Alternatively, add a `VectorRag.upsertPrecomputed()` method.

#### IRag extension

Add optional method to `IRag`:

```typescript
export interface IRag {
  upsert(text: string, metadata?: Record<string, unknown>, options?: CallOptions): Promise<Result<void, RagError>>;
  upsertPrecomputed?(text: string, vector: number[], metadata?: Record<string, unknown>): Promise<Result<void, RagError>>;
  query(...): Promise<Result<RagResult[], RagError>>;
}
```

`VectorRag` and `QdrantRag` implement `upsertPrecomputed`. `InMemoryRag` and `FallbackRag` ignore vector (store text only).

### 3. SAP AI Core Direct Provider (#54)

#### New provider: `sap-ai-core-direct`

**File:** `src/llm-providers/sap-ai-core-direct.ts`

Uses `resolveDeploymentUrl()` from `@sap-ai-sdk/ai-api` to get the model's inference endpoint, then sends OpenAI-compatible HTTP requests directly — bypassing OrchestrationClient entirely.

#### Architecture

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

Cache `resolveDeploymentUrl()` result for the lifetime of the provider instance. Deployment URLs are stable — they only change on redeployment.

#### Agent: `SapCoreAiDirectAgent`

Extends `OpenAIAgent` (not `SapCoreAIAgent`) since the direct API is OpenAI-compatible. No custom tool conversion needed.

#### Configuration

```yaml
llm:
  provider: sap-ai-core-direct
  model: gpt-4o
  resourceGroup: default
```

New env var: `SAP_AI_DIRECT_PROVIDER=true` (or YAML `provider: sap-ai-core-direct`).

#### Provider registration

Add to `providers.ts` factory map alongside existing providers. Builder resolves by name.

## Data Flow

### Token tracking flow (per request)

```
startup:
  builder.ts → embedBatch() → requestLogger.logLlmCall({ component: 'embedding' })
  → stored in initLlmCalls[] (never reset)

per request:
  startRequest() → reset requestLlmCalls[] only
  classifier → logLlmCall({ component: 'classifier' }) → requestLlmCalls[]
  translate → logLlmCall({ component: 'translate' }) → requestLlmCalls[]
  tool-loop → logLlmCall({ component: 'tool-loop' }) → requestLlmCalls[]
  getSummary() → merge initLlmCalls + requestLlmCalls → byCategory, byComponent, byModel
```

### Batch embedding flow (startup)

```
builder.ts:
  tools = mcpClient.listTools()              // 146 tools
  if isBatchEmbedder(embedder):
    texts = tools.map(formatToolText)         // 146 strings
    vectors = embedder.embedBatch(texts)      // 1 HTTP request
    for each (text, vector, tool):
      toolStore.upsertPrecomputed(text, vector, { id: `tool:${tool.name}` })
  else:
    // existing sequential loop with 5/500ms throttling
```

## Files to Change

| File | Change |
|------|--------|
| `src/smart-agent/interfaces/request-logger.ts` | Add `TokenCategory`, `TokenBucket`, `byCategory` to `RequestSummary`, add `'embedding'` to `LlmComponent` |
| `src/smart-agent/logger/default-request-logger.ts` | Split storage into init/request arrays, implement `byCategory` aggregation |
| `src/smart-agent/logger/noop-request-logger.ts` | Return empty `byCategory` |
| `src/smart-agent/interfaces/rag.ts` | Add `IEmbedderBatch`, `isBatchEmbedder()`, optional `upsertPrecomputed` on `IRag` |
| `src/smart-agent/rag/openai-embedder.ts` | Implement `IEmbedderBatch` |
| `src/smart-agent/rag/ollama-rag.ts` | Implement `IEmbedderBatch` |
| `src/smart-agent/rag/sap-ai-core-embedder.ts` | Implement `IEmbedderBatch` |
| `src/smart-agent/rag/vector-rag.ts` | Add `upsertPrecomputed()` |
| `src/smart-agent/rag/qdrant-rag.ts` | Add `upsertPrecomputed()` |
| `src/smart-agent/resilience/circuit-breaker-embedder.ts` | Proxy `embedBatch()` |
| `src/smart-agent/resilience/fallback-rag.ts` | Proxy `upsertPrecomputed()` |
| `src/smart-agent/builder.ts` | Use batch embedding when available, log embedding tokens |
| `src/smart-agent/pipeline/handlers/tool-loop.ts` | Exclude initialization tokens from client usage |
| `src/llm-providers/sap-ai-core-direct.ts` | **NEW** — Direct inference provider |
| `src/agents/sap-core-ai-direct-agent.ts` | **NEW** — Agent extending OpenAIAgent |
| `src/smart-agent/providers.ts` | Register `sap-ai-core-direct` provider factory |
| `src/index.ts` | Export new types and classes |

## Non-goals

- Migration tool from Orchestration to Direct provider
- Content filtering in Direct provider (consumer responsibility)
- Embedder token counts from API (use estimation until providers expose this)
- Changes to existing `sap-core-ai` Orchestration provider
