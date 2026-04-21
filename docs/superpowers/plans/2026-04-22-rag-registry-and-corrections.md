# RAG Registry and Corrections Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `IRagEditor` / `IRagRegistry` split, four edit strategies, four id strategies, two overlay IRags, corrections module, and MCP tool factory — letting consumers compose heterogeneous editable/immutable RAG collections without re-implementing the plumbing.

**Architecture:** Split `IRag` (read) from `IRagEditor` (write); per-collection id resolution via `IIdStrategy`; layered reads via `OverlayRag` / `SessionScopedRag`; write-only edit strategies (`Direct`, `Immutable`, `Overlay`, `SessionScoped`); `SimpleRagRegistry` binds them; corrections stay pure-logic in a separate module; MCP tools consume the registry.

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 18, Biome, `node:test` via `tsx`, existing backends (`VectorRag`, `QdrantRag`, `InMemoryRag`).

**Spec:** `docs/superpowers/specs/2026-04-22-rag-registry-corrections-design.md`

**Branch:** `feat/rag-registry-and-corrections` (already created)

---

## File map

**Create:**
- `src/smart-agent/rag/corrections/errors.ts` — `ReadOnlyError`, `MissingIdError`, `CanonicalKeyCollisionError`
- `src/smart-agent/rag/corrections/metadata.ts` — pure helpers
- `src/smart-agent/rag/corrections/active-filtering-rag.ts` — `ActiveFilteringRag`
- `src/smart-agent/rag/corrections/index.ts` — barrel
- `src/smart-agent/rag/strategies/id/{caller-provided,session-scoped,global-unique,canonical-key,index}.ts`
- `src/smart-agent/rag/strategies/edit/{direct,immutable,overlay,session-scoped,index}.ts`
- `src/smart-agent/rag/overlays/{overlay-rag,session-scoped-rag,index}.ts`
- `src/smart-agent/rag/registry/{simple-rag-registry,index}.ts`
- `src/smart-agent/rag/mcp-tools/{rag-collection-tools,index}.ts`
- `src/smart-agent/rag/__tests__/` — one `*.test.ts` per new module

**Modify:**
- `src/smart-agent/interfaces/rag.ts` — new interfaces; remove `IRag.upsert`, `IRag.clear`
- `src/smart-agent/rag/in-memory-rag.ts` — split read/write; expose `IRagBackendWriter`; implement `getById`
- `src/smart-agent/rag/vector-rag.ts` — same
- `src/smart-agent/rag/qdrant-rag.ts` — same
- `src/smart-agent/rag/tool-indexing-strategy.ts` — use `IRagEditor` via registry
- `src/smart-agent/rag/preprocessor.ts` — use `IRagEditor` via registry
- `src/smart-agent/rag/index.ts` — re-export new modules
- `src/index.ts` — public API
- `package.json` — major version bump to 9.0.0

**Deferred / unused after migration:** `IRag.clear` (moves to editor), `IPrecomputedVectorRag.upsertPrecomputed` (moves to backend writer).

---

## Task 1: Add error types

**Files:**
- Create: `src/smart-agent/rag/corrections/errors.ts`
- Test: `src/smart-agent/rag/__tests__/corrections-errors.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/smart-agent/rag/__tests__/corrections-errors.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ReadOnlyError,
  MissingIdError,
  CanonicalKeyCollisionError,
} from '../corrections/errors.js';
import { RagError } from '../../interfaces/types.js';

describe('corrections errors', () => {
  it('ReadOnlyError extends RagError with code', () => {
    const e = new ReadOnlyError('corp-facts');
    assert.ok(e instanceof RagError);
    assert.equal(e.code, 'RAG_READ_ONLY');
    assert.match(e.message, /corp-facts/);
  });

  it('MissingIdError extends RagError with code', () => {
    const e = new MissingIdError('CallerProvidedIdStrategy');
    assert.ok(e instanceof RagError);
    assert.equal(e.code, 'RAG_MISSING_ID');
    assert.match(e.message, /CallerProvidedIdStrategy/);
  });

  it('CanonicalKeyCollisionError extends RagError with code', () => {
    const e = new CanonicalKeyCollisionError('doc-42');
    assert.ok(e instanceof RagError);
    assert.equal(e.code, 'RAG_CANONICAL_KEY_COLLISION');
    assert.match(e.message, /doc-42/);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```
node --import tsx/esm --test --test-reporter=spec src/smart-agent/rag/__tests__/corrections-errors.test.ts
```
Expected: Cannot find module `../corrections/errors.js`.

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/corrections/errors.ts
import { RagError } from '../../interfaces/types.js';

export class ReadOnlyError extends RagError {
  constructor(collectionName: string) {
    super(`Collection '${collectionName}' is read-only`, 'RAG_READ_ONLY');
    this.name = 'ReadOnlyError';
  }
}

export class MissingIdError extends RagError {
  constructor(strategyName: string) {
    super(`${strategyName} requires metadata.id`, 'RAG_MISSING_ID');
    this.name = 'MissingIdError';
  }
}

export class CanonicalKeyCollisionError extends RagError {
  constructor(key: string) {
    super(
      `canonicalKey '${key}' already exists in base; reserved for future overlay-block semantics`,
      'RAG_CANONICAL_KEY_COLLISION',
    );
    this.name = 'CanonicalKeyCollisionError';
  }
}
```

- [ ] **Step 4: Run test — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/corrections/errors.ts src/smart-agent/rag/__tests__/corrections-errors.test.ts
git commit -m "feat(rag): add corrections error types"
```

---

## Task 2: Declare new interfaces (non-breaking, additive)

Keep the old `IRag.upsert` / `IRag.clear` in place for now so the codebase stays buildable while we add the new parts. Removal happens in Task 13.

**Files:**
- Modify: `src/smart-agent/interfaces/rag.ts`

- [ ] **Step 1: Add the following exports to the bottom of `rag.ts` (do not remove anything yet)**

```ts
// Added in 9.0 refactor — see docs/superpowers/specs/2026-04-22-rag-registry-corrections-design.md

export interface IRagEditor {
  upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<{ id: string }, RagError>>;
  deleteById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<boolean, RagError>>;
  clear?(): Promise<Result<void, RagError>>;
}

export interface IIdStrategy {
  /** Always returns a valid id; throws MissingIdError when required input is missing. */
  resolve(metadata: RagMetadata, text: string): string;
}

export interface IRagBackendWriter {
  upsertRaw(
    id: string,
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>>;
  deleteByIdRaw(
    id: string,
    options?: CallOptions,
  ): Promise<Result<boolean, RagError>>;
  clearAll?(): Promise<Result<void, RagError>>;
}

export interface RagCollectionMeta {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly editable: boolean;
  readonly tags?: readonly string[];
}

export interface IRagRegistry {
  register(
    name: string,
    rag: IRag,
    editor?: IRagEditor,
    meta?: Omit<RagCollectionMeta, 'name' | 'editable'>,
  ): void;
  unregister(name: string): boolean;
  get(name: string): IRag | undefined;
  getEditor(name: string): IRagEditor | undefined;
  list(): readonly RagCollectionMeta[];
}
```

Also add `getById` to the existing `IRag` as **optional** for now (required in Task 11 after backends implement it):

```ts
export interface IRag {
  // existing members unchanged…
  getById?(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>>;
}
```

- [ ] **Step 2: Build the project**

```
npm run build
```
Expected: build passes.

- [ ] **Step 3: Commit**

```
git add src/smart-agent/interfaces/rag.ts
git commit -m "feat(rag): declare IRagEditor, IIdStrategy, IRagRegistry, IRagBackendWriter"
```

---

## Task 3: Implement four id strategies

**Files:**
- Create: `src/smart-agent/rag/strategies/id/caller-provided.ts`
- Create: `src/smart-agent/rag/strategies/id/global-unique.ts`
- Create: `src/smart-agent/rag/strategies/id/session-scoped.ts`
- Create: `src/smart-agent/rag/strategies/id/canonical-key.ts`
- Create: `src/smart-agent/rag/strategies/id/index.ts`
- Test: `src/smart-agent/rag/__tests__/id-strategies.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/smart-agent/rag/__tests__/id-strategies.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CallerProvidedIdStrategy,
  GlobalUniqueIdStrategy,
  SessionScopedIdStrategy,
  CanonicalKeyIdStrategy,
} from '../strategies/id/index.js';
import { MissingIdError } from '../corrections/errors.js';

describe('CallerProvidedIdStrategy', () => {
  it('returns metadata.id when present', () => {
    const s = new CallerProvidedIdStrategy();
    assert.equal(s.resolve({ id: 'abc' }, 'text'), 'abc');
  });
  it('throws MissingIdError when id absent', () => {
    const s = new CallerProvidedIdStrategy();
    assert.throws(() => s.resolve({}, 'text'), MissingIdError);
  });
});

describe('GlobalUniqueIdStrategy', () => {
  it('returns metadata.id when present', () => {
    const s = new GlobalUniqueIdStrategy();
    assert.equal(s.resolve({ id: 'abc' }, 'text'), 'abc');
  });
  it('generates uuid when id absent', () => {
    const s = new GlobalUniqueIdStrategy();
    const id = s.resolve({}, 'text');
    assert.match(id, /^[0-9a-f-]{36}$/);
  });
});

describe('SessionScopedIdStrategy', () => {
  it('prefixes explicit id with session', () => {
    const s = new SessionScopedIdStrategy('sess-1');
    assert.equal(s.resolve({ id: 'x' }, 't'), 'sess-1:x');
  });
  it('falls back to canonicalKey', () => {
    const s = new SessionScopedIdStrategy('sess-1');
    assert.equal(s.resolve({ canonicalKey: 'doc' }, 't'), 'sess-1:doc');
  });
  it('generates session-scoped uuid when neither present', () => {
    const s = new SessionScopedIdStrategy('sess-1');
    const id = s.resolve({}, 't');
    assert.match(id, /^sess-1:[0-9a-f-]{36}$/);
  });
});

describe('CanonicalKeyIdStrategy', () => {
  it('uses canonicalKey with default version', () => {
    const s = new CanonicalKeyIdStrategy();
    assert.equal(s.resolve({ canonicalKey: 'doc' }, 't'), 'doc:v1');
  });
  it('uses provided version from metadata', () => {
    const s = new CanonicalKeyIdStrategy();
    assert.equal(
      s.resolve({ canonicalKey: 'doc', version: 3 }, 't'),
      'doc:v3',
    );
  });
  it('throws when canonicalKey missing', () => {
    const s = new CanonicalKeyIdStrategy();
    assert.throws(() => s.resolve({}, 't'), MissingIdError);
  });
});
```

- [ ] **Step 2: Run test — expect failure (modules missing)**

- [ ] **Step 3: Implement strategies**

```ts
// src/smart-agent/rag/strategies/id/caller-provided.ts
import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';
import { MissingIdError } from '../../corrections/errors.js';

export class CallerProvidedIdStrategy implements IIdStrategy {
  resolve(metadata: RagMetadata, _text: string): string {
    if (typeof metadata.id !== 'string' || metadata.id.length === 0) {
      throw new MissingIdError('CallerProvidedIdStrategy');
    }
    return metadata.id;
  }
}
```

```ts
// src/smart-agent/rag/strategies/id/global-unique.ts
import { randomUUID } from 'node:crypto';
import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';

export class GlobalUniqueIdStrategy implements IIdStrategy {
  resolve(metadata: RagMetadata, _text: string): string {
    return typeof metadata.id === 'string' && metadata.id.length > 0
      ? metadata.id
      : randomUUID();
  }
}
```

```ts
// src/smart-agent/rag/strategies/id/session-scoped.ts
import { randomUUID } from 'node:crypto';
import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';

export class SessionScopedIdStrategy implements IIdStrategy {
  constructor(private readonly sessionId: string) {}

  resolve(metadata: RagMetadata, _text: string): string {
    const suffix =
      (typeof metadata.id === 'string' && metadata.id) ||
      (typeof metadata.canonicalKey === 'string' && metadata.canonicalKey) ||
      randomUUID();
    return `${this.sessionId}:${suffix}`;
  }
}
```

```ts
// src/smart-agent/rag/strategies/id/canonical-key.ts
import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';
import { MissingIdError } from '../../corrections/errors.js';

export class CanonicalKeyIdStrategy implements IIdStrategy {
  resolve(metadata: RagMetadata, _text: string): string {
    const key = metadata.canonicalKey;
    if (typeof key !== 'string' || key.length === 0) {
      throw new MissingIdError('CanonicalKeyIdStrategy');
    }
    const version =
      typeof metadata.version === 'number' && metadata.version > 0
        ? metadata.version
        : 1;
    return `${key}:v${version}`;
  }
}
```

```ts
// src/smart-agent/rag/strategies/id/index.ts
export { CallerProvidedIdStrategy } from './caller-provided.js';
export { GlobalUniqueIdStrategy } from './global-unique.js';
export { SessionScopedIdStrategy } from './session-scoped.js';
export { CanonicalKeyIdStrategy } from './canonical-key.js';
```

- [ ] **Step 4: Run test — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/strategies/id src/smart-agent/rag/__tests__/id-strategies.test.ts
git commit -m "feat(rag): add id strategies (caller-provided, global-unique, session-scoped, canonical-key)"
```

---

## Task 4: Corrections pure-logic module

**Files:**
- Create: `src/smart-agent/rag/corrections/metadata.ts`
- Test: `src/smart-agent/rag/__tests__/corrections-metadata.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/smart-agent/rag/__tests__/corrections-metadata.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateCorrectionMetadata,
  deprecateMetadata,
  buildCorrectionMetadata,
  filterActive,
} from '../corrections/metadata.js';

describe('validateCorrectionMetadata', () => {
  it('passes with canonicalKey', () => {
    validateCorrectionMetadata({ canonicalKey: 'k' });
  });
  it('throws when canonicalKey missing', () => {
    assert.throws(() =>
      validateCorrectionMetadata({ canonicalKey: '' as string }),
    );
  });
});

describe('deprecateMetadata', () => {
  it('adds deprecated tag with reason and timestamp', () => {
    const out = deprecateMetadata({ canonicalKey: 'k' }, 'outdated', 1000);
    assert.deepEqual(out.tags, ['deprecated']);
    assert.equal(out.deprecatedReason, 'outdated');
    assert.equal(out.deprecatedAt, 1000);
  });
  it('is idempotent', () => {
    const once = deprecateMetadata({ canonicalKey: 'k' }, 'r', 1);
    const twice = deprecateMetadata(once, 'r', 1);
    assert.deepEqual(twice.tags, ['deprecated']);
  });
});

describe('buildCorrectionMetadata', () => {
  it('marks predecessor superseded and next as correction', () => {
    const { predecessor, next } = buildCorrectionMetadata({
      predecessor: { canonicalKey: 'k' },
      predecessorId: 'k:v1',
      newEntryId: 'k:v2',
      reason: 'typo fix',
    });
    assert.ok(predecessor.tags?.includes('superseded'));
    assert.equal(predecessor.supersededBy, 'k:v2');
    assert.ok(next.tags?.includes('correction'));
    assert.equal(next.canonicalKey, 'k');
  });
});

describe('filterActive', () => {
  const items = [
    { meta: { canonicalKey: 'a' } },
    { meta: { canonicalKey: 'b', tags: ['deprecated'] as const } },
    { meta: { canonicalKey: 'c', tags: ['superseded'] as const } },
    { meta: { canonicalKey: 'd', tags: ['verified'] as const } },
  ];
  it('hides deprecated and superseded by default', () => {
    const out = filterActive(items, (i) => i.meta as any);
    assert.deepEqual(
      out.map((i) => i.meta.canonicalKey),
      ['a', 'd'],
    );
  });
  it('returns all when includeInactive is true', () => {
    const out = filterActive(items, (i) => i.meta as any, {
      includeInactive: true,
    });
    assert.equal(out.length, 4);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/corrections/metadata.ts
import { RagError } from '../../interfaces/types.js';

export type CorrectionTag =
  | 'verified'
  | 'deprecated'
  | 'superseded'
  | 'correction';

export interface CorrectionMetadata {
  canonicalKey: string;
  tags?: CorrectionTag[];
  sessionId?: string;
  supersededBy?: string;
  deprecatedAt?: number;
  deprecatedReason?: string;
}

export function validateCorrectionMetadata(meta: CorrectionMetadata): void {
  if (typeof meta.canonicalKey !== 'string' || meta.canonicalKey.length === 0) {
    throw new RagError(
      'CorrectionMetadata.canonicalKey must be a non-empty string',
      'RAG_VALIDATION_ERROR',
    );
  }
}

function withTag(
  meta: CorrectionMetadata,
  tag: CorrectionTag,
): CorrectionMetadata {
  const existing = meta.tags ?? [];
  return existing.includes(tag) ? meta : { ...meta, tags: [...existing, tag] };
}

export function deprecateMetadata(
  current: CorrectionMetadata,
  reason: string,
  nowSeconds?: number,
): CorrectionMetadata {
  validateCorrectionMetadata(current);
  const stamped: CorrectionMetadata = {
    ...current,
    deprecatedReason: reason,
    deprecatedAt: nowSeconds ?? Math.floor(Date.now() / 1000),
  };
  return withTag(stamped, 'deprecated');
}

export function buildCorrectionMetadata(input: {
  predecessor: CorrectionMetadata;
  predecessorId: string;
  newEntryId: string;
  reason: string;
}): { predecessor: CorrectionMetadata; next: CorrectionMetadata } {
  validateCorrectionMetadata(input.predecessor);
  const predecessor = withTag(
    {
      ...input.predecessor,
      supersededBy: input.newEntryId,
      deprecatedReason: input.reason,
      deprecatedAt: Math.floor(Date.now() / 1000),
    },
    'superseded',
  );
  const next: CorrectionMetadata = withTag(
    {
      canonicalKey: input.predecessor.canonicalKey,
      sessionId: input.predecessor.sessionId,
    },
    'correction',
  );
  return { predecessor, next };
}

export function filterActive<T>(
  items: readonly T[],
  getMeta: (item: T) => CorrectionMetadata | undefined,
  options?: { includeInactive?: boolean },
): T[] {
  if (options?.includeInactive) return [...items];
  return items.filter((item) => {
    const tags = getMeta(item)?.tags ?? [];
    return !tags.includes('deprecated') && !tags.includes('superseded');
  });
}
```

- [ ] **Step 4: Run test — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/corrections/metadata.ts src/smart-agent/rag/__tests__/corrections-metadata.test.ts
git commit -m "feat(rag): add pure-logic corrections metadata module"
```

---

## Task 5: Add `IRagBackendWriter` + `getById` to `InMemoryRag`

**Files:**
- Modify: `src/smart-agent/rag/in-memory-rag.ts`
- Test: `src/smart-agent/rag/__tests__/in-memory-rag.test.ts` (extend)

- [ ] **Step 1: Read current `InMemoryRag` to locate its internal Map**

Find the internal record storage. Keep the existing `upsert` and `clear` (they will be removed in Task 13) so prior tests keep passing.

- [ ] **Step 2: Add failing test for `getById` and writer surface**

Append to `in-memory-rag.test.ts`:

```ts
import { InMemoryRag } from '../in-memory-rag.js';

describe('InMemoryRag.getById', () => {
  it('returns stored record by id', async () => {
    const rag = new InMemoryRag();
    await rag.upsert('hello world', { id: 'r1' });
    const got = await rag.getById!('r1');
    assert.ok(got.ok);
    assert.ok(got.value);
    assert.equal(got.value!.text, 'hello world');
  });
  it('returns null for unknown id', async () => {
    const rag = new InMemoryRag();
    const got = await rag.getById!('missing');
    assert.ok(got.ok);
    assert.equal(got.value, null);
  });
});

describe('InMemoryRag backend writer', () => {
  it('exposes IRagBackendWriter via writer()', async () => {
    const rag = new InMemoryRag();
    const writer = rag.writer();
    const up = await writer.upsertRaw('id-1', 'hi', { id: 'id-1' });
    assert.ok(up.ok);
    const del = await writer.deleteByIdRaw('id-1');
    assert.ok(del.ok && del.value === true);
    const delAgain = await writer.deleteByIdRaw('id-1');
    assert.ok(delAgain.ok && delAgain.value === false);
  });
});
```

- [ ] **Step 3: Run — expect failure**

- [ ] **Step 4: Implement**

Add to `InMemoryRag`:

```ts
// Inside the class
async getById(
  id: string,
  _options?: CallOptions,
): Promise<Result<RagResult | null, RagError>> {
  const record = this.records.get(id);  // adjust to match actual field name
  if (!record) return { ok: true, value: null };
  return {
    ok: true,
    value: { text: record.text, metadata: record.metadata, score: 1 },
  };
}

writer(): IRagBackendWriter {
  return {
    upsertRaw: async (id, text, metadata) => {
      await this.upsert(text, { ...metadata, id });
      return { ok: true, value: undefined };
    },
    deleteByIdRaw: async (id) => {
      const had = this.records.has(id);  // adjust
      if (had) this.records.delete(id);
      return { ok: true, value: had };
    },
    clearAll: async () => {
      this.records.clear();
      return { ok: true, value: undefined };
    },
  };
}
```

Adjust the internal field name (`records`, `store`, etc.) to match the actual implementation. Also import `IRagBackendWriter`, `RagResult`, `Result`, `RagError`, `CallOptions` at the top if not already.

- [ ] **Step 5: Run tests — expect pass**

```
node --import tsx/esm --test --test-reporter=spec src/smart-agent/rag/__tests__/in-memory-rag.test.ts
```

- [ ] **Step 6: Commit**

```
git add src/smart-agent/rag/in-memory-rag.ts src/smart-agent/rag/__tests__/in-memory-rag.test.ts
git commit -m "feat(rag): add getById and writer() to InMemoryRag"
```

---

## Task 6: Add `getById` + writer to `VectorRag`

**Files:**
- Modify: `src/smart-agent/rag/vector-rag.ts`
- Test: extend existing vector-rag tests, or add `src/smart-agent/rag/__tests__/vector-rag-writer.test.ts`

- [ ] **Step 1: Add failing test**

```ts
// src/smart-agent/rag/__tests__/vector-rag-writer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VectorRag } from '../vector-rag.js';
import type { IEmbedder } from '../../interfaces/rag.js';

const fakeEmbedder: IEmbedder = {
  embed: async (t) => ({ vector: Array.from(t).map((c) => c.charCodeAt(0) / 255) }),
};

describe('VectorRag.getById', () => {
  it('retrieves by id after upsert', async () => {
    const rag = new VectorRag(fakeEmbedder);
    await rag.upsert('hello', { id: 'v1' });
    const got = await rag.getById!('v1');
    assert.ok(got.ok && got.value?.text === 'hello');
  });
});

describe('VectorRag backend writer', () => {
  it('upsertRaw and deleteByIdRaw work', async () => {
    const rag = new VectorRag(fakeEmbedder);
    const w = rag.writer();
    await w.upsertRaw('v1', 'hi', { id: 'v1' });
    const got = await rag.getById!('v1');
    assert.ok(got.ok && got.value !== null);
    const del = await w.deleteByIdRaw('v1');
    assert.ok(del.ok && del.value);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `getById` and `writer()` on `VectorRag`**

Look up the internal record store in `vector-rag.ts`. Mirror the `InMemoryRag` pattern: add `getById(id)` that iterates/looks up by `metadata.id`, and `writer()` that returns `IRagBackendWriter` delegating to the existing `upsert` / an internal delete.

If `VectorRag` currently lacks a delete-by-id primitive, implement it alongside (filter out the matching record from the underlying store).

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/vector-rag.ts src/smart-agent/rag/__tests__/vector-rag-writer.test.ts
git commit -m "feat(rag): add getById and writer() to VectorRag"
```

---

## Task 7: Add `getById` + writer to `QdrantRag`

**Files:**
- Modify: `src/smart-agent/rag/qdrant-rag.ts`

- [ ] **Step 1: Read `qdrant-rag.ts` to identify the points API used**

Qdrant supports `points/retrieve?ids=[...]` and `points/delete?points=[...]`. Use these for `getById` and `deleteByIdRaw`.

- [ ] **Step 2: Skip live integration test** — existing `qdrant-rag.test.ts` likely runs against a real Qdrant and is not required for CI. Verify the file pattern and add new tests only if they stay offline (mock `fetch` or use dependency injection). If the test file already mocks `fetch`, extend it; otherwise add a lightweight mocked unit test under `__tests__/qdrant-rag-writer.test.ts` using the same mock pattern.

- [ ] **Step 3: Implement**

Add to `QdrantRag`:

```ts
async getById(id: string, _options?: CallOptions): Promise<Result<RagResult | null, RagError>> {
  // POST {baseUrl}/collections/{collection}/points with ids=[id]
  // Return null when the response array is empty; otherwise map the point to RagResult.
}

writer(): IRagBackendWriter {
  return {
    upsertRaw: async (id, text, metadata) => {
      return this.upsert(text, { ...metadata, id });
    },
    deleteByIdRaw: async (id) => {
      // POST {baseUrl}/collections/{collection}/points/delete with points=[id]
      // Return ok: true, value: <whether the point existed>
    },
    clearAll: async () => {
      // DELETE collection points via filter={} (or recreate collection); safest is a no-op + typed error if unsupported.
      return { ok: false, error: new RagError('clearAll not supported on QdrantRag', 'RAG_UNSUPPORTED') };
    },
  };
}
```

Fill in the exact HTTP calls using the existing `fetch`/axios pattern in this file. Reuse the error-wrapping utilities already present.

- [ ] **Step 4: Run `npm run build`** — expect pass. Run any offline unit tests added.

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/qdrant-rag.ts src/smart-agent/rag/__tests__/qdrant-rag-writer.test.ts
git commit -m "feat(rag): add getById and writer() to QdrantRag"
```

---

## Task 8: Implement `DirectEditStrategy` and `ImmutableEditStrategy`

**Files:**
- Create: `src/smart-agent/rag/strategies/edit/direct.ts`
- Create: `src/smart-agent/rag/strategies/edit/immutable.ts`
- Create: `src/smart-agent/rag/strategies/edit/index.ts` (partial — add overlay later)
- Test: `src/smart-agent/rag/__tests__/edit-strategies-basic.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/smart-agent/rag/__tests__/edit-strategies-basic.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DirectEditStrategy, ImmutableEditStrategy } from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy } from '../strategies/id/index.js';
import { ReadOnlyError } from '../corrections/errors.js';
import type { IRagBackendWriter } from '../../interfaces/rag.js';

function fakeWriter(): IRagBackendWriter & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { upsertRaw: [], deleteByIdRaw: [] };
  return {
    calls,
    upsertRaw: async (id, text, meta) => {
      calls.upsertRaw.push({ id, text, meta });
      return { ok: true, value: undefined };
    },
    deleteByIdRaw: async (id) => {
      calls.deleteByIdRaw.push({ id });
      return { ok: true, value: true };
    },
  };
}

describe('DirectEditStrategy', () => {
  it('resolves id via strategy and forwards upsert', async () => {
    const w = fakeWriter();
    const ed = new DirectEditStrategy(w, new GlobalUniqueIdStrategy());
    const res = await ed.upsert('hello', { id: 'x' });
    assert.ok(res.ok);
    assert.equal(res.value.id, 'x');
    assert.equal(w.calls.upsertRaw.length, 1);
  });
  it('forwards delete', async () => {
    const w = fakeWriter();
    const ed = new DirectEditStrategy(w, new GlobalUniqueIdStrategy());
    const res = await ed.deleteById('x');
    assert.ok(res.ok);
  });
});

describe('ImmutableEditStrategy', () => {
  it('returns ReadOnlyError for upsert', async () => {
    const ed = new ImmutableEditStrategy('corp-facts');
    const res = await ed.upsert('t', {});
    assert.ok(!res.ok);
    assert.ok(res.error instanceof ReadOnlyError);
  });
  it('returns ReadOnlyError for deleteById', async () => {
    const ed = new ImmutableEditStrategy('corp-facts');
    const res = await ed.deleteById('x');
    assert.ok(!res.ok);
    assert.ok(res.error instanceof ReadOnlyError);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/strategies/edit/direct.ts
import type {
  IIdStrategy,
  IRagBackendWriter,
  IRagEditor,
} from '../../../interfaces/rag.js';
import type {
  CallOptions,
  RagError,
  RagMetadata,
  Result,
} from '../../../interfaces/types.js';
import { MissingIdError } from '../../corrections/errors.js';

export class DirectEditStrategy implements IRagEditor {
  constructor(
    private readonly writer: IRagBackendWriter,
    private readonly idStrategy: IIdStrategy,
  ) {}

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<{ id: string }, RagError>> {
    let id: string;
    try {
      id = this.idStrategy.resolve(metadata, text);
    } catch (e) {
      if (e instanceof MissingIdError) return { ok: false, error: e };
      throw e;
    }
    const res = await this.writer.upsertRaw(id, text, { ...metadata, id }, options);
    return res.ok ? { ok: true, value: { id } } : res;
  }

  async deleteById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<boolean, RagError>> {
    return this.writer.deleteByIdRaw(id, options);
  }

  async clear(): Promise<Result<void, RagError>> {
    if (this.writer.clearAll) return this.writer.clearAll();
    return { ok: true, value: undefined };
  }
}
```

```ts
// src/smart-agent/rag/strategies/edit/immutable.ts
import type { IRagEditor } from '../../../interfaces/rag.js';
import type { RagError, Result } from '../../../interfaces/types.js';
import { ReadOnlyError } from '../../corrections/errors.js';

export class ImmutableEditStrategy implements IRagEditor {
  constructor(private readonly collectionName = 'immutable') {}
  async upsert(): Promise<Result<{ id: string }, RagError>> {
    return { ok: false, error: new ReadOnlyError(this.collectionName) };
  }
  async deleteById(): Promise<Result<boolean, RagError>> {
    return { ok: false, error: new ReadOnlyError(this.collectionName) };
  }
}
```

```ts
// src/smart-agent/rag/strategies/edit/index.ts
export { DirectEditStrategy } from './direct.js';
export { ImmutableEditStrategy } from './immutable.js';
// overlay and session-scoped added in later tasks
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/strategies/edit src/smart-agent/rag/__tests__/edit-strategies-basic.test.ts
git commit -m "feat(rag): add DirectEditStrategy and ImmutableEditStrategy"
```

---

## Task 9: Implement `SimpleRagRegistry`

**Files:**
- Create: `src/smart-agent/rag/registry/simple-rag-registry.ts`
- Create: `src/smart-agent/rag/registry/index.ts`
- Test: `src/smart-agent/rag/__tests__/simple-rag-registry.test.ts`

- [ ] **Step 1: Failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { DirectEditStrategy, ImmutableEditStrategy } from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy } from '../strategies/id/index.js';

describe('SimpleRagRegistry', () => {
  it('registers and retrieves rag + editor', () => {
    const reg = new SimpleRagRegistry();
    const rag = new InMemoryRag();
    const ed = new DirectEditStrategy(rag.writer(), new GlobalUniqueIdStrategy());
    reg.register('notes', rag, ed, { displayName: 'Notes' });
    assert.equal(reg.get('notes'), rag);
    assert.equal(reg.getEditor('notes'), ed);
  });

  it('marks collection as read-only when editor is absent or immutable', () => {
    const reg = new SimpleRagRegistry();
    reg.register('corp', new InMemoryRag(), new ImmutableEditStrategy('corp'), { displayName: 'Corp' });
    reg.register('facts', new InMemoryRag(), undefined, { displayName: 'Facts' });
    const list = reg.list();
    const corp = list.find((m) => m.name === 'corp')!;
    const facts = list.find((m) => m.name === 'facts')!;
    assert.equal(corp.editable, false);
    assert.equal(facts.editable, false);
  });

  it('rejects duplicate names', () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
    assert.throws(() => reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' }));
  });

  it('unregister removes entry and returns true when present', () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
    assert.equal(reg.unregister('x'), true);
    assert.equal(reg.unregister('x'), false);
  });

  it('list preserves insertion order', () => {
    const reg = new SimpleRagRegistry();
    reg.register('a', new InMemoryRag(), undefined, { displayName: 'A' });
    reg.register('b', new InMemoryRag(), undefined, { displayName: 'B' });
    reg.register('c', new InMemoryRag(), undefined, { displayName: 'C' });
    assert.deepEqual(reg.list().map((m) => m.name), ['a', 'b', 'c']);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/registry/simple-rag-registry.ts
import type {
  IRag,
  IRagEditor,
  IRagRegistry,
  RagCollectionMeta,
} from '../../interfaces/rag.js';
import { ImmutableEditStrategy } from '../strategies/edit/immutable.js';

interface Entry {
  rag: IRag;
  editor?: IRagEditor;
  meta: RagCollectionMeta;
}

export class SimpleRagRegistry implements IRagRegistry {
  protected readonly entries = new Map<string, Entry>();

  register(
    name: string,
    rag: IRag,
    editor?: IRagEditor,
    meta?: Omit<RagCollectionMeta, 'name' | 'editable'>,
  ): void {
    if (this.entries.has(name)) {
      throw new Error(`Collection '${name}' is already registered`);
    }
    const editable = Boolean(editor) && !(editor instanceof ImmutableEditStrategy);
    this.entries.set(name, {
      rag,
      editor,
      meta: {
        name,
        displayName: meta?.displayName ?? name,
        description: meta?.description,
        tags: meta?.tags,
        editable,
      },
    });
  }

  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  get(name: string): IRag | undefined {
    return this.entries.get(name)?.rag;
  }

  getEditor(name: string): IRagEditor | undefined {
    return this.entries.get(name)?.editor;
  }

  list(): readonly RagCollectionMeta[] {
    return Array.from(this.entries.values()).map((e) => e.meta);
  }
}
```

```ts
// src/smart-agent/rag/registry/index.ts
export { SimpleRagRegistry } from './simple-rag-registry.js';
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/registry src/smart-agent/rag/__tests__/simple-rag-registry.test.ts
git commit -m "feat(rag): add SimpleRagRegistry"
```

---

## Task 10: Implement `ActiveFilteringRag`

**Files:**
- Create: `src/smart-agent/rag/corrections/active-filtering-rag.ts`
- Create: `src/smart-agent/rag/corrections/index.ts`
- Test: `src/smart-agent/rag/__tests__/active-filtering-rag.test.ts`

- [ ] **Step 1: Failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActiveFilteringRag } from '../corrections/active-filtering-rag.js';
import type { IRag } from '../../interfaces/rag.js';
import type { RagResult } from '../../interfaces/types.js';
import { TextOnlyEmbedding } from '../query-embedding.js';

function stubRag(results: RagResult[]): IRag {
  return {
    query: async () => ({ ok: true, value: results }),
    getById: async (id) => ({
      ok: true,
      value: results.find((r) => r.metadata.id === id) ?? null,
    }),
    healthCheck: async () => ({ ok: true, value: undefined }),
  };
}

describe('ActiveFilteringRag', () => {
  const results: RagResult[] = [
    { text: 'a', metadata: { id: '1', canonicalKey: 'a' }, score: 1 },
    { text: 'b', metadata: { id: '2', canonicalKey: 'b', tags: ['deprecated'] }, score: 0.9 },
    { text: 'c', metadata: { id: '3', canonicalKey: 'c', tags: ['superseded'] }, score: 0.8 },
  ];
  it('hides deprecated and superseded on query by default', async () => {
    const rag = new ActiveFilteringRag(stubRag(results));
    const res = await rag.query(new TextOnlyEmbedding('q'), 10);
    assert.ok(res.ok);
    assert.deepEqual(res.value.map((r) => r.metadata.id), ['1']);
  });
  it('returns all when includeInactive is true', async () => {
    const rag = new ActiveFilteringRag(stubRag(results));
    const res = await rag.query(new TextOnlyEmbedding('q'), 10, {
      ragFilter: { includeInactive: true } as any,
    });
    assert.ok(res.ok && res.value.length === 3);
  });
  it('getById returns null for deprecated by default', async () => {
    const rag = new ActiveFilteringRag(stubRag(results));
    const res = await rag.getById!('2');
    assert.ok(res.ok && res.value === null);
  });
  it('getById returns deprecated when includeInactive is set', async () => {
    const rag = new ActiveFilteringRag(stubRag(results));
    const res = await rag.getById!('2', {
      ragFilter: { includeInactive: true } as any,
    });
    assert.ok(res.ok && res.value !== null);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/corrections/active-filtering-rag.ts
import type { IRag } from '../../interfaces/rag.js';
import type { IQueryEmbedding } from '../../interfaces/query-embedding.js';
import type {
  CallOptions,
  RagError,
  RagResult,
  Result,
} from '../../interfaces/types.js';
import { filterActive, type CorrectionMetadata } from './metadata.js';

function includeInactive(options?: CallOptions): boolean {
  return Boolean(
    (options?.ragFilter as { includeInactive?: boolean } | undefined)
      ?.includeInactive,
  );
}

export class ActiveFilteringRag implements IRag {
  constructor(private readonly inner: IRag) {}

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const res = await this.inner.query(embedding, k, options);
    if (!res.ok) return res;
    const filtered = filterActive(
      res.value,
      (r) => r.metadata as CorrectionMetadata,
      { includeInactive: includeInactive(options) },
    );
    return { ok: true, value: filtered };
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    if (!this.inner.getById) {
      return { ok: true, value: null };
    }
    const res = await this.inner.getById(id, options);
    if (!res.ok || res.value === null) return res;
    const tags = (res.value.metadata as CorrectionMetadata).tags ?? [];
    const inactive = tags.includes('deprecated') || tags.includes('superseded');
    if (inactive && !includeInactive(options)) {
      return { ok: true, value: null };
    }
    return res;
  }

  healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    return this.inner.healthCheck(options);
  }
}
```

```ts
// src/smart-agent/rag/corrections/index.ts
export * from './errors.js';
export * from './metadata.js';
export { ActiveFilteringRag } from './active-filtering-rag.js';
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/corrections src/smart-agent/rag/__tests__/active-filtering-rag.test.ts
git commit -m "feat(rag): add ActiveFilteringRag"
```

---

## Task 11: Implement `OverlayRag` and `SessionScopedRag` (read-side)

**Files:**
- Create: `src/smart-agent/rag/overlays/overlay-rag.ts`
- Create: `src/smart-agent/rag/overlays/session-scoped-rag.ts`
- Create: `src/smart-agent/rag/overlays/index.ts`
- Test: `src/smart-agent/rag/__tests__/overlay-rag.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/smart-agent/rag/__tests__/overlay-rag.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OverlayRag } from '../overlays/overlay-rag.js';
import { SessionScopedRag } from '../overlays/session-scoped-rag.js';
import type { IRag } from '../../interfaces/rag.js';
import type { RagResult } from '../../interfaces/types.js';
import { TextOnlyEmbedding } from '../query-embedding.js';

function stub(results: RagResult[], records: Record<string, RagResult> = {}): IRag {
  return {
    query: async () => ({ ok: true, value: results }),
    getById: async (id) => ({ ok: true, value: records[id] ?? null }),
    healthCheck: async () => ({ ok: true, value: undefined }),
  };
}

describe('OverlayRag.query', () => {
  it('overlay wins on canonicalKey collision regardless of score', async () => {
    const base = stub([
      { text: 'old', metadata: { id: 'b1', canonicalKey: 'k' }, score: 0.99 },
      { text: 'other', metadata: { id: 'b2', canonicalKey: 'x' }, score: 0.5 },
    ]);
    const overlay = stub([
      { text: 'new', metadata: { id: 'o1', canonicalKey: 'k' }, score: 0.1 },
    ]);
    const rag = new OverlayRag(base, overlay);
    const res = await rag.query(new TextOnlyEmbedding('q'), 10);
    assert.ok(res.ok);
    const texts = res.value.map((r) => r.text).sort();
    assert.deepEqual(texts, ['new', 'other']);
  });
});

describe('OverlayRag.getById', () => {
  it('prefers overlay, falls back to base', async () => {
    const base = stub([], { 'b1': { text: 'base', metadata: { id: 'b1' }, score: 1 } });
    const overlay = stub([], { 'o1': { text: 'ovr', metadata: { id: 'o1' }, score: 1 } });
    const rag = new OverlayRag(base, overlay);
    assert.equal((await rag.getById!('o1')).ok && 'ovr', 'ovr');
    assert.equal((await rag.getById!('b1')).ok && 'base', 'base');
    const miss = await rag.getById!('nope');
    assert.ok(miss.ok && miss.value === null);
  });
});

describe('SessionScopedRag', () => {
  it('includes only overlay records matching sessionId', async () => {
    const base = stub([{ text: 'b', metadata: { id: 'b', canonicalKey: 'b' }, score: 1 }]);
    const overlay = stub([
      { text: 'own', metadata: { id: 'o1', canonicalKey: 'x', sessionId: 'S' }, score: 1 },
      { text: 'other', metadata: { id: 'o2', canonicalKey: 'y', sessionId: 'X' }, score: 1 },
    ]);
    const rag = new SessionScopedRag(base, overlay, 'S');
    const res = await rag.query(new TextOnlyEmbedding('q'), 10);
    assert.ok(res.ok);
    const texts = res.value.map((r) => r.text).sort();
    assert.deepEqual(texts, ['b', 'own']);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `OverlayRag`**

```ts
// src/smart-agent/rag/overlays/overlay-rag.ts
import type { IRag } from '../../interfaces/rag.js';
import type { IQueryEmbedding } from '../../interfaces/query-embedding.js';
import type {
  CallOptions,
  RagError,
  RagResult,
  Result,
} from '../../interfaces/types.js';

export class OverlayRag implements IRag {
  constructor(
    protected readonly base: IRag,
    protected readonly overlay: IRag,
  ) {}

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const [baseRes, overlayRes] = await Promise.all([
      this.base.query(embedding, k, options),
      this.overlay.query(embedding, k, options),
    ]);
    if (!baseRes.ok) return baseRes;
    if (!overlayRes.ok) return overlayRes;
    const overlayList = this.filterOverlay(overlayRes.value);
    const overlayKeys = new Set(
      overlayList
        .map((r) => r.metadata.canonicalKey)
        .filter((k): k is string => typeof k === 'string'),
    );
    const baseKept = baseRes.value.filter((r) => {
      const key = r.metadata.canonicalKey;
      return typeof key !== 'string' || !overlayKeys.has(key);
    });
    const merged = [...overlayList, ...baseKept]
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return { ok: true, value: merged };
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    if (this.overlay.getById) {
      const o = await this.overlay.getById(id, options);
      if (!o.ok) return o;
      if (o.value !== null && this.overlayAllows(o.value)) return o;
    }
    if (!this.base.getById) return { ok: true, value: null };
    return this.base.getById(id, options);
  }

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    const [a, b] = await Promise.all([
      this.base.healthCheck(options),
      this.overlay.healthCheck(options),
    ]);
    if (!a.ok) return a;
    return b;
  }

  /** Hook for subclasses to drop overlay rows (e.g. by sessionId). */
  protected filterOverlay(results: RagResult[]): RagResult[] {
    return results;
  }

  protected overlayAllows(_result: RagResult): boolean {
    return true;
  }
}
```

```ts
// src/smart-agent/rag/overlays/session-scoped-rag.ts
import type { IRag } from '../../interfaces/rag.js';
import type { RagResult } from '../../interfaces/types.js';
import { OverlayRag } from './overlay-rag.js';

export class SessionScopedRag extends OverlayRag {
  constructor(
    base: IRag,
    overlay: IRag,
    private readonly sessionId: string,
    private readonly ttlMs?: number,
  ) {
    super(base, overlay);
  }

  protected override filterOverlay(results: RagResult[]): RagResult[] {
    const cutoff =
      this.ttlMs !== undefined ? Date.now() - this.ttlMs : undefined;
    return results.filter((r) => this.matches(r, cutoff));
  }

  protected override overlayAllows(result: RagResult): boolean {
    const cutoff =
      this.ttlMs !== undefined ? Date.now() - this.ttlMs : undefined;
    return this.matches(result, cutoff);
  }

  private matches(result: RagResult, cutoffMs: number | undefined): boolean {
    if (result.metadata.sessionId !== this.sessionId) return false;
    if (cutoffMs !== undefined) {
      const createdMs =
        typeof result.metadata.createdAt === 'number'
          ? result.metadata.createdAt
          : undefined;
      if (createdMs !== undefined && createdMs < cutoffMs) return false;
    }
    return true;
  }
}
```

```ts
// src/smart-agent/rag/overlays/index.ts
export { OverlayRag } from './overlay-rag.js';
export { SessionScopedRag } from './session-scoped-rag.js';
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/overlays src/smart-agent/rag/__tests__/overlay-rag.test.ts
git commit -m "feat(rag): add OverlayRag and SessionScopedRag read-side layers"
```

---

## Task 12: Implement `OverlayEditStrategy` and `SessionScopedEditStrategy`

**Files:**
- Create: `src/smart-agent/rag/strategies/edit/overlay.ts`
- Create: `src/smart-agent/rag/strategies/edit/session-scoped.ts`
- Modify: `src/smart-agent/rag/strategies/edit/index.ts`
- Test: `src/smart-agent/rag/__tests__/edit-strategies-overlay.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/smart-agent/rag/__tests__/edit-strategies-overlay.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OverlayEditStrategy,
  SessionScopedEditStrategy,
} from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy, SessionScopedIdStrategy } from '../strategies/id/index.js';
import type { IRagBackendWriter } from '../../interfaces/rag.js';

function fakeWriter() {
  const rows = new Map<string, { text: string; meta: any }>();
  const writer: IRagBackendWriter = {
    upsertRaw: async (id, text, meta) => {
      rows.set(id, { text, meta });
      return { ok: true, value: undefined };
    },
    deleteByIdRaw: async (id) => ({ ok: true, value: rows.delete(id) }),
  };
  return { writer, rows };
}

describe('OverlayEditStrategy', () => {
  it('writes only to overlay writer', async () => {
    const { writer, rows } = fakeWriter();
    const ed = new OverlayEditStrategy(writer, new GlobalUniqueIdStrategy());
    const res = await ed.upsert('v', { id: 'x' });
    assert.ok(res.ok && res.value.id === 'x');
    assert.equal(rows.size, 1);
  });
});

describe('SessionScopedEditStrategy', () => {
  it('stamps sessionId on every write', async () => {
    const { writer, rows } = fakeWriter();
    const ed = new SessionScopedEditStrategy(
      writer,
      'S',
      new SessionScopedIdStrategy('S'),
    );
    const res = await ed.upsert('v', { id: 'x' });
    assert.ok(res.ok);
    const row = rows.get(res.value.id)!;
    assert.equal(row.meta.sessionId, 'S');
    assert.equal(res.value.id, 'S:x');
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/strategies/edit/overlay.ts
import { DirectEditStrategy } from './direct.js';
import type {
  IIdStrategy,
  IRagBackendWriter,
} from '../../../interfaces/rag.js';

export class OverlayEditStrategy extends DirectEditStrategy {
  constructor(overlayWriter: IRagBackendWriter, idStrategy: IIdStrategy) {
    super(overlayWriter, idStrategy);
  }
}
```

```ts
// src/smart-agent/rag/strategies/edit/session-scoped.ts
import type {
  IIdStrategy,
  IRagBackendWriter,
  IRagEditor,
} from '../../../interfaces/rag.js';
import type {
  CallOptions,
  RagError,
  RagMetadata,
  Result,
} from '../../../interfaces/types.js';
import { MissingIdError } from '../../corrections/errors.js';

export class SessionScopedEditStrategy implements IRagEditor {
  constructor(
    private readonly writer: IRagBackendWriter,
    private readonly sessionId: string,
    private readonly idStrategy: IIdStrategy,
    private readonly ttlMs?: number,
  ) {}

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<{ id: string }, RagError>> {
    const stamped: RagMetadata = {
      ...metadata,
      sessionId: this.sessionId,
      createdAt:
        typeof metadata.createdAt === 'number' ? metadata.createdAt : Date.now(),
    };
    let id: string;
    try {
      id = this.idStrategy.resolve(stamped, text);
    } catch (e) {
      if (e instanceof MissingIdError) return { ok: false, error: e };
      throw e;
    }
    const res = await this.writer.upsertRaw(
      id,
      text,
      { ...stamped, id },
      options,
    );
    return res.ok ? { ok: true, value: { id } } : res;
  }

  async deleteById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<boolean, RagError>> {
    return this.writer.deleteByIdRaw(id, options);
  }
}
```

Update the edit index barrel:

```ts
// src/smart-agent/rag/strategies/edit/index.ts
export { DirectEditStrategy } from './direct.js';
export { ImmutableEditStrategy } from './immutable.js';
export { OverlayEditStrategy } from './overlay.js';
export { SessionScopedEditStrategy } from './session-scoped.js';
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/strategies/edit src/smart-agent/rag/__tests__/edit-strategies-overlay.test.ts
git commit -m "feat(rag): add OverlayEditStrategy and SessionScopedEditStrategy"
```

---

## Task 13: Migrate callers, drop `IRag.upsert` / `IRag.clear`, require `getById`

**Files:**
- Modify: `src/smart-agent/interfaces/rag.ts`
- Modify: `src/smart-agent/rag/in-memory-rag.ts`, `vector-rag.ts`, `qdrant-rag.ts`
- Modify: `src/smart-agent/rag/tool-indexing-strategy.ts`
- Modify: `src/smart-agent/rag/preprocessor.ts`
- Modify: any builder / pipeline code that currently calls `rag.upsert(...)`
- Modify: `src/smart-agent/rag/__tests__/in-memory-rag.test.ts` (and sibling existing tests) to use writer/editor instead of `rag.upsert`

This is the breaking change. Keep the loop tight: find all call sites, switch them to the new API, remove the old methods last.

- [ ] **Step 1: Find all call sites**

Run:
```
rg -n "\.upsert\(" src/ --glob '!**/__tests__/**'
rg -n "rag\.clear\(" src/
```

- [ ] **Step 2: Introduce an editor everywhere `rag.upsert` was called**

For each call site:
- If the caller already has an `IRagRegistry`, use `registry.getEditor(name).upsert(...)`.
- If the caller only has an `IRag` today, inject an `IRagEditor` alongside (widen the constructor / factory signature). Prefer `DirectEditStrategy(rag.writer(), new GlobalUniqueIdStrategy())` as the default for paths that used to just dump records.

Key files:
- `tool-indexing-strategy.ts` — accept `IRagEditor` as a constructor arg, replace `rag.upsert(...)` with `editor.upsert(...)`.
- `preprocessor.ts` — same.
- Any builder in `src/smart-agent/builder.ts` or `providers.ts` that constructs these — plumb the editor through.

- [ ] **Step 3: Update existing tests**

Tests that call `rag.upsert(...)` to seed state must switch to the writer:

```ts
const rag = new InMemoryRag();
const writer = rag.writer();
await writer.upsertRaw('id-1', 'hello world', { id: 'id-1' });
```

Or, for higher-level tests, use a `DirectEditStrategy`.

- [ ] **Step 4: Remove from `IRag`**

Edit `src/smart-agent/interfaces/rag.ts`:

```ts
export interface IRag {
  query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>>;

  getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>>;

  healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
}
```

Delete `upsert` and `clear`. Remove `IPrecomputedVectorRag.upsertPrecomputed` (moved to backend writer; if callers still need it, add it to `IRagBackendWriter` as `upsertPrecomputedRaw` and delete from `IPrecomputedVectorRag`).

- [ ] **Step 5: Remove the old `upsert` / `clear` from each backend** once nothing calls them

- [ ] **Step 6: Run build + all tests**

```
npm run build
node --import tsx/esm --test --test-reporter=spec src/smart-agent/rag/__tests__/*.test.ts
```
Expected: all pass.

- [ ] **Step 7: Commit**

```
git add -A src/smart-agent
git commit -m "refactor(rag)!: drop IRag.upsert/clear; require getById; migrate call sites to IRagEditor

BREAKING CHANGE: IRag no longer exposes upsert or clear. All writes now go
through IRagEditor, typically via a registry. Backends expose a writer()
method returning IRagBackendWriter."
```

---

## Task 14: MCP tool factory

**Files:**
- Create: `src/smart-agent/rag/mcp-tools/rag-collection-tools.ts`
- Create: `src/smart-agent/rag/mcp-tools/index.ts`
- Test: `src/smart-agent/rag/__tests__/rag-collection-tools.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/smart-agent/rag/__tests__/rag-collection-tools.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { DirectEditStrategy, ImmutableEditStrategy } from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy } from '../strategies/id/index.js';
import { buildRagCollectionToolEntries } from '../mcp-tools/rag-collection-tools.js';

describe('buildRagCollectionToolEntries', () => {
  const makeRegistry = () => {
    const reg = new SimpleRagRegistry();
    const rag = new InMemoryRag();
    reg.register('notes', rag, new DirectEditStrategy(rag.writer(), new GlobalUniqueIdStrategy()), { displayName: 'Notes' });
    reg.register('corp', new InMemoryRag(), new ImmutableEditStrategy('corp'), { displayName: 'Corp' });
    return reg;
  };

  it('produces rag_add, rag_correct, rag_deprecate (rag_create_collection omitted by default)', () => {
    const entries = buildRagCollectionToolEntries({ registry: makeRegistry() });
    const names = entries.map((e) => e.toolDefinition.name).sort();
    assert.deepEqual(names, ['rag_add', 'rag_correct', 'rag_deprecate']);
  });

  it('rag_add rejects read-only collection', async () => {
    const entries = buildRagCollectionToolEntries({ registry: makeRegistry() });
    const add = entries.find((e) => e.toolDefinition.name === 'rag_add')!;
    const out = (await add.handler({}, {
      collection: 'corp',
      text: 't',
      canonicalKey: 'k',
    })) as { ok: boolean; error?: string };
    assert.equal(out.ok, false);
    assert.match(out.error!, /read-only/i);
  });

  it('rag_add writes into editable collection', async () => {
    const entries = buildRagCollectionToolEntries({ registry: makeRegistry() });
    const add = entries.find((e) => e.toolDefinition.name === 'rag_add')!;
    const out = (await add.handler({}, {
      collection: 'notes',
      text: 'hello',
      canonicalKey: 'greeting',
    })) as { ok: boolean; id?: string };
    assert.equal(out.ok, true);
    assert.ok(out.id);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/mcp-tools/rag-collection-tools.ts
import { z } from 'zod';
import type { IRagRegistry } from '../../interfaces/rag.js';
import {
  buildCorrectionMetadata,
  deprecateMetadata,
} from '../corrections/metadata.js';

export interface RagToolEntry {
  toolDefinition: {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
  };
  handler: (
    context: object,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

export function buildRagCollectionToolEntries(opts: {
  registry: IRagRegistry;
}): RagToolEntry[] {
  const { registry } = opts;

  const resolveEditor = (name: unknown) => {
    if (typeof name !== 'string') return { ok: false, error: 'collection is required' };
    const editor = registry.getEditor(name);
    if (!editor) return { ok: false, error: `Collection '${name}' is read-only or unknown` };
    return { ok: true as const, editor };
  };

  const addTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_add',
      description: 'Add a new document to a RAG collection.',
      inputSchema: {
        collection: z.string(),
        text: z.string(),
        canonicalKey: z.string(),
        tags: z.array(z.string()).optional(),
      },
    },
    handler: async (_ctx, args) => {
      const r = resolveEditor(args.collection);
      if (!r.ok) return r;
      const res = await r.editor.upsert(String(args.text), {
        canonicalKey: String(args.canonicalKey),
        tags: args.tags as string[] | undefined,
      });
      return res.ok ? { ok: true, id: res.value.id } : { ok: false, error: res.error.message };
    },
  };

  const correctTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_correct',
      description:
        'Supersede a document with a new corrected version. Marks the predecessor as superseded.',
      inputSchema: {
        collection: z.string(),
        predecessorId: z.string(),
        predecessorCanonicalKey: z.string(),
        newText: z.string(),
        reason: z.string(),
      },
    },
    handler: async (_ctx, args) => {
      const r = resolveEditor(args.collection);
      if (!r.ok) return r;
      const predecessorMeta = {
        canonicalKey: String(args.predecessorCanonicalKey),
      };
      // First: upsert the new entry to discover its id.
      const newRes = await r.editor.upsert(String(args.newText), {
        canonicalKey: predecessorMeta.canonicalKey,
      });
      if (!newRes.ok) return { ok: false, error: newRes.error.message };

      const { predecessor } = buildCorrectionMetadata({
        predecessor: predecessorMeta,
        predecessorId: String(args.predecessorId),
        newEntryId: newRes.value.id,
        reason: String(args.reason),
      });
      const supRes = await r.editor.upsert('', {
        ...predecessor,
        id: String(args.predecessorId),
      });
      if (!supRes.ok) return { ok: false, error: supRes.error.message };
      return {
        ok: true,
        predecessorId: String(args.predecessorId),
        newId: newRes.value.id,
      };
    },
  };

  const deprecateTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_deprecate',
      description: 'Mark a document as deprecated (idempotent).',
      inputSchema: {
        collection: z.string(),
        id: z.string(),
        canonicalKey: z.string(),
        reason: z.string(),
      },
    },
    handler: async (_ctx, args) => {
      const r = resolveEditor(args.collection);
      if (!r.ok) return r;
      const meta = deprecateMetadata(
        { canonicalKey: String(args.canonicalKey) },
        String(args.reason),
      );
      const res = await r.editor.upsert('', { ...meta, id: String(args.id) });
      return res.ok ? { ok: true, id: res.value.id } : { ok: false, error: res.error.message };
    },
  };

  return [addTool, correctTool, deprecateTool];
}
```

```ts
// src/smart-agent/rag/mcp-tools/index.ts
export { buildRagCollectionToolEntries, type RagToolEntry } from './rag-collection-tools.js';
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/mcp-tools src/smart-agent/rag/__tests__/rag-collection-tools.test.ts
git commit -m "feat(rag): add buildRagCollectionToolEntries MCP factory"
```

---

## Task 15: Public API + version bump

**Files:**
- Modify: `src/smart-agent/rag/index.ts`
- Modify: `src/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Re-export new modules from `src/smart-agent/rag/index.ts`**

Add:
```ts
export * from './corrections/index.js';
export * from './registry/index.js';
export * from './overlays/index.js';
export * from './strategies/edit/index.js';
export * from './strategies/id/index.js';
export * from './mcp-tools/index.js';
```

Check for existing exports — keep those intact; just append.

- [ ] **Step 2: Add top-level exports in `src/index.ts`**

Re-export `IRagEditor`, `IIdStrategy`, `IRagRegistry`, `RagCollectionMeta`, `IRagBackendWriter`, strategies, `SimpleRagRegistry`, corrections, `ActiveFilteringRag`, overlay rags, `buildRagCollectionToolEntries`, error types.

- [ ] **Step 3: Bump version**

```
npm version major --no-git-tag-version
```
Expected: `package.json` at `9.0.0`.

- [ ] **Step 4: Commit**

```
git add src/smart-agent/rag/index.ts src/index.ts package.json package-lock.json
git commit -m "chore: release 9.0.0 - RAG registry + corrections layer"
```

---

## Task 16: Final verification

- [ ] **Step 1: Full build**

```
npm run build
```
Expected: clean build.

- [ ] **Step 2: Full test run**

```
node --import tsx/esm --test --test-reporter=spec src/smart-agent/rag/__tests__/*.test.ts
```
Expected: all pass.

- [ ] **Step 3: Lint**

```
npm run lint
```
Expected: clean (auto-fix what Biome rewrites).

- [ ] **Step 4: Smoke test**

```
npm run test
```
(Which runs `build + start` per CLAUDE.md.)

- [ ] **Step 5: Spec grep**

Scan the spec one more time; confirm every named entity exists in the codebase:

```
rg -n "IRagEditor|IRagRegistry|IIdStrategy|IRagBackendWriter|SimpleRagRegistry|OverlayRag|SessionScopedRag|DirectEditStrategy|ImmutableEditStrategy|OverlayEditStrategy|SessionScopedEditStrategy|CallerProvidedIdStrategy|GlobalUniqueIdStrategy|SessionScopedIdStrategy|CanonicalKeyIdStrategy|ActiveFilteringRag|buildRagCollectionToolEntries|ReadOnlyError|MissingIdError" src/
```

- [ ] **Step 6: Delete the spec + plan once the PR is merged** (per retention policy: spec/plan live in git only while work is in progress).

---

## Notes

- **No `ExpositionFilteringRag` coupling.** `ActiveFilteringRag` is independent — consumers compose them externally if needed.
- **`rag_create_collection`** intentionally omitted from Task 14. If a consumer needs it, they pass a collection-factory hook and the factory adds a fourth entry. Ship that in a follow-up; design already supports it without breaking.
- **Overlay TTL** uses `metadata.createdAt` (milliseconds). If `createdAt` isn't stamped, TTL filtering is skipped for that record (lenient). Stamping happens in `SessionScopedEditStrategy.upsert`.
- **`CanonicalKeyCollisionError`** is declared but not thrown anywhere in this plan — it's reserved for a future strict-overlay variant. Do not remove it; that's the single source of truth if/when we add strict mode.
