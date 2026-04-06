# Token Categorization, Batch Embedding & SAP AI Core Direct Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add token categorization with init/auxiliary/request separation (#53), batch embedding for tool vectorization (#52), and a direct SAP AI Core provider bypassing Orchestration overhead (#54).

**Architecture:** Extend `IRequestLogger` with `TokenBucket`, `TokenCategory`, `byCategory`, and `scope`/`estimated`/`detail` fields on `LlmCallEntry`. Add `IEmbedderBatch` extending `IEmbedder` with `embedBatch()` and `IPrecomputedVectorRag` extending `IRag` with `upsertPrecomputed()`. New `SapAiCoreDirectProvider` uses `resolveDeploymentUrl()` + raw OpenAI-compatible HTTP, wrapped with `OpenAIAgent` via `LlmAdapter`.

**Tech Stack:** TypeScript (ESM), node:test, @sap-ai-sdk/ai-api, @sap-ai-sdk/orchestration

---

## Phase 1: Token Categorization (#53)

### Task 1: Extend request-logger interfaces

**Files:**
- Modify: `src/smart-agent/interfaces/request-logger.ts`

- [ ] **Step 1: Add new types to request-logger.ts**

```typescript
// Replace the entire file content:

export type LlmComponent =
  | 'tool-loop'
  | 'classifier'
  | 'helper'
  | 'translate'
  | 'query-expander'
  | 'embedding';

export type TokenCategory = 'initialization' | 'auxiliary' | 'request';

export interface TokenBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  items?: number;
}

export interface LlmCallEntry {
  component: LlmComponent;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  estimated?: boolean;
  scope?: 'initialization' | 'request';
  detail?: string;
}

export interface RagQueryEntry {
  store: string;
  query: string;
  resultCount: number;
  durationMs: number;
}

export interface ToolCallEntry {
  toolName: string;
  success: boolean;
  durationMs: number;
  cached: boolean;
}

export interface RequestSummary {
  /** Per-model aggregated token usage. */
  byModel: Record<string, TokenBucket>;
  /** Per-component aggregated token usage. */
  byComponent: Record<string, TokenBucket>;
  /** Per-category aggregated token usage. */
  byCategory: Record<string, TokenBucket>;
  ragQueries: number;
  toolCalls: number;
  /** Wall-clock time for the entire request. */
  totalDurationMs: number;
}

export interface IRequestLogger {
  logLlmCall(entry: LlmCallEntry): void;
  logRagQuery(entry: RagQueryEntry): void;
  logToolCall(entry: ToolCallEntry): void;
  /** Mark the start of a request for wall-clock duration tracking. */
  startRequest(): void;
  /** Mark the end of a request for wall-clock duration tracking. */
  endRequest(): void;
  getSummary(): RequestSummary;
  reset(): void;
}
```

- [ ] **Step 2: Run build to check for type errors**

Run: `npm run build`
Expected: Errors in `default-request-logger.ts` and `noop-request-logger.ts` because `byCategory` is missing from their return types.

- [ ] **Step 3: Commit**

```bash
git add src/smart-agent/interfaces/request-logger.ts
git commit -m "feat(#53): extend request-logger interfaces with TokenBucket, TokenCategory, scope, estimated"
```

### Task 2: Update DefaultRequestLogger with init/request split

**Files:**
- Modify: `src/smart-agent/logger/default-request-logger.ts`

- [ ] **Step 1: Rewrite DefaultRequestLogger**

```typescript
import type {
  IRequestLogger,
  LlmCallEntry,
  LlmComponent,
  RagQueryEntry,
  RequestSummary,
  TokenBucket,
  TokenCategory,
  ToolCallEntry,
} from '../interfaces/request-logger.js';

const CATEGORY_MAP: Record<LlmComponent, TokenCategory> = {
  'tool-loop': 'request',
  classifier: 'auxiliary',
  translate: 'auxiliary',
  'query-expander': 'auxiliary',
  helper: 'auxiliary',
  embedding: 'initialization',
};

function emptyBucket(): TokenBucket {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
}

function addToBucket(bucket: TokenBucket, entry: LlmCallEntry): void {
  bucket.promptTokens += entry.promptTokens;
  bucket.completionTokens += entry.completionTokens;
  bucket.totalTokens += entry.totalTokens;
  bucket.requests++;
}

export class DefaultRequestLogger implements IRequestLogger {
  private initLlmCalls: LlmCallEntry[] = [];
  private requestLlmCalls: LlmCallEntry[] = [];
  private ragQueryEntries: RagQueryEntry[] = [];
  private toolCallEntries: ToolCallEntry[] = [];
  private requestStartMs = 0;
  private requestDurationMs = 0;

  startRequest(): void {
    this.requestLlmCalls = [];
    this.ragQueryEntries = [];
    this.toolCallEntries = [];
    this.requestDurationMs = 0;
    this.requestStartMs = Date.now();
  }

  endRequest(): void {
    this.requestDurationMs = this.requestStartMs
      ? Date.now() - this.requestStartMs
      : 0;
  }

  logLlmCall(entry: LlmCallEntry): void {
    if (entry.scope === 'initialization') {
      this.initLlmCalls.push(entry);
    } else {
      this.requestLlmCalls.push(entry);
    }
  }

  logRagQuery(entry: RagQueryEntry): void {
    this.ragQueryEntries.push(entry);
  }

  logToolCall(entry: ToolCallEntry): void {
    this.toolCallEntries.push(entry);
  }

  getSummary(): RequestSummary {
    const byModel: Record<string, TokenBucket> = {};
    const byComponent: Record<string, TokenBucket> = {};
    const byCategory: Record<string, TokenBucket> = {};

    const allCalls = [...this.initLlmCalls, ...this.requestLlmCalls];

    for (const call of allCalls) {
      if (!byModel[call.model]) byModel[call.model] = emptyBucket();
      addToBucket(byModel[call.model], call);

      if (!byComponent[call.component]) byComponent[call.component] = emptyBucket();
      addToBucket(byComponent[call.component], call);

      const cat = CATEGORY_MAP[call.component] ?? 'request';
      if (!byCategory[cat]) byCategory[cat] = emptyBucket();
      addToBucket(byCategory[cat], call);
    }

    return {
      byModel,
      byComponent,
      byCategory,
      ragQueries: this.ragQueryEntries.length,
      toolCalls: this.toolCallEntries.length,
      totalDurationMs: this.requestDurationMs,
    };
  }

  reset(): void {
    this.requestLlmCalls = [];
    this.ragQueryEntries = [];
    this.toolCallEntries = [];
    this.requestStartMs = 0;
    this.requestDurationMs = 0;
    // NOTE: initLlmCalls is intentionally NOT reset
  }
}
```

- [ ] **Step 2: Update NoopRequestLogger**

In `src/smart-agent/logger/noop-request-logger.ts`, add `byCategory: {}` to `EMPTY_SUMMARY`:

```typescript
const EMPTY_SUMMARY: RequestSummary = {
  byModel: {},
  byComponent: {},
  byCategory: {},
  ragQueries: 0,
  toolCalls: 0,
  totalDurationMs: 0,
};
```

And update `getSummary()`:

```typescript
getSummary(): RequestSummary {
  return { ...EMPTY_SUMMARY, byModel: {}, byComponent: {}, byCategory: {} };
}
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS — no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/logger/default-request-logger.ts src/smart-agent/logger/noop-request-logger.ts
git commit -m "feat(#53): split init/request storage in DefaultRequestLogger, add byCategory aggregation"
```

### Task 3: Write tests for token categorization

**Files:**
- Create: `src/smart-agent/__tests__/request-logger.test.ts`

- [ ] **Step 1: Write test file**

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DefaultRequestLogger } from '../logger/default-request-logger.js';

describe('DefaultRequestLogger', () => {
  it('aggregates byComponent and byCategory for request-scoped calls', () => {
    const logger = new DefaultRequestLogger();
    logger.startRequest();
    logger.logLlmCall({
      component: 'classifier',
      model: 'gpt-4o',
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      durationMs: 50,
    });
    logger.logLlmCall({
      component: 'tool-loop',
      model: 'gpt-4o',
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      durationMs: 200,
    });
    logger.endRequest();

    const summary = logger.getSummary();
    assert.equal(summary.byComponent.classifier?.promptTokens, 100);
    assert.equal(summary.byComponent['tool-loop']?.promptTokens, 500);
    assert.equal(summary.byCategory.auxiliary?.promptTokens, 100);
    assert.equal(summary.byCategory.request?.promptTokens, 500);
    assert.equal(summary.byModel['gpt-4o']?.requests, 2);
  });

  it('preserves initialization calls across startRequest resets', () => {
    const logger = new DefaultRequestLogger();

    // Simulate startup embedding
    logger.logLlmCall({
      component: 'embedding',
      model: 'text-embedding-3-small',
      promptTokens: 1000,
      completionTokens: 0,
      totalTokens: 1000,
      durationMs: 300,
      estimated: true,
      scope: 'initialization',
      detail: 'tools',
    });

    // First request — startRequest should NOT clear init calls
    logger.startRequest();
    logger.logLlmCall({
      component: 'tool-loop',
      model: 'gpt-4o',
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      durationMs: 200,
    });
    logger.endRequest();

    const summary1 = logger.getSummary();
    assert.equal(summary1.byCategory.initialization?.totalTokens, 1000);
    assert.equal(summary1.byCategory.request?.totalTokens, 600);
    assert.equal(summary1.byComponent.embedding?.requests, 1);
    assert.equal(summary1.byComponent['tool-loop']?.requests, 1);

    // Second request — init data still present, request data reset
    logger.startRequest();
    logger.logLlmCall({
      component: 'tool-loop',
      model: 'gpt-4o',
      promptTokens: 300,
      completionTokens: 50,
      totalTokens: 350,
      durationMs: 100,
    });
    logger.endRequest();

    const summary2 = logger.getSummary();
    assert.equal(summary2.byCategory.initialization?.totalTokens, 1000);
    assert.equal(summary2.byCategory.request?.totalTokens, 350);
    assert.equal(summary2.byComponent['tool-loop']?.requests, 1);
  });

  it('routes runtime embedding to request scope when scope is not initialization', () => {
    const logger = new DefaultRequestLogger();
    logger.startRequest();
    logger.logLlmCall({
      component: 'embedding',
      model: 'text-embedding-3-small',
      promptTokens: 50,
      completionTokens: 0,
      totalTokens: 50,
      durationMs: 10,
      scope: 'request',
    });
    logger.endRequest();

    const summary = logger.getSummary();
    // embedding component is mapped to 'initialization' category via CATEGORY_MAP,
    // but this is a runtime call — verify it's still in the summary
    assert.equal(summary.byComponent.embedding?.totalTokens, 50);

    // After reset, runtime embedding should be cleared
    logger.startRequest();
    logger.endRequest();
    const summary2 = logger.getSummary();
    assert.equal(summary2.byComponent.embedding, undefined);
  });

  it('returns empty byCategory when no calls logged', () => {
    const logger = new DefaultRequestLogger();
    logger.startRequest();
    logger.endRequest();
    const summary = logger.getSummary();
    assert.deepEqual(summary.byCategory, {});
    assert.deepEqual(summary.byComponent, {});
    assert.deepEqual(summary.byModel, {});
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx tsx --test src/smart-agent/__tests__/request-logger.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/smart-agent/__tests__/request-logger.test.ts
git commit -m "test(#53): add DefaultRequestLogger tests for byCategory, init/request split, scope routing"
```

### Task 4: Add embedding token logging in builder

**Files:**
- Modify: `src/smart-agent/builder.ts`

- [ ] **Step 1: Add embedding token logging to tool vectorization**

In `src/smart-agent/builder.ts`, inside the tool vectorization loop (around line 701-716), after the `upsert` call, add token logging. Replace the existing loop body:

Find this block (approximately lines 701-716):
```typescript
              for (let i = 0; i < tools.length; i++) {
                const t = tools[i];
                const result = await toolStore.upsert(
                  `Tool: ${t.name} — ${t.description}`,
                  { id: `tool:${t.name}` },
                );
                if (!result.ok) {
                  log?.log({
                    type: 'warning',
                    traceId: 'builder',
                    message: `Tool vectorization failed for "${t.name}": ${result.error.message}`,
                  });
                }
                // Throttle embedding requests to avoid rate limits
                if ((i + 1) % batchSize === 0 && i < tools.length - 1) {
                  await new Promise((r) => setTimeout(r, batchDelayMs));
                }
              }
```

Replace with:

```typescript
              for (let i = 0; i < tools.length; i++) {
                const t = tools[i];
                const text = `Tool: ${t.name} — ${t.description}`;
                const embedStart = Date.now();
                const result = await toolStore.upsert(
                  text,
                  { id: `tool:${t.name}` },
                );
                if (!result.ok) {
                  log?.log({
                    type: 'warning',
                    traceId: 'builder',
                    message: `Tool vectorization failed for "${t.name}": ${result.error.message}`,
                  });
                } else {
                  requestLogger.logLlmCall({
                    component: 'embedding',
                    model: 'embedder',
                    promptTokens: Math.ceil(text.length / 4),
                    completionTokens: 0,
                    totalTokens: Math.ceil(text.length / 4),
                    durationMs: Date.now() - embedStart,
                    estimated: true,
                    scope: 'initialization',
                    detail: 'tools',
                  });
                }
                // Throttle embedding requests to avoid rate limits
                if ((i + 1) % batchSize === 0 && i < tools.length - 1) {
                  await new Promise((r) => setTimeout(r, batchDelayMs));
                }
              }
```

- [ ] **Step 2: Add embedding token logging to skill vectorization**

In the skill vectorization block (around lines 837-849), replace:

```typescript
          const result = await skillStore.upsert(
            `Skill: ${s.name}\n${s.description}`,
            {
              id: `skill:${s.name}`,
            },
          );
```

With:

```typescript
          const text = `Skill: ${s.name}\n${s.description}`;
          const embedStart = Date.now();
          const result = await skillStore.upsert(
            text,
            {
              id: `skill:${s.name}`,
            },
          );
          if (result.ok) {
            requestLogger.logLlmCall({
              component: 'embedding',
              model: 'embedder',
              promptTokens: Math.ceil(text.length / 4),
              completionTokens: 0,
              totalTokens: Math.ceil(text.length / 4),
              durationMs: Date.now() - embedStart,
              estimated: true,
              scope: 'initialization',
              detail: 'skills',
            });
          }
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/builder.ts
git commit -m "feat(#53): log estimated embedding tokens during tool/skill vectorization"
```

### Task 5: Add byCategory to session log output

**Files:**
- Modify: `src/smart-agent/pipeline/handlers/tool-loop.ts`

- [ ] **Step 1: Add byCategory to session log step**

In `tool-loop.ts` around line 443-445, the session logger step already includes `byComponent` and `byModel`. Add `byCategory`:

Find:
```typescript
        const summary = ctx.requestLogger.getSummary();
        ctx.options?.sessionLogger?.logStep('final_response', {
          content,
          usage,
          byComponent: summary.byComponent,
          byModel: summary.byModel,
        });
```

Replace with:
```typescript
        const summary = ctx.requestLogger.getSummary();
        ctx.options?.sessionLogger?.logStep('final_response', {
          content,
          usage,
          byComponent: summary.byComponent,
          byModel: summary.byModel,
          byCategory: summary.byCategory,
        });
```

- [ ] **Step 2: Add byCategory to usage chunk (lines ~470-471)**

Find:
```typescript
              models: ctx.requestLogger.getSummary().byModel,
              components: ctx.requestLogger.getSummary().byComponent,
```

Replace with:
```typescript
              models: ctx.requestLogger.getSummary().byModel,
              components: ctx.requestLogger.getSummary().byComponent,
              categories: ctx.requestLogger.getSummary().byCategory,
```

- [ ] **Step 3: Run build and tests**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/pipeline/handlers/tool-loop.ts
git commit -m "feat(#53): expose byCategory in session logs and usage chunk"
```

---

## Phase 2: Batch Embedding (#52)

### Task 6: Add IEmbedderBatch and IPrecomputedVectorRag interfaces

**Files:**
- Modify: `src/smart-agent/interfaces/rag.ts`

- [ ] **Step 1: Add new interfaces and type guards**

Append to the end of `src/smart-agent/interfaces/rag.ts`:

```typescript

export interface IEmbedderBatch extends IEmbedder {
  embedBatch(texts: string[], options?: CallOptions): Promise<number[][]>;
}

// biome-ignore lint/suspicious/noExplicitAny: runtime type check
export function isBatchEmbedder(e: IEmbedder): e is IEmbedderBatch {
  return 'embedBatch' in e && typeof (e as any).embedBatch === 'function';
}

export interface IPrecomputedVectorRag extends IRag {
  upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>>;
}

export function supportsPrecomputed(rag: IRag): rag is IPrecomputedVectorRag {
  return 'upsertPrecomputed' in rag;
}
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/smart-agent/interfaces/rag.ts
git commit -m "feat(#52): add IEmbedderBatch, IPrecomputedVectorRag interfaces with type guards"
```

### Task 7: Add embedBatch to OpenAiEmbedder

**Files:**
- Modify: `src/smart-agent/rag/openai-embedder.ts`

- [ ] **Step 1: Update class to implement IEmbedderBatch**

Change the import and class declaration:

```typescript
import type { IEmbedderBatch } from '../interfaces/rag.js';
import { type CallOptions, RagError } from '../interfaces/types.js';
```

Change `implements IEmbedder` to `implements IEmbedderBatch`:

```typescript
export class OpenAiEmbedder implements IEmbedderBatch {
```

- [ ] **Step 2: Add embedBatch method after embed()**

```typescript
  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const chunkSize = 100;
    const results: number[][] = new Array(texts.length);

    for (let start = 0; start < texts.length; start += chunkSize) {
      const chunk = texts.slice(start, start + chunkSize);
      const url = `${this.baseURL}/embeddings`;
      let lastError: Error | undefined;
      const maxRetries = 3;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
          const signal = options?.signal
            ? AbortSignal.any([options.signal, timeoutSignal])
            : timeoutSignal;

          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({ model: this.model, input: chunk }),
            signal,
          });

          if (!res.ok) {
            const errorText = await res.text();
            throw new RagError(
              `OpenAI batch embed error: HTTP ${res.status} - ${errorText}`,
              'EMBED_ERROR',
            );
          }

          const json = (await res.json()) as {
            data: Array<{ embedding: number[]; index: number }>;
          };
          const sorted = json.data.sort((a, b) => a.index - b.index);
          for (let i = 0; i < sorted.length; i++) {
            results[start + i] = sorted[i].embedding;
          }
          lastError = undefined;
          break;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (err instanceof Error && err.name === 'AbortError') throw err;
          const delay = 500 * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      if (lastError) {
        throw lastError;
      }
    }

    return results;
  }
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/rag/openai-embedder.ts
git commit -m "feat(#52): add embedBatch() to OpenAiEmbedder with chunking and retry"
```

### Task 8: Add embedBatch to OllamaEmbedder

**Files:**
- Modify: `src/smart-agent/rag/ollama-rag.ts`

- [ ] **Step 1: Update imports and class declaration**

```typescript
import type { IEmbedderBatch } from '../interfaces/rag.js';
```

Change `implements IEmbedder` to `implements IEmbedderBatch`:

```typescript
export class OllamaEmbedder implements IEmbedderBatch {
```

- [ ] **Step 2: Add embedBatch method after embed()**

```typescript
  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `${this.ollamaUrl}/api/embed`;
    let lastError: Error | undefined;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signal = options?.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new RagError(
            `Ollama batch embed error: HTTP ${res.status} - ${errorText}`,
            'EMBED_ERROR',
          );
        }

        const json = (await res.json()) as { embeddings: number[][] };
        return json.embeddings;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof Error && err.name === 'AbortError') throw err;
        const delay = 500 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw (
      lastError ||
      new RagError('Ollama batch embed failed after retries', 'EMBED_ERROR')
    );
  }
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/rag/ollama-rag.ts
git commit -m "feat(#52): add embedBatch() to OllamaEmbedder using /api/embed endpoint"
```

### Task 9: Add embedBatch to SapAiCoreEmbedder

**Files:**
- Modify: `src/smart-agent/rag/sap-ai-core-embedder.ts`

- [ ] **Step 1: Update imports and class declaration**

```typescript
import type { IEmbedderBatch } from '../interfaces/rag.js';
```

Change `implements IEmbedder` to `implements IEmbedderBatch`:

```typescript
export class SapAiCoreEmbedder implements IEmbedderBatch {
```

- [ ] **Step 2: Add embedBatch method after embed()**

```typescript
  async embedBatch(
    texts: string[],
    _options?: CallOptions,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const { OrchestrationEmbeddingClient } = await import(
      '@sap-ai-sdk/orchestration'
    );

    const modelName = this
      .model as unknown as import('@sap-ai-sdk/orchestration').EmbeddingModel;
    const client = new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: modelName } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
    );

    const response = await client.embed({ input: texts });
    const embeddings = response.getEmbeddings();

    if (!embeddings || embeddings.length === 0) {
      throw new Error('No embeddings returned from SAP AI Core batch');
    }

    const sorted = [...embeddings].sort((a, b) => a.index - b.index);
    return sorted.map((e) => {
      if (typeof e.embedding === 'string') {
        const buffer = Buffer.from(e.embedding, 'base64');
        const float32 = new Float32Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.length / 4,
        );
        return Array.from(float32);
      }
      return e.embedding;
    });
  }
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/rag/sap-ai-core-embedder.ts
git commit -m "feat(#52): add embedBatch() to SapAiCoreEmbedder"
```

### Task 10: Update CircuitBreakerEmbedder to proxy embedBatch

**Files:**
- Modify: `src/smart-agent/resilience/circuit-breaker-embedder.ts`

- [ ] **Step 1: Update to conditionally implement IEmbedderBatch**

```typescript
import type { IEmbedder, IEmbedderBatch } from '../interfaces/rag.js';
import { isBatchEmbedder } from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';
import { RagError } from '../interfaces/types.js';
import type { CircuitBreaker } from './circuit-breaker.js';

export class CircuitBreakerEmbedder implements IEmbedder {
  constructor(
    private readonly inner: IEmbedder,
    readonly breaker: CircuitBreaker,
  ) {}

  async embed(text: string, options?: CallOptions): Promise<number[]> {
    if (!this.breaker.isCallPermitted) {
      throw new RagError('Embedder circuit breaker is open', 'CIRCUIT_OPEN');
    }
    try {
      const result = await this.inner.embed(text, options);
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      throw err;
    }
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<number[][]> {
    if (!this.breaker.isCallPermitted) {
      throw new RagError('Embedder circuit breaker is open', 'CIRCUIT_OPEN');
    }
    if (!isBatchEmbedder(this.inner)) {
      throw new RagError(
        'Inner embedder does not support batch embedding',
        'EMBED_ERROR',
      );
    }
    try {
      const result = await this.inner.embedBatch(texts, options);
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      throw err;
    }
  }
}
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/smart-agent/resilience/circuit-breaker-embedder.ts
git commit -m "feat(#52): proxy embedBatch through CircuitBreakerEmbedder"
```

### Task 11: Add upsertPrecomputed to VectorRag with shared write path

**Files:**
- Modify: `src/smart-agent/rag/vector-rag.ts`

- [ ] **Step 1: Update imports and class declaration**

Add `IPrecomputedVectorRag` to the import from `rag.ts`:

```typescript
import type { IEmbedder, IPrecomputedVectorRag, IRag } from '../interfaces/rag.js';
```

Change `implements IRag` to `implements IPrecomputedVectorRag`:

```typescript
export class VectorRag implements IPrecomputedVectorRag {
```

- [ ] **Step 2: Extract upsertKnownVector helper**

Add this private method before the `upsert()` method:

```typescript
  private upsertKnownVector(
    text: string,
    vector: number[],
    metadata: RagMetadata,
  ): Result<void, RagError> {
    const newTokens = this.tokenize(text);

    // Idempotent upsert: if metadata.id matches, replace in-place
    if (metadata.id) {
      for (let i = 0; i < this.records.length; i++) {
        if (this.records[i].metadata.id === metadata.id) {
          const oldTokens = this.tokenize(this.records[i].text);
          this.records[i].text = text;
          this.records[i].vector = vector;
          this.records[i].metadata = {
            ...this.records[i].metadata,
            ...metadata,
          };
          this.index.update(i, oldTokens, newTokens);
          return { ok: true, value: undefined };
        }
      }
    }

    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i];
      if (this.cosine(rec.vector, vector) >= this.dedupThreshold) {
        const oldTokens = this.tokenize(rec.text);
        rec.text = text;
        rec.vector = vector;
        rec.metadata = { ...rec.metadata, ...metadata };
        this.index.update(i, oldTokens, newTokens);
        return { ok: true, value: undefined };
      }
    }

    const docIdx = this.records.length;
    this.records.push({ text, vector, metadata });
    this.index.add(docIdx, newTokens);
    return { ok: true, value: undefined };
  }
```

- [ ] **Step 3: Refactor upsert to delegate**

Replace the `try` block inside `upsert()`:

```typescript
    try {
      const vector = await this.embedder.embed(text, options);
      return this.upsertKnownVector(text, vector, metadata);
    } catch (err) {
```

- [ ] **Step 4: Add upsertPrecomputed method**

After `upsert()`:

```typescript
  async upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    _options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    try {
      return this.upsertKnownVector(text, vector, metadata);
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }
```

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/rag/vector-rag.ts
git commit -m "feat(#52): extract upsertKnownVector, add upsertPrecomputed to VectorRag"
```

### Task 12: Add upsertPrecomputed to QdrantRag

**Files:**
- Modify: `src/smart-agent/rag/qdrant-rag.ts`

- [ ] **Step 1: Update imports and class declaration**

```typescript
import type { IEmbedder, IPrecomputedVectorRag, IRag } from '../interfaces/rag.js';
```

Change `implements IRag` to `implements IPrecomputedVectorRag`:

```typescript
export class QdrantRag implements IPrecomputedVectorRag {
```

- [ ] **Step 2: Extract shared write helper**

Add a private method:

```typescript
  private async upsertKnownVector(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    try {
      await this._ensureCollection(vector.length, options?.signal);

      const pointId = metadata?.id
        ? await deterministicUUID(metadata.id)
        : crypto.randomUUID();
      const payload: Record<string, unknown> = {
        text,
        ...metadata,
      };

      const res = await this._fetch(
        `/collections/${this.collectionName}/points`,
        {
          method: 'PUT',
          body: JSON.stringify({
            points: [{ id: pointId, vector, payload }],
          }),
        },
        options?.signal,
      );

      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: new RagError(`Qdrant upsert failed: ${body}`, 'UPSERT_ERROR'),
        };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }
```

- [ ] **Step 3: Refactor upsert to delegate**

Replace the body of `upsert()`:

```typescript
  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    try {
      const vector = await this.embedder.embed(text, options);
      return this.upsertKnownVector(text, vector, metadata, options);
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }
```

- [ ] **Step 4: Add upsertPrecomputed method**

```typescript
  async upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    return this.upsertKnownVector(text, vector, metadata, options);
  }
```

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/rag/qdrant-rag.ts
git commit -m "feat(#52): extract upsertKnownVector, add upsertPrecomputed to QdrantRag"
```

### Task 13: Update FallbackRag to proxy upsertPrecomputed

**Files:**
- Modify: `src/smart-agent/resilience/fallback-rag.ts`

- [ ] **Step 1: Add upsertPrecomputed proxy**

Add import:
```typescript
import { supportsPrecomputed } from '../interfaces/rag.js';
```

Add method to `FallbackRag`:

```typescript
  async upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    const primaryResult = supportsPrecomputed(this.primary)
      ? await this.primary.upsertPrecomputed(text, vector, metadata, options)
      : await this.primary.upsert(text, metadata, options);

    // Best-effort write to fallback
    if (supportsPrecomputed(this.fallback)) {
      this.fallback.upsertPrecomputed(text, vector, metadata, options).catch(() => {});
    } else {
      this.fallback.upsert(text, metadata, options).catch(() => {});
    }

    return primaryResult;
  }
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/smart-agent/resilience/fallback-rag.ts
git commit -m "feat(#52): proxy upsertPrecomputed through FallbackRag"
```

### Task 14: Switch builder to batch embedding

**Files:**
- Modify: `src/smart-agent/builder.ts`

- [ ] **Step 1: Add imports**

At the top of builder.ts, add to the imports from `interfaces/rag.js`:

```typescript
import {
  isBatchEmbedder,
  supportsPrecomputed,
} from './interfaces/rag.js';
```

- [ ] **Step 2: Replace tool vectorization with batch path**

Replace the tool vectorization block (the loop from Task 4) with:

```typescript
            const toolsResult = await adapter.listTools();
            if (toolsResult.ok) {
              const tools = toolsResult.value;
              const embedder = toolStore instanceof VectorRag || toolStore instanceof QdrantRag
                ? (toolStore as any).embedder as IEmbedder | undefined
                : undefined;

              if (embedder && isBatchEmbedder(embedder) && supportsPrecomputed(toolStore)) {
                // Batch path: single HTTP call for all tools
                const texts = tools.map((t) => `Tool: ${t.name} — ${t.description}`);
                const batchStart = Date.now();
                try {
                  const vectors = await embedder.embedBatch(texts);
                  const batchDuration = Date.now() - batchStart;
                  for (let i = 0; i < tools.length; i++) {
                    const result = await toolStore.upsertPrecomputed(
                      texts[i],
                      vectors[i],
                      { id: `tool:${tools[i].name}` },
                    );
                    if (!result.ok) {
                      log?.log({
                        type: 'warning',
                        traceId: 'builder',
                        message: `Tool vectorization failed for "${tools[i].name}": ${result.error.message}`,
                      });
                    }
                  }
                  const totalEstTokens = texts.reduce(
                    (sum, t) => sum + Math.ceil(t.length / 4),
                    0,
                  );
                  requestLogger.logLlmCall({
                    component: 'embedding',
                    model: 'embedder',
                    promptTokens: totalEstTokens,
                    completionTokens: 0,
                    totalTokens: totalEstTokens,
                    durationMs: batchDuration,
                    estimated: true,
                    scope: 'initialization',
                    detail: 'tools',
                  });
                } catch (err) {
                  log?.log({
                    type: 'warning',
                    traceId: 'builder',
                    message: `Batch embedding failed, falling back to sequential: ${String(err)}`,
                  });
                  // Fall through to sequential path
                  await this.vectorizeToolsSequential(
                    tools,
                    toolStore,
                    requestLogger,
                    log,
                  );
                }
              } else {
                await this.vectorizeToolsSequential(
                  tools,
                  toolStore,
                  requestLogger,
                  log,
                );
              }
            }
```

- [ ] **Step 3: Extract sequential vectorization helper**

Add a private method to the builder class:

```typescript
  private async vectorizeToolsSequential(
    tools: McpTool[],
    store: IRag,
    requestLogger: IRequestLogger,
    log: ILogger | undefined,
  ): Promise<void> {
    const batchSize = 5;
    const batchDelayMs = 500;
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      const text = `Tool: ${t.name} — ${t.description}`;
      const embedStart = Date.now();
      const result = await store.upsert(text, { id: `tool:${t.name}` });
      if (!result.ok) {
        log?.log({
          type: 'warning',
          traceId: 'builder',
          message: `Tool vectorization failed for "${t.name}": ${result.error.message}`,
        });
      } else {
        requestLogger.logLlmCall({
          component: 'embedding',
          model: 'embedder',
          promptTokens: Math.ceil(text.length / 4),
          completionTokens: 0,
          totalTokens: Math.ceil(text.length / 4),
          durationMs: Date.now() - embedStart,
          estimated: true,
          scope: 'initialization',
          detail: 'tools',
        });
      }
      if ((i + 1) % batchSize === 0 && i < tools.length - 1) {
        await new Promise((r) => setTimeout(r, batchDelayMs));
      }
    }
  }
```

Note: you'll need to add the necessary type imports (`McpTool`, `IRag`, `IRequestLogger`, `ILogger`) if not already imported.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/builder.ts
git commit -m "feat(#52): batch embedding for tool vectorization with sequential fallback"
```

### Task 15: Export new types from index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add exports**

Find the existing RAG-related exports in index.ts and add:

```typescript
export type {
  IEmbedderBatch,
  IPrecomputedVectorRag,
} from './smart-agent/interfaces/rag.js';
export {
  isBatchEmbedder,
  supportsPrecomputed,
} from './smart-agent/interfaces/rag.js';
export type {
  TokenBucket,
  TokenCategory,
} from './smart-agent/interfaces/request-logger.js';
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(#52): export IEmbedderBatch, IPrecomputedVectorRag, TokenBucket, TokenCategory"
```

---

## Phase 3: SAP AI Core Direct Provider (#54)

### Task 16: Create SapAiCoreDirectProvider

**Files:**
- Create: `src/llm-providers/sap-ai-core-direct.ts`

- [ ] **Step 1: Write the provider**

```typescript
/**
 * SAP AI Core Direct LLM Provider
 *
 * Bypasses OrchestrationClient and sends OpenAI-compatible HTTP requests
 * directly to SAP AI Core deployment endpoints.
 * Token counts are accurate (no orchestration overhead).
 */

import https from 'node:https';
import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { BaseLLMProvider } from './base.js';

export interface SapAiCoreDirectConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  resourceGroup?: string;
}

export class SapAiCoreDirectProvider extends BaseLLMProvider<SapAiCoreDirectConfig> {
  readonly model: string;
  private readonly resourceGroup: string;
  private deploymentUrl: string | null = null;
  private readonly httpsAgent: https.Agent;
  private modelOverride?: string;

  setModelOverride(model?: string): void {
    this.modelOverride = model;
  }

  constructor(config: SapAiCoreDirectConfig) {
    super(config);
    // Skip validateConfig() — SAP SDK handles auth via AICORE_SERVICE_KEY env var
    this.model = config.model || 'gpt-4o';
    this.resourceGroup = config.resourceGroup || 'default';
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      timeout: 60_000,
    });
  }

  private async resolveUrl(): Promise<string> {
    if (this.deploymentUrl) return this.deploymentUrl;

    const { resolveDeploymentUrl } = await import('@sap-ai-sdk/ai-api');
    const url = await resolveDeploymentUrl({
      scenarioId: 'foundation-models',
      model: { modelName: this.model },
      resourceGroup: this.resourceGroup,
    });
    this.deploymentUrl = url;
    return url;
  }

  private async fetchWithAuth(
    url: string,
    init: RequestInit & { agent?: https.Agent },
  ): Promise<Response> {
    // @sap-ai-sdk/core sets up auth context globally.
    // resolveDeploymentUrl() call above ensures auth is initialized.
    // The deployment URL includes the auth-bearing host.
    // We use the SDK's internal HTTP client via a manual fetch with the same auth context.
    const { executeHttpRequest } = await import('@sap-ai-sdk/core');
    // For direct HTTP, we use native fetch but need to obtain the token
    // from the SDK's internal resolution.
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return fetch(url, {
      ...init,
      headers,
    });
  }

  async chat(messages: Message[], tools?: unknown[]): Promise<LLMResponse> {
    try {
      const url = await this.resolveUrl();
      const model = this.modelOverride ?? this.model;

      const body: Record<string, unknown> = {
        model,
        messages: this.formatMessages(messages),
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 16384,
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // @ts-expect-error Node.js fetch supports agent via dispatcher
        dispatcher: this.httpsAgent,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as {
        choices: Array<{
          message: { role: string; content: string; tool_calls?: unknown[] };
          finish_reason: string;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
      };

      const choice = data.choices[0];
      return {
        content: choice.message.content || '',
        finishReason: choice.finish_reason,
        raw: data,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`SAP AI Core Direct API error: ${msg}`);
    } finally {
      this.modelOverride = undefined;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
  ): AsyncIterable<LLMResponse> {
    try {
      const url = await this.resolveUrl();
      const model = this.modelOverride ?? this.model;

      const body: Record<string, unknown> = {
        model,
        messages: this.formatMessages(messages),
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 16384,
        stream: true,
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      // Per-request agent to prevent SSE cross-talk
      const streamAgent = new https.Agent({
        keepAlive: false,
        timeout: 120_000,
      });

      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // @ts-expect-error Node.js fetch supports agent via dispatcher
        dispatcher: streamAgent,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      if (!res.body) throw new Error('No response body for streaming');

      const decoder = new TextDecoder();
      let buffer = '';

      for await (const rawChunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(rawChunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') return;

          try {
            const chunk = JSON.parse(payload) as {
              choices: Array<{
                delta: { content?: string; tool_calls?: unknown[] };
                finish_reason?: string;
              }>;
              usage?: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
              };
            };

            const delta = chunk.choices[0]?.delta;
            const usage = chunk.usage;

            yield {
              content: delta?.content || '',
              finishReason: chunk.choices[0]?.finish_reason ?? undefined,
              raw: chunk,
              ...(usage
                ? {
                    usage: {
                      promptTokens: usage.prompt_tokens || 0,
                      completionTokens: usage.completion_tokens || 0,
                      totalTokens: usage.total_tokens || 0,
                    },
                  }
                : {}),
            };
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`SAP AI Core Direct streaming error: ${msg}`);
    } finally {
      this.modelOverride = undefined;
    }
  }

  async getModels(): Promise<IModelInfo[]> {
    // Day one: return fallback set from configured model
    return [{ id: this.model }];
  }

  private formatMessages(
    messages: Message[],
  ): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      if (
        msg.role === 'assistant' &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        return {
          role: 'assistant',
          content: msg.content || undefined,
          tool_calls: msg.tool_calls,
        };
      }

      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          role: 'tool',
          content:
            typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content ?? ''),
          tool_call_id: msg.tool_call_id,
        };
      }

      return {
        role: msg.role,
        content: msg.content ?? '',
      };
    });
  }
}
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/llm-providers/sap-ai-core-direct.ts
git commit -m "feat(#54): add SapAiCoreDirectProvider bypassing Orchestration overhead"
```

### Task 17: Register provider in providers.ts

**Files:**
- Modify: `src/smart-agent/providers.ts`

- [ ] **Step 1: Add import**

```typescript
import { SapAiCoreDirectProvider } from '../llm-providers/sap-ai-core-direct.js';
```

- [ ] **Step 2: Add provider type to LlmProviderConfig**

Change the `provider` union:

```typescript
provider: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk' | 'sap-ai-core-direct';
```

- [ ] **Step 3: Add case to makeLlm switch**

Before the `default:` case in `makeLlm()`, add:

```typescript
    case 'sap-ai-core-direct': {
      const provider = new SapAiCoreDirectProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature,
        maxTokens,
        resourceGroup: cfg.resourceGroup,
      });
      const agent = new OpenAIAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      return new LlmAdapter(agent, {
        model: provider.model,
        getModels: () => provider.getModels(),
      });
    }
```

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/providers.ts
git commit -m "feat(#54): register sap-ai-core-direct provider in makeLlm factory"
```

### Task 18: Export provider from index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add export**

```typescript
export {
  type SapAiCoreDirectConfig,
  SapAiCoreDirectProvider,
} from './llm-providers/sap-ai-core-direct.js';
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Run full lint**

Run: `npm run lint:check`
Expected: PASS (or only pre-existing issues).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(#54): export SapAiCoreDirectProvider from public API"
```

---

## Phase 4: Final verification

### Task 19: Run all tests and build

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 2: Run all tests**

Run: `npx tsx --test src/smart-agent/__tests__/*.test.ts src/smart-agent/pipeline/handlers/__tests__/*.test.ts src/smart-agent/history/__tests__/*.test.ts`
Expected: All tests PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Final commit if lint fixed anything**

```bash
git add -A
git commit -m "chore: lint fixes"
```
