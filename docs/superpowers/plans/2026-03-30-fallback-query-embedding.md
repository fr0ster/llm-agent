# FallbackQueryEmbedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #27 — vector-based RAG stores silently return 0 results because no shared embedder is wired at query time.

**Architecture:** Add a `FallbackQueryEmbedding` decorator that wraps any `IQueryEmbedding` with a store-level `IEmbedder` fallback. Each vector-based store wraps the incoming embedding in `query()`, so if the shared embedder is missing, the store's own embedder is used instead.

**Tech Stack:** TypeScript, ESM

**Spec:** `docs/superpowers/specs/2026-03-30-qdrant-rag-fallback-embedder-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/smart-agent/rag/query-embedding.ts` | Add `FallbackQueryEmbedding` class |
| Modify | `src/smart-agent/rag/qdrant-rag.ts` | Wrap embedding in `query()` |
| Modify | `src/smart-agent/rag/vector-rag.ts` | Wrap embedding in `query()` |
| Modify | `src/index.ts` | Export `FallbackQueryEmbedding` in public API |

---

### Task 1: Add `FallbackQueryEmbedding` class

**Files:**
- Modify: `src/smart-agent/rag/query-embedding.ts` (after line ~47, end of `TextOnlyEmbedding`)

- [ ] **Step 1: Add `FallbackQueryEmbedding` class**

Append after the `TextOnlyEmbedding` class in `src/smart-agent/rag/query-embedding.ts`:

```ts
/**
 * Decorator: tries the inner embedding first; on failure falls back
 * to the supplied embedder.  Result is memoized so concurrent callers
 * share one promise — same contract as {@link QueryEmbedding}.
 */
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

Note: `IEmbedder` is already imported in this file (used by `QueryEmbedding`).

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 3: Verify lint**

Run: `npm run lint:check`
Expected: no new warnings or errors

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/rag/query-embedding.ts
git commit -m "feat: add FallbackQueryEmbedding decorator (#27)"
```

---

### Task 2: Wire fallback in QdrantRag

**Files:**
- Modify: `src/smart-agent/rag/qdrant-rag.ts` (imports + line ~166 inside `query()`)

- [ ] **Step 1: Add import**

Add to the imports section of `src/smart-agent/rag/qdrant-rag.ts`:

```ts
import { FallbackQueryEmbedding } from './query-embedding.js';
```

- [ ] **Step 2: Wrap embedding in `query()`**

In `query()` method, replace line ~166:

```ts
// before:
const vector = await embedding.toVector();

// after:
const safe = new FallbackQueryEmbedding(embedding, this.embedder);
const vector = await safe.toVector();
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/rag/qdrant-rag.ts
git commit -m "fix: QdrantRag falls back to own embedder on query (#27)"
```

---

### Task 3: Wire fallback in VectorRag

**Files:**
- Modify: `src/smart-agent/rag/vector-rag.ts` (imports + line ~181 inside `query()`)

- [ ] **Step 1: Add import**

Add to the imports section of `src/smart-agent/rag/vector-rag.ts`:

```ts
import { FallbackQueryEmbedding } from './query-embedding.js';
```

- [ ] **Step 2: Wrap embedding in `query()`**

In `query()` method, replace line 181:

```ts
// before:
const queryVector = await embedding.toVector();

// after:
const safe = new FallbackQueryEmbedding(embedding, this.embedder);
const queryVector = await safe.toVector();
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 4: Verify lint on all changed files**

Run: `npm run lint:check`
Expected: no warnings or errors

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/rag/vector-rag.ts
git commit -m "fix: VectorRag falls back to own embedder on query (#27)"
```

---

### Task 4: Export in public API

**Files:**
- Modify: `src/index.ts` (line ~193-196)

- [ ] **Step 1: Add `FallbackQueryEmbedding` to export block**

In `src/index.ts`, update the export block at line ~193:

```ts
// before:
export {
  QueryEmbedding,
  TextOnlyEmbedding,
} from './smart-agent/rag/query-embedding.js';

// after:
export {
  FallbackQueryEmbedding,
  QueryEmbedding,
  TextOnlyEmbedding,
} from './smart-agent/rag/query-embedding.js';
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: compiles without errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export FallbackQueryEmbedding in public API (#27)"
```

---

### Task 5: Final verification

- [ ] **Step 1: Clean build**

Run: `npm run clean && npm run build`
Expected: compiles without errors

- [ ] **Step 2: Full lint check**

Run: `npm run lint:check`
Expected: no warnings or errors
