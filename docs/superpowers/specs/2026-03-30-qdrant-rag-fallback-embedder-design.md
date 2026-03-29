# QdrantRag Query Fix: FallbackQueryEmbedding Decorator

**Issue:** [#27 — QdrantRag query fails: shared embedder not wired in SmartServer](https://github.com/mcp-abap-adt/llm-agent/issues/27)
**Date:** 2026-03-30

## Problem

`SmartServer` creates per-store embedders via `resolveEmbedder()` (used for upsert) but does not call `builder.withEmbedder()` to set the shared agent-level embedder. As a result, `SmartAgent` always creates `TextOnlyEmbedding`, and vector-based stores (`QdrantRag`, `VectorRag`) fail on `toVector()` with a silently caught error. All RAG queries return 0 results.

## Design Decision

Instead of wiring a shared embedder at the `SmartServer` level (architecturally impure — arbitrary first-store selection), each vector-based RAG store uses its own embedder as a fallback when the shared `IQueryEmbedding` cannot produce a vector.

This preserves the existing memoization optimization: when a shared embedder IS configured via `builder.withEmbedder()`, all stores share one vectorization call. When it is NOT configured, each store falls back to its own embedder.

## Solution: `FallbackQueryEmbedding` Decorator

### New class

File: `src/smart-agent/rag/query-embedding.ts`

```ts
export class FallbackQueryEmbedding implements IQueryEmbedding {
  private _vector: Promise<number[]> | null = null;

  constructor(
    private readonly inner: IQueryEmbedding,
    private readonly fallback: IEmbedder,
  ) {}

  get text(): string {
    return this.inner.text;
  }

  toVector(): Promise<number[]> {
    this._vector ??= this.inner.toVector().catch(() =>
      this.fallback.embed(this.text),
    );
    return this._vector;
  }
}
```

- Decorates any `IQueryEmbedding` with a fallback `IEmbedder`
- Memoizes the result (same pattern as `QueryEmbedding`)
- If `inner.toVector()` succeeds (shared embedder present) — fallback is not invoked
- If `inner.toVector()` rejects (`TextOnlyEmbedding`) — uses store-level embedder
- If fallback embedder also fails, the error propagates and is handled by the store's existing `try/catch` → returns `Result` with `ok: false`

### Store changes

Each vector-based store wraps the incoming `embedding` in its `query()` method and adds the import:

```ts
import { FallbackQueryEmbedding } from './query-embedding.js';
```

**QdrantRag.query():**
```ts
const safe = new FallbackQueryEmbedding(embedding, this.embedder);
const vector = await safe.toVector();
```

**VectorRag.query():**
```ts
const safe = new FallbackQueryEmbedding(embedding, this.embedder);
const queryVector = await safe.toVector();
```

**InMemoryRag** — no changes (does not call `toVector()`).

### What does NOT change

- `IQueryEmbedding` interface — unchanged
- `SmartAgent` (agent.ts) — embedding creation logic unchanged
- `SmartServer` — no `builder.withEmbedder()` call needed
- `SmartAgentBuilder` — unchanged; `withEmbedder()` remains optional optimization

## Trade-offs

| Aspect | Assessment |
|--------|-----------|
| Memoization | Preserved when shared embedder is configured; fallback per-store otherwise |
| Interface changes | None — `IQueryEmbedding` untouched |
| Blast radius | Minimal — one new class, 2-3 lines per vector store |
| Control flow | Exception-based fallback (acceptable: edge case, not normal flow) |

## Verification

1. `npm run build` — compilation succeeds
2. `npm run lint:check` — Biome passes
3. Manual review of decorator logic
