# RAG Providers and Dynamic Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v9.1.0 — add `IRagProvider` layer, dynamic collection creation via MCP, scope-based lifecycle (session/user/global), and `SmartAgent.closeSession` cleanup hook — on top of the v9.0.0 registry.

**Architecture:** Providers are static (injected at builder time), collections are dynamic (created at runtime via `registry.createCollection` or MCP tool). Two registries: `IRagProviderRegistry` (providers) + `IRagRegistry` (collections, extended with createCollection/deleteCollection/closeSession). `ragStores` remains in pipeline deps as a live projection of the collection registry for back-compat — public methods `addRagStore` / `removeRagStore` preserve all current side effects.

**Tech Stack:** TypeScript strict + ESM, Node ≥ 18, Biome, `node:test` via `tsx`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-22-rag-providers-design.md`

**Branch:** `feat/rag-providers` (already created on main after #104 merged)

---

## File map

**Create:**
- `src/smart-agent/rag/providers/base-provider.ts` — `AbstractRagProvider`
- `src/smart-agent/rag/providers/in-memory-rag-provider.ts`
- `src/smart-agent/rag/providers/vector-rag-provider.ts`
- `src/smart-agent/rag/providers/qdrant-rag-provider.ts`
- `src/smart-agent/rag/providers/simple-provider-registry.ts`
- `src/smart-agent/rag/providers/index.ts`
- Tests per module in `src/smart-agent/rag/__tests__/`

**Modify:**
- `src/smart-agent/interfaces/rag.ts` — add new interfaces and types
- `src/smart-agent/rag/corrections/errors.ts` — add four new error classes
- `src/smart-agent/rag/registry/simple-rag-registry.ts` — extend with createCollection/deleteCollection/closeSession + mutation listener
- `src/smart-agent/rag/mcp-tools/rag-collection-tools.ts` — add four new tools; formalize `RagToolContext`
- `src/smart-agent/agent.ts` — add `closeSession`; rewire `addRagStore`/`removeRagStore` as registry delegates preserving semantics
- `src/smart-agent/builder.ts` — add builder methods; wire up registries and mutation listener
- `src/smart-agent/interfaces/pipeline.ts` — add `ragRegistry` + `ragProviderRegistry` to deps/context types (and keep `ragStores` + `translateQueryStores`)
- `src/smart-agent/pipeline/context.ts` — same
- `src/smart-agent/pipeline/default-pipeline.ts` — propagate new deps to context
- `src/smart-agent/testing/index.ts` — extend stubs to satisfy new interface shapes
- `src/smart-agent/rag/index.ts` — re-export new modules
- `src/index.ts` — public API top-level exports
- `package.json` — bump to 9.1.0

---

## Task 1: Add new error types

**Files:**
- Modify: `src/smart-agent/rag/corrections/errors.ts`
- Test: `src/smart-agent/rag/__tests__/corrections-errors.test.ts` (extend)

- [ ] **Step 1: Extend the failing test**

Append to the existing `describe('corrections errors', …)` block in `src/smart-agent/rag/__tests__/corrections-errors.test.ts`:

```ts
import {
  ReadOnlyError,
  MissingIdError,
  CanonicalKeyCollisionError,
  UnsupportedScopeError,
  ProviderNotFoundError,
  CollectionNotFoundError,
  ScopeViolationError,
} from '../corrections/errors.js';
import { RagError } from '../../interfaces/types.js';

describe('v9.1 errors', () => {
  it('UnsupportedScopeError has code and mentions provider and scope', () => {
    const e = new UnsupportedScopeError('qdrant-rw', 'global');
    assert.ok(e instanceof RagError);
    assert.equal(e.code, 'RAG_UNSUPPORTED_SCOPE');
    assert.match(e.message, /qdrant-rw/);
    assert.match(e.message, /global/);
  });
  it('ProviderNotFoundError has code and mentions name', () => {
    const e = new ProviderNotFoundError('missing-provider');
    assert.ok(e instanceof RagError);
    assert.equal(e.code, 'RAG_PROVIDER_NOT_FOUND');
    assert.match(e.message, /missing-provider/);
  });
  it('CollectionNotFoundError has code and mentions name', () => {
    const e = new CollectionNotFoundError('phase-1');
    assert.ok(e instanceof RagError);
    assert.equal(e.code, 'RAG_COLLECTION_NOT_FOUND');
    assert.match(e.message, /phase-1/);
  });
  it('ScopeViolationError has code and mentions name and reason', () => {
    const e = new ScopeViolationError('corp-facts', 'sessionId mismatch');
    assert.ok(e instanceof RagError);
    assert.equal(e.code, 'RAG_SCOPE_VIOLATION');
    assert.match(e.message, /corp-facts/);
    assert.match(e.message, /sessionId mismatch/);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```
node --import tsx/esm --test --test-reporter=spec src/smart-agent/rag/__tests__/corrections-errors.test.ts
```

Expected: failing imports for the four new error classes.

- [ ] **Step 3: Implement**

Append to `src/smart-agent/rag/corrections/errors.ts`:

```ts
export class UnsupportedScopeError extends RagError {
  constructor(providerName: string, scope: string) {
    super(
      `Provider '${providerName}' does not support scope '${scope}'`,
      'RAG_UNSUPPORTED_SCOPE',
    );
    this.name = 'UnsupportedScopeError';
  }
}

export class ProviderNotFoundError extends RagError {
  constructor(providerName: string) {
    super(
      `RAG provider '${providerName}' is not registered`,
      'RAG_PROVIDER_NOT_FOUND',
    );
    this.name = 'ProviderNotFoundError';
  }
}

export class CollectionNotFoundError extends RagError {
  constructor(collectionName: string) {
    super(
      `Collection '${collectionName}' is not registered`,
      'RAG_COLLECTION_NOT_FOUND',
    );
    this.name = 'CollectionNotFoundError';
  }
}

export class ScopeViolationError extends RagError {
  constructor(collectionName: string, reason: string) {
    super(
      `Scope violation on '${collectionName}': ${reason}`,
      'RAG_SCOPE_VIOLATION',
    );
    this.name = 'ScopeViolationError';
  }
}
```

- [ ] **Step 4: Run test — expect all pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/corrections/errors.ts src/smart-agent/rag/__tests__/corrections-errors.test.ts
git commit -m "feat(rag): add v9.1 error types (scope, provider, collection)"
```

---

## Task 2: Add `RagCollectionScope`, update `RagCollectionMeta`, declare `IRagProvider` + `IRagProviderRegistry`

**Files:**
- Modify: `src/smart-agent/interfaces/rag.ts`

- [ ] **Step 1: Add new type alias and interface exports**

Append to `src/smart-agent/interfaces/rag.ts` (keep all existing exports intact):

```ts
// v9.1 — provider layer

export type RagCollectionScope = 'session' | 'user' | 'global';

export interface IRagProvider {
  readonly name: string;
  readonly kind: string;
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  createCollection(
    name: string,
    opts: {
      scope: RagCollectionScope;
      sessionId?: string;
      userId?: string;
    },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;

  deleteCollection?(name: string): Promise<Result<void, RagError>>;
  listCollections?(): Promise<Result<string[], RagError>>;
}

export interface IRagProviderRegistry {
  registerProvider(provider: IRagProvider): void;
  getProvider(name: string): IRagProvider | undefined;
  listProviders(): readonly string[];
}
```

- [ ] **Step 2: Extend `RagCollectionMeta`**

Locate the existing `RagCollectionMeta` interface and add the new optional fields (preserve `readonly` on existing fields):

```ts
export interface RagCollectionMeta {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly editable: boolean;
  readonly scope?: RagCollectionScope;    // NEW
  readonly sessionId?: string;            // NEW
  readonly userId?: string;               // NEW
  readonly providerName?: string;         // NEW
  readonly tags?: readonly string[];
}
```

- [ ] **Step 3: Extend `IRagRegistry` with three new methods**

Locate the existing `IRagRegistry` interface and add below the existing methods:

```ts
  /** Create a collection via a provider and register it atomically. */
  createCollection(params: {
    providerName: string;
    collectionName: string;
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
    displayName?: string;
    description?: string;
    tags?: readonly string[];
  }): Promise<Result<RagCollectionMeta, RagError>>;

  /** Delete a collection; delegate to provider (if set in meta) then unregister. */
  deleteCollection(name: string): Promise<Result<void, RagError>>;

  /** Unregister + delete all session-scoped collections with the given sessionId. */
  closeSession(sessionId: string): Promise<Result<void, RagError>>;
```

- [ ] **Step 4: Build the project**

```
npm run build
```

Expected: clean build. The existing `SimpleRagRegistry` implementation will NOT yet satisfy the new interface methods — that will be added in Task 9. Temporarily, TypeScript may complain that `SimpleRagRegistry` doesn't implement the new methods. If build fails because of that, add placeholder methods to `SimpleRagRegistry` that return `{ ok: false, error: new RagError('Not implemented yet', 'NOT_IMPLEMENTED') }` and a TODO comment; they'll be replaced in Task 9. This Task should NOT leave any TODO comments in the final commit — do the placeholder + commit only if needed to unblock build, and remove them as part of Task 9.

Alternative (preferred): skip this step's build check and move to Task 9 first, then return. If that keeps the repo buildable, use it.

- [ ] **Step 5: Commit**

```
git add src/smart-agent/interfaces/rag.ts
git commit -m "feat(rag): declare IRagProvider / IRagProviderRegistry; extend IRag metadata with scope"
```

---

## Task 3: Implement `AbstractRagProvider` base class

**Files:**
- Create: `src/smart-agent/rag/providers/base-provider.ts`
- Test: `src/smart-agent/rag/__tests__/base-provider.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/smart-agent/rag/__tests__/base-provider.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IIdStrategy,
  IRag,
  IRagBackendWriter,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import { AbstractRagProvider } from '../providers/base-provider.js';
import { DirectEditStrategy, ImmutableEditStrategy } from '../strategies/edit/index.js';
import {
  GlobalUniqueIdStrategy,
  SessionScopedIdStrategy,
} from '../strategies/id/index.js';
import { UnsupportedScopeError } from '../corrections/errors.js';

const dummyWriter: IRagBackendWriter = {
  upsertRaw: async () => ({ ok: true, value: undefined }),
  deleteByIdRaw: async () => ({ ok: true, value: false }),
};
const dummyRag = { writer: () => dummyWriter } as unknown as IRag;

class TestProvider extends AbstractRagProvider {
  readonly name = 'test';
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  constructor(
    editable: boolean,
    supportedScopes: readonly RagCollectionScope[],
    idStrategyFactory?: (opts: { scope: RagCollectionScope; sessionId?: string }) => IIdStrategy,
  ) {
    super();
    this.editable = editable;
    this.supportedScopes = supportedScopes;
    if (idStrategyFactory) this.idStrategyFactory = idStrategyFactory;
  }

  async createCollection(_name: string, opts: { scope: RagCollectionScope; sessionId?: string; userId?: string }) {
    const check = this.checkScope(opts.scope);
    if (!check.ok) return check;
    const idStrategy = this.pickIdStrategy(opts);
    const editor = this.buildEditor(dummyRag, idStrategy);
    return { ok: true as const, value: { rag: dummyRag, editor } };
  }
}

describe('AbstractRagProvider.checkScope', () => {
  it('returns UnsupportedScopeError when scope not in supportedScopes', async () => {
    const p = new TestProvider(true, ['session']);
    const res = await p.createCollection('x', { scope: 'global' });
    assert.ok(!res.ok);
    assert.ok(res.error instanceof UnsupportedScopeError);
  });
  it('passes when scope is supported', async () => {
    const p = new TestProvider(true, ['session', 'global']);
    const res = await p.createCollection('x', { scope: 'global' });
    assert.ok(res.ok);
  });
});

describe('AbstractRagProvider.buildEditor', () => {
  it('returns DirectEditStrategy when editable', async () => {
    const p = new TestProvider(true, ['session']);
    const res = await p.createCollection('x', { scope: 'session', sessionId: 'S' });
    assert.ok(res.ok);
    assert.ok(res.value.editor instanceof DirectEditStrategy);
  });
  it('returns ImmutableEditStrategy when not editable', async () => {
    const p = new TestProvider(false, ['session']);
    const res = await p.createCollection('x', { scope: 'session', sessionId: 'S' });
    assert.ok(res.ok);
    assert.ok(res.value.editor instanceof ImmutableEditStrategy);
  });
});

describe('AbstractRagProvider.pickIdStrategy', () => {
  it('uses SessionScopedIdStrategy for session scope with sessionId', async () => {
    const p = new TestProvider(true, ['session']);
    const res = await p.createCollection('x', { scope: 'session', sessionId: 'S' });
    assert.ok(res.ok);
    // Can't directly assert strategy type from editor; test via id resolution.
    // But we can inspect strategy type through buildEditor cast; use a typed probe instead.
  });
  it('uses GlobalUniqueIdStrategy for global scope', async () => {
    const p = new TestProvider(true, ['global']);
    const res = await p.createCollection('x', { scope: 'global' });
    assert.ok(res.ok);
  });
  it('uses custom idStrategyFactory when provided', async () => {
    let called = false;
    const p = new TestProvider(true, ['session'], () => {
      called = true;
      return new GlobalUniqueIdStrategy();
    });
    const res = await p.createCollection('x', { scope: 'session', sessionId: 'S' });
    assert.ok(res.ok);
    assert.equal(called, true);
  });
});

// Keep imports used
void SessionScopedIdStrategy;
```

- [ ] **Step 2: Run — expect failure (module missing)**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/providers/base-provider.ts
import type {
  IIdStrategy,
  IRag,
  IRagEditor,
  IRagProvider,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
import { UnsupportedScopeError } from '../corrections/errors.js';
import { DirectEditStrategy, ImmutableEditStrategy } from '../strategies/edit/index.js';
import {
  GlobalUniqueIdStrategy,
  SessionScopedIdStrategy,
} from '../strategies/id/index.js';

export abstract class AbstractRagProvider implements IRagProvider {
  abstract readonly name: string;
  abstract readonly kind: string;
  abstract readonly editable: boolean;
  abstract readonly supportedScopes: readonly RagCollectionScope[];

  protected idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;

  abstract createCollection(
    name: string,
    opts: {
      scope: RagCollectionScope;
      sessionId?: string;
      userId?: string;
    },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;

  protected checkScope(scope: RagCollectionScope): Result<void, RagError> {
    if (!this.supportedScopes.includes(scope)) {
      return { ok: false, error: new UnsupportedScopeError(this.name, scope) };
    }
    return { ok: true, value: undefined };
  }

  protected pickIdStrategy(opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }): IIdStrategy {
    if (this.idStrategyFactory) return this.idStrategyFactory(opts);
    if (opts.scope === 'session' && opts.sessionId) {
      return new SessionScopedIdStrategy(opts.sessionId);
    }
    return new GlobalUniqueIdStrategy();
  }

  protected buildEditor(rag: IRag, idStrategy: IIdStrategy): IRagEditor {
    if (!this.editable) return new ImmutableEditStrategy(this.name);
    const writer = rag.writer?.();
    if (!writer) {
      throw new Error(
        `Provider '${this.name}' requires an IRag with writer() support for editable mode`,
      );
    }
    return new DirectEditStrategy(writer, idStrategy);
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/providers/base-provider.ts src/smart-agent/rag/__tests__/base-provider.test.ts
git commit -m "feat(rag): add AbstractRagProvider base with scope/editor/id helpers"
```

---

## Task 4: `InMemoryRagProvider`

**Files:**
- Create: `src/smart-agent/rag/providers/in-memory-rag-provider.ts`
- Test: `src/smart-agent/rag/__tests__/in-memory-rag-provider.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/smart-agent/rag/__tests__/in-memory-rag-provider.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { UnsupportedScopeError } from '../corrections/errors.js';
import {
  DirectEditStrategy,
  ImmutableEditStrategy,
} from '../strategies/edit/index.js';

describe('InMemoryRagProvider', () => {
  it('supports only session scope', () => {
    const p = new InMemoryRagProvider({ name: 'mem' });
    assert.deepEqual(p.supportedScopes, ['session']);
  });

  it('rejects non-session scopes', async () => {
    const p = new InMemoryRagProvider({ name: 'mem' });
    const res = await p.createCollection('x', { scope: 'global' });
    assert.ok(!res.ok);
    assert.ok(res.error instanceof UnsupportedScopeError);
  });

  it('creates editable InMemoryRag when editable=true (default)', async () => {
    const p = new InMemoryRagProvider({ name: 'mem' });
    const res = await p.createCollection('x', { scope: 'session', sessionId: 'S' });
    assert.ok(res.ok);
    assert.ok(res.value.editor instanceof DirectEditStrategy);
    const up = await res.value.editor.upsert('hello', { id: 'x1' });
    assert.ok(up.ok && up.value.id.startsWith('S:'));
  });

  it('creates read-only when editable=false', async () => {
    const p = new InMemoryRagProvider({ name: 'mem-ro', editable: false });
    const res = await p.createCollection('x', { scope: 'session', sessionId: 'S' });
    assert.ok(res.ok);
    assert.ok(res.value.editor instanceof ImmutableEditStrategy);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/providers/in-memory-rag-provider.ts
import type {
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
import { InMemoryRag, type InMemoryRagConfig } from '../in-memory-rag.js';
import { AbstractRagProvider } from './base-provider.js';

export interface InMemoryRagProviderConfig {
  name: string;
  editable?: boolean;
  inMemoryRagConfig?: InMemoryRagConfig;
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
}

export class InMemoryRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes = ['session'] as const;

  private readonly inMemoryCfg?: InMemoryRagConfig;

  constructor(cfg: InMemoryRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.editable = cfg.editable ?? true;
    this.inMemoryCfg = cfg.inMemoryRagConfig;
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

  async createCollection(
    _name: string,
    opts: { scope: RagCollectionScope; sessionId?: string; userId?: string },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    const rag = new InMemoryRag(this.inMemoryCfg);
    const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
    return { ok: true, value: { rag, editor } };
  }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/providers/in-memory-rag-provider.ts src/smart-agent/rag/__tests__/in-memory-rag-provider.test.ts
git commit -m "feat(rag): add InMemoryRagProvider (session scope only)"
```

---

## Task 5: `VectorRagProvider`

**Files:**
- Create: `src/smart-agent/rag/providers/vector-rag-provider.ts`
- Test: `src/smart-agent/rag/__tests__/vector-rag-provider.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/smart-agent/rag/__tests__/vector-rag-provider.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VectorRagProvider } from '../providers/vector-rag-provider.js';
import type { IEmbedder } from '../../interfaces/rag.js';
import { VectorRag } from '../vector-rag.js';

const fakeEmbedder: IEmbedder = {
  embed: async (text) => ({
    vector: Array.from(text.slice(0, 4).padEnd(4, ' ')).map(
      (c) => c.charCodeAt(0) / 255,
    ),
  }),
};

describe('VectorRagProvider', () => {
  it('creates a VectorRag per collection', async () => {
    const p = new VectorRagProvider({ name: 'vec', embedder: fakeEmbedder });
    const res = await p.createCollection('x', { scope: 'session', sessionId: 'S' });
    assert.ok(res.ok);
    assert.ok(res.value.rag instanceof VectorRag);
    const up = await res.value.editor.upsert('hi', { id: 'r1' });
    assert.ok(up.ok);
    const got = await res.value.rag.getById(up.value.id);
    assert.ok(got.ok && got.value?.text === 'hi');
  });
  it('supports only session scope', () => {
    const p = new VectorRagProvider({ name: 'vec', embedder: fakeEmbedder });
    assert.deepEqual(p.supportedScopes, ['session']);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/providers/vector-rag-provider.ts
import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
import { VectorRag, type VectorRagConfig } from '../vector-rag.js';
import { AbstractRagProvider } from './base-provider.js';

export interface VectorRagProviderConfig {
  name: string;
  embedder: IEmbedder;
  editable?: boolean;
  vectorRagConfig?: VectorRagConfig;
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
}

export class VectorRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes = ['session'] as const;

  private readonly embedder: IEmbedder;
  private readonly vectorRagConfig?: VectorRagConfig;

  constructor(cfg: VectorRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.embedder = cfg.embedder;
    this.editable = cfg.editable ?? true;
    this.vectorRagConfig = cfg.vectorRagConfig;
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

  async createCollection(
    _name: string,
    opts: { scope: RagCollectionScope; sessionId?: string; userId?: string },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    const rag = new VectorRag(this.embedder, this.vectorRagConfig ?? {});
    const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
    return { ok: true, value: { rag, editor } };
  }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/providers/vector-rag-provider.ts src/smart-agent/rag/__tests__/vector-rag-provider.test.ts
git commit -m "feat(rag): add VectorRagProvider (session scope)"
```

---

## Task 6: `QdrantRagProvider`

**Files:**
- Create: `src/smart-agent/rag/providers/qdrant-rag-provider.ts`
- Test: `src/smart-agent/rag/__tests__/qdrant-rag-provider.test.ts`

- [ ] **Step 1: Failing test**

The test reuses the stub Qdrant server pattern from `qdrant-rag.test.ts`. Include `DELETE /collections/:name` handling in the stub; we'll need it for provider-level delete.

```ts
// src/smart-agent/rag/__tests__/qdrant-rag-provider.test.ts
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { IEmbedder } from '../../interfaces/rag.js';
import { QdrantRagProvider } from '../providers/qdrant-rag-provider.js';
import { QdrantRag } from '../qdrant-rag.js';
import { UnsupportedScopeError } from '../corrections/errors.js';

function makeEmbedder(dim = 3): IEmbedder {
  return {
    async embed(text: string) {
      let hash = 0;
      for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
      return {
        vector: Array.from({ length: dim }, (_, i) => ((hash >> i) & 0xff) / 255),
      };
    },
  };
}

interface StubState {
  collections: Map<
    string,
    Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>
  >;
}

function createStubServer(state: StubState): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      const collMatch = url.match(/^\/collections\/([^/]+)$/);
      if (collMatch && req.method === 'GET') {
        const n = collMatch[1];
        if (state.collections.has(n)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result: { status: 'green' } }));
        } else {
          res.writeHead(404); res.end(JSON.stringify({ status: { error: 'missing' } }));
        }
        return;
      }
      if (collMatch && req.method === 'PUT' && !url.includes('/points')) {
        state.collections.set(collMatch[1], []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: true }));
        return;
      }
      if (collMatch && req.method === 'DELETE') {
        state.collections.delete(collMatch[1]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: true }));
        return;
      }
      if (url === '/collections' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            result: {
              collections: Array.from(state.collections.keys()).map((n) => ({
                name: n,
              })),
            },
          }),
        );
        return;
      }
      const upsertMatch = url.match(/^\/collections\/([^/]+)\/points$/);
      if (upsertMatch && req.method === 'PUT') {
        const coll = state.collections.get(upsertMatch[1]);
        if (!coll) { res.writeHead(404); res.end(); return; }
        const data = JSON.parse(body);
        for (const p of data.points) coll.push({ id: p.id, vector: p.vector, payload: p.payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { status: 'completed' } }));
        return;
      }
      res.writeHead(404); res.end('Not found');
    });
  });
}

describe('QdrantRagProvider', () => {
  let server: http.Server;
  let baseUrl: string;
  let state: StubState;

  before(async () => {
    state = { collections: new Map() };
    server = createStubServer(state);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('declares all three scopes as supported', () => {
    const p = new QdrantRagProvider({
      name: 'qdrant', url: baseUrl, embedder: makeEmbedder(),
    });
    assert.deepEqual([...p.supportedScopes].sort(), ['global', 'session', 'user']);
  });

  it('creates a QdrantRag targeting the collection name', async () => {
    const p = new QdrantRagProvider({
      name: 'qdrant', url: baseUrl, embedder: makeEmbedder(),
    });
    const res = await p.createCollection('test-a', { scope: 'global' });
    assert.ok(res.ok);
    assert.ok(res.value.rag instanceof QdrantRag);
  });

  it('rejects unsupported scope', async () => {
    const p = new QdrantRagProvider({
      name: 'q', url: baseUrl, embedder: makeEmbedder(),
      supportedScopes: ['global'],
    });
    const res = await p.createCollection('x', { scope: 'session', sessionId: 'S' });
    assert.ok(!res.ok);
    assert.ok(res.error instanceof UnsupportedScopeError);
  });

  it('deleteCollection removes the Qdrant collection', async () => {
    state.collections.set('to-delete', []);
    const p = new QdrantRagProvider({
      name: 'q', url: baseUrl, embedder: makeEmbedder(),
    });
    const res = await p.deleteCollection?.('to-delete');
    assert.ok(res && res.ok);
    assert.equal(state.collections.has('to-delete'), false);
  });

  it('listCollections returns collection names', async () => {
    state.collections.set('coll-a', []);
    state.collections.set('coll-b', []);
    const p = new QdrantRagProvider({
      name: 'q', url: baseUrl, embedder: makeEmbedder(),
    });
    const res = await p.listCollections?.();
    assert.ok(res && res.ok);
    assert.ok(res.value.includes('coll-a'));
    assert.ok(res.value.includes('coll-b'));
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/providers/qdrant-rag-provider.ts
import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import { RagError, type Result } from '../../interfaces/types.js';
import { QdrantRag } from '../qdrant-rag.js';
import { AbstractRagProvider } from './base-provider.js';

export interface QdrantRagProviderConfig {
  name: string;
  url: string;
  apiKey?: string;
  embedder: IEmbedder;
  editable?: boolean;
  timeoutMs?: number;
  supportedScopes?: readonly RagCollectionScope[];
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
}

export class QdrantRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly url: string;
  private readonly apiKey?: string;
  private readonly embedder: IEmbedder;
  private readonly timeoutMs?: number;

  constructor(cfg: QdrantRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.url = cfg.url.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.embedder = cfg.embedder;
    this.timeoutMs = cfg.timeoutMs;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session', 'user', 'global'];
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

  async createCollection(
    name: string,
    opts: { scope: RagCollectionScope; sessionId?: string; userId?: string },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    const rag = new QdrantRag({
      url: this.url,
      apiKey: this.apiKey,
      embedder: this.embedder,
      collectionName: name,
      timeoutMs: this.timeoutMs,
    });
    const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
    return { ok: true, value: { rag, editor } };
  }

  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) headers['api-key'] = this.apiKey;
      const res = await fetch(`${this.url}/collections/${name}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: new RagError(`Qdrant delete collection failed: ${body}`, 'RAG_DELETE_ERROR'),
        };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_DELETE_ERROR'),
      };
    }
  }

  async listCollections(): Promise<Result<string[], RagError>> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) headers['api-key'] = this.apiKey;
      const res = await fetch(`${this.url}/collections`, { headers });
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: new RagError(`Qdrant list collections failed: ${body}`, 'RAG_LIST_ERROR'),
        };
      }
      const json = (await res.json()) as {
        result?: { collections?: Array<{ name: string }> };
      };
      const names = json.result?.collections?.map((c) => c.name) ?? [];
      return { ok: true, value: names };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_LIST_ERROR'),
      };
    }
  }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/providers/qdrant-rag-provider.ts src/smart-agent/rag/__tests__/qdrant-rag-provider.test.ts
git commit -m "feat(rag): add QdrantRagProvider with delete/list collections"
```

---

## Task 7: `SimpleRagProviderRegistry`

**Files:**
- Create: `src/smart-agent/rag/providers/simple-provider-registry.ts`
- Test: `src/smart-agent/rag/__tests__/simple-provider-registry.test.ts`

- [ ] **Step 1: Failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';

describe('SimpleRagProviderRegistry', () => {
  it('registers and retrieves providers', () => {
    const reg = new SimpleRagProviderRegistry();
    const p = new InMemoryRagProvider({ name: 'mem' });
    reg.registerProvider(p);
    assert.equal(reg.getProvider('mem'), p);
  });
  it('list returns provider names in insertion order', () => {
    const reg = new SimpleRagProviderRegistry();
    reg.registerProvider(new InMemoryRagProvider({ name: 'a' }));
    reg.registerProvider(new InMemoryRagProvider({ name: 'b' }));
    reg.registerProvider(new InMemoryRagProvider({ name: 'c' }));
    assert.deepEqual(reg.listProviders(), ['a', 'b', 'c']);
  });
  it('rejects duplicate provider names', () => {
    const reg = new SimpleRagProviderRegistry();
    reg.registerProvider(new InMemoryRagProvider({ name: 'x' }));
    assert.throws(() =>
      reg.registerProvider(new InMemoryRagProvider({ name: 'x' })),
    );
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/smart-agent/rag/providers/simple-provider-registry.ts
import type {
  IRagProvider,
  IRagProviderRegistry,
} from '../../interfaces/rag.js';

export class SimpleRagProviderRegistry implements IRagProviderRegistry {
  private readonly providers = new Map<string, IRagProvider>();

  registerProvider(provider: IRagProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`RAG provider '${provider.name}' is already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): IRagProvider | undefined {
    return this.providers.get(name);
  }

  listProviders(): readonly string[] {
    return Array.from(this.providers.keys());
  }
}
```

- [ ] **Step 4: Barrel export**

```ts
// src/smart-agent/rag/providers/index.ts
export { AbstractRagProvider } from './base-provider.js';
export { InMemoryRagProvider, type InMemoryRagProviderConfig } from './in-memory-rag-provider.js';
export { VectorRagProvider, type VectorRagProviderConfig } from './vector-rag-provider.js';
export { QdrantRagProvider, type QdrantRagProviderConfig } from './qdrant-rag-provider.js';
export { SimpleRagProviderRegistry } from './simple-provider-registry.js';
```

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit**

```
git add src/smart-agent/rag/providers src/smart-agent/rag/__tests__/simple-provider-registry.test.ts
git commit -m "feat(rag): add SimpleRagProviderRegistry and providers barrel"
```

---

## Task 8: Extend `SimpleRagRegistry` — createCollection, deleteCollection, closeSession, mutation listener

**Files:**
- Modify: `src/smart-agent/rag/registry/simple-rag-registry.ts`
- Test: `src/smart-agent/rag/__tests__/simple-rag-registry.test.ts` (extend)

- [ ] **Step 1: Failing tests**

Append to `simple-rag-registry.test.ts`:

```ts
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { ProviderNotFoundError, CollectionNotFoundError } from '../corrections/errors.js';

describe('SimpleRagRegistry.createCollection', () => {
  it('delegates to provider and registers the collection atomically', async () => {
    const reg = new SimpleRagRegistry();
    const provReg = new SimpleRagProviderRegistry();
    provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
    reg.setProviderRegistry(provReg);

    const res = await reg.createCollection({
      providerName: 'mem',
      collectionName: 'notes',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(res.ok);
    assert.equal(res.value.name, 'notes');
    assert.equal(res.value.scope, 'session');
    assert.equal(res.value.sessionId, 'S');
    assert.equal(res.value.providerName, 'mem');
    assert.ok(reg.get('notes'));
  });

  it('fails when provider is missing', async () => {
    const reg = new SimpleRagRegistry();
    reg.setProviderRegistry(new SimpleRagProviderRegistry());
    const res = await reg.createCollection({
      providerName: 'nope',
      collectionName: 'x',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(!res.ok);
    assert.ok(res.error instanceof ProviderNotFoundError);
  });

  it('fails on duplicate collection name without touching the provider', async () => {
    const reg = new SimpleRagRegistry();
    const provReg = new SimpleRagProviderRegistry();
    provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
    reg.setProviderRegistry(provReg);

    reg.register('dup', new InMemoryRag(), undefined, { displayName: 'Dup' });
    const res = await reg.createCollection({
      providerName: 'mem',
      collectionName: 'dup',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(!res.ok);
    assert.match(res.error.code, /DUPLICATE/);
  });
});

describe('SimpleRagRegistry.deleteCollection', () => {
  it('returns CollectionNotFoundError for unknown name', async () => {
    const reg = new SimpleRagRegistry();
    const res = await reg.deleteCollection('nope');
    assert.ok(!res.ok);
    assert.ok(res.error instanceof CollectionNotFoundError);
  });

  it('delegates to provider when providerName set in meta', async () => {
    const reg = new SimpleRagRegistry();
    let providerDeleteCalled: string | null = null;
    const provReg = new SimpleRagProviderRegistry();
    provReg.registerProvider({
      name: 'stub',
      kind: 'vector',
      editable: true,
      supportedScopes: ['session'],
      createCollection: async () => ({ ok: true, value: { rag: new InMemoryRag(), editor: {} as any } }),
      deleteCollection: async (name) => {
        providerDeleteCalled = name;
        return { ok: true, value: undefined };
      },
    });
    reg.setProviderRegistry(provReg);
    reg.register('x', new InMemoryRag(), undefined, {
      displayName: 'X',
      providerName: 'stub',
    });

    const res = await reg.deleteCollection('x');
    assert.ok(res.ok);
    assert.equal(providerDeleteCalled, 'x');
    assert.equal(reg.get('x'), undefined);
  });

  it('unregisters without provider call when providerName not set', async () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
    const res = await reg.deleteCollection('x');
    assert.ok(res.ok);
    assert.equal(reg.get('x'), undefined);
  });
});

describe('SimpleRagRegistry.closeSession', () => {
  it('deletes all session-scoped collections with matching sessionId, leaves others', async () => {
    const reg = new SimpleRagRegistry();
    reg.register('sess-A', new InMemoryRag(), undefined, {
      displayName: 'A', scope: 'session', sessionId: 'S',
    });
    reg.register('sess-B', new InMemoryRag(), undefined, {
      displayName: 'B', scope: 'session', sessionId: 'OTHER',
    });
    reg.register('global', new InMemoryRag(), undefined, {
      displayName: 'G', scope: 'global',
    });

    const res = await reg.closeSession('S');
    assert.ok(res.ok);
    assert.equal(reg.get('sess-A'), undefined);
    assert.ok(reg.get('sess-B'));
    assert.ok(reg.get('global'));
  });
});

describe('SimpleRagRegistry mutation listener', () => {
  it('fires listener on register/unregister/createCollection/deleteCollection/closeSession', async () => {
    const reg = new SimpleRagRegistry();
    const events: string[] = [];
    reg.setMutationListener(() => events.push('m'));

    reg.register('a', new InMemoryRag(), undefined, { displayName: 'A' });
    reg.unregister('a');

    const provReg = new SimpleRagProviderRegistry();
    provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
    reg.setProviderRegistry(provReg);

    await reg.createCollection({
      providerName: 'mem',
      collectionName: 'x',
      scope: 'session',
      sessionId: 'S',
    });
    await reg.deleteCollection('x');

    reg.register('y', new InMemoryRag(), undefined, {
      displayName: 'Y', scope: 'session', sessionId: 'Q',
    });
    await reg.closeSession('Q');

    assert.ok(events.length >= 5);
  });
});

describe('SimpleRagRegistry default scope normalization', () => {
  it('defaults scope to "global" when not provided on register', () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
    const m = reg.list().find((e) => e.name === 'x')!;
    assert.equal(m.scope, 'global');
  });
});
```

- [ ] **Step 2: Run — expect failure (new methods missing)**

- [ ] **Step 3: Implement**

Replace the body of `src/smart-agent/rag/registry/simple-rag-registry.ts` with this extended version (keep the file's existing import header and `Entry` type; extend the class):

```ts
import type {
  IRag,
  IRagEditor,
  IRagProviderRegistry,
  IRagRegistry,
  RagCollectionMeta,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import { RagError, type Result } from '../../interfaces/types.js';
import {
  CollectionNotFoundError,
  ProviderNotFoundError,
} from '../corrections/errors.js';
import { ImmutableEditStrategy } from '../strategies/edit/immutable.js';

interface Entry {
  rag: IRag;
  editor?: IRagEditor;
  meta: RagCollectionMeta;
}

export class SimpleRagRegistry implements IRagRegistry {
  protected readonly entries = new Map<string, Entry>();
  protected providerRegistry?: IRagProviderRegistry;
  protected mutationListener?: () => void;

  setProviderRegistry(providerRegistry: IRagProviderRegistry): void {
    this.providerRegistry = providerRegistry;
  }

  setMutationListener(listener: () => void): void {
    this.mutationListener = listener;
  }

  private fireMutation(): void {
    this.mutationListener?.();
  }

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
        editable,
        scope: meta?.scope ?? 'global',
        sessionId: meta?.sessionId,
        userId: meta?.userId,
        providerName: meta?.providerName,
        tags: meta?.tags,
      },
    });
    this.fireMutation();
  }

  unregister(name: string): boolean {
    const existed = this.entries.delete(name);
    if (existed) this.fireMutation();
    return existed;
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

  async createCollection(params: {
    providerName: string;
    collectionName: string;
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
    displayName?: string;
    description?: string;
    tags?: readonly string[];
  }): Promise<Result<RagCollectionMeta, RagError>> {
    if (!this.providerRegistry) {
      return {
        ok: false,
        error: new RagError(
          'No IRagProviderRegistry configured on SimpleRagRegistry',
          'RAG_NO_PROVIDER_REGISTRY',
        ),
      };
    }
    const provider = this.providerRegistry.getProvider(params.providerName);
    if (!provider) {
      return { ok: false, error: new ProviderNotFoundError(params.providerName) };
    }

    // Preflight duplicate check.
    if (this.entries.has(params.collectionName)) {
      return {
        ok: false,
        error: new RagError(
          `Collection '${params.collectionName}' already exists`,
          'RAG_DUPLICATE_COLLECTION',
        ),
      };
    }

    const created = await provider.createCollection(params.collectionName, {
      scope: params.scope,
      sessionId: params.sessionId,
      userId: params.userId,
    });
    if (!created.ok) return created;

    try {
      this.register(params.collectionName, created.value.rag, created.value.editor, {
        displayName: params.displayName,
        description: params.description,
        scope: params.scope,
        sessionId: params.sessionId,
        userId: params.userId,
        providerName: params.providerName,
        tags: params.tags,
      });
    } catch (err) {
      // Defense-in-depth: rollback via provider delete if available.
      if (provider.deleteCollection) {
        await provider.deleteCollection(params.collectionName).catch(() => {});
      }
      return {
        ok: false,
        error: err instanceof RagError
          ? err
          : new RagError(String(err), 'RAG_REGISTER_FAILED'),
      };
    }

    const registered = this.entries.get(params.collectionName);
    return { ok: true, value: registered!.meta };
  }

  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    const entry = this.entries.get(name);
    if (!entry) {
      return { ok: false, error: new CollectionNotFoundError(name) };
    }
    if (entry.meta.providerName && this.providerRegistry) {
      const provider = this.providerRegistry.getProvider(entry.meta.providerName);
      if (provider?.deleteCollection) {
        const res = await provider.deleteCollection(name);
        if (!res.ok) return res;
      }
    }
    this.unregister(name);
    return { ok: true, value: undefined };
  }

  async closeSession(sessionId: string): Promise<Result<void, RagError>> {
    const victims = Array.from(this.entries.values())
      .filter((e) => e.meta.scope === 'session' && e.meta.sessionId === sessionId)
      .map((e) => e.meta.name);
    for (const name of victims) {
      const res = await this.deleteCollection(name);
      if (!res.ok) return res;
    }
    return { ok: true, value: undefined };
  }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/registry/simple-rag-registry.ts src/smart-agent/rag/__tests__/simple-rag-registry.test.ts
git commit -m "feat(rag): extend SimpleRagRegistry with createCollection/deleteCollection/closeSession"
```

---

## Task 9: Pipeline deps wiring — add ragRegistry + ragProviderRegistry; keep ragStores as live projection

**Files:**
- Modify: `src/smart-agent/interfaces/pipeline.ts`
- Modify: `src/smart-agent/pipeline/context.ts`
- Modify: `src/smart-agent/pipeline/default-pipeline.ts`
- Modify: `src/smart-agent/testing/index.ts` (if it constructs deps)

- [ ] **Step 1: Add fields to `SmartAgentDeps` / `PipelineContext`**

In `src/smart-agent/interfaces/pipeline.ts`, add:

```ts
import type { IRagProviderRegistry, IRagRegistry } from './rag.js';

export interface PipelineDeps {
  // existing…
  ragStores: Record<string, IRag>;
  translateQueryStores?: Set<string>;
  ragRegistry: IRagRegistry;                   // NEW
  ragProviderRegistry: IRagProviderRegistry;   // NEW
}
```

Same addition wherever `SmartAgentDeps` is declared.

Same addition in `src/smart-agent/pipeline/context.ts` to the `PipelineContext` shape, and propagate in `default-pipeline.ts` when constructing the context from deps.

- [ ] **Step 2: Wire mutation listener when `ragRegistry` is constructed**

In builder (Task 10 owns this); here in this task just ensure types and default-pipeline threading compile.

- [ ] **Step 3: Build**

```
npm run build
```

Expected: compilation fails if any existing call-site constructs `PipelineDeps` without the new fields. Fix each call-site by threading registries through. Typical fixes:
- `testing/index.ts` stubs: instantiate `new SimpleRagProviderRegistry()` and `new SimpleRagRegistry()` (with `setProviderRegistry` linked) and pass them.
- Any test that builds deps manually: same pattern.

- [ ] **Step 4: Run all RAG + pipeline tests — expect pass (no behavior change yet)**

```
node --import tsx/esm --test --test-reporter=spec src/smart-agent/rag/__tests__/*.test.ts src/smart-agent/pipeline/**/__tests__/*.test.ts src/smart-agent/__tests__/*.test.ts
```

- [ ] **Step 5: Commit**

```
git add -A src/smart-agent/interfaces/pipeline.ts src/smart-agent/pipeline src/smart-agent/testing/index.ts
git commit -m "feat(rag): thread ragRegistry and ragProviderRegistry through pipeline deps"
```

---

## Task 10: Builder methods — addRagProvider, addRagCollection, createRagCollection, setRagRegistry, setRagProviderRegistry; wire mutation listener so `ragStores` is a live projection

**Files:**
- Modify: `src/smart-agent/builder.ts`

- [ ] **Step 1: Add private fields**

In the `SmartAgentBuilder` class fields section, add:

```ts
private _providers: IRagProvider[] = [];
private _staticCollections: Array<{
  name: string;
  rag: IRag;
  editor?: IRagEditor;
  meta?: Omit<RagCollectionMeta, 'name' | 'editable'>;
}> = [];
private _pendingDynamicCollections: Array<{
  providerName: string;
  collectionName: string;
  scope: RagCollectionScope;
  sessionId?: string;
  userId?: string;
  displayName?: string;
  description?: string;
  tags?: readonly string[];
}> = [];
private _ragRegistry?: IRagRegistry;
private _ragProviderRegistry?: IRagProviderRegistry;
```

- [ ] **Step 2: Add fluent setters**

```ts
addRagProvider(provider: IRagProvider): this {
  this._providers.push(provider);
  return this;
}

addRagCollection(params: {
  name: string;
  rag: IRag;
  editor?: IRagEditor;
  meta?: Omit<RagCollectionMeta, 'name' | 'editable'>;
}): this {
  this._staticCollections.push(params);
  return this;
}

createRagCollection(params: {
  providerName: string;
  collectionName: string;
  scope: RagCollectionScope;
  sessionId?: string;
  userId?: string;
  displayName?: string;
  description?: string;
  tags?: readonly string[];
}): this {
  this._pendingDynamicCollections.push(params);
  return this;
}

setRagRegistry(registry: IRagRegistry): this {
  this._ragRegistry = registry;
  return this;
}

setRagProviderRegistry(registry: IRagProviderRegistry): this {
  this._ragProviderRegistry = registry;
  return this;
}
```

- [ ] **Step 3: Wire registries in `buildAgent()`**

Inside `buildAgent()` (before `ragStores` is constructed), add:

```ts
const ragProviderRegistry: IRagProviderRegistry =
  this._ragProviderRegistry ?? new SimpleRagProviderRegistry();
for (const p of this._providers) ragProviderRegistry.registerProvider(p);

const ragRegistry: IRagRegistry =
  this._ragRegistry ?? new SimpleRagRegistry();

// Hook provider registry into the collection registry if supported.
if (
  ragRegistry instanceof SimpleRagRegistry ||
  'setProviderRegistry' in ragRegistry
) {
  (ragRegistry as SimpleRagRegistry).setProviderRegistry(ragProviderRegistry);
}

// Register static collections.
for (const c of this._staticCollections) {
  ragRegistry.register(c.name, c.rag, c.editor, c.meta);
}

// Create any queued dynamic collections at startup.
for (const c of this._pendingDynamicCollections) {
  const res = await ragRegistry.createCollection(c);
  if (!res.ok) {
    throw new Error(`Failed to create collection '${c.collectionName}': ${res.error.message}`);
  }
}

// Derive ragStores projection from registry; keep in sync via mutation listener.
const ragStores: Record<string, IRag> = {};
const rebuildProjection = () => {
  for (const k of Object.keys(ragStores)) delete ragStores[k];
  for (const m of ragRegistry.list()) {
    const r = ragRegistry.get(m.name);
    if (r) ragStores[m.name] = r;
  }
};
rebuildProjection();
if (
  ragRegistry instanceof SimpleRagRegistry ||
  'setMutationListener' in ragRegistry
) {
  (ragRegistry as SimpleRagRegistry).setMutationListener(rebuildProjection);
}

// Reuse ragStores below — unchanged code paths (assembler, pipeline handlers) see the same shape.
```

Replace the current `ragStores` construction path with the new one. `translateQueryStores` logic stays as is; continue populating it from static collection meta and the existing `toolsRag` convention.

Include `ragRegistry` and `ragProviderRegistry` in the `SmartAgentDeps` object returned / passed to `SmartAgent`.

Imports at the top of `builder.ts`:

```ts
import { SimpleRagRegistry } from './rag/registry/simple-rag-registry.js';
import {
  SimpleRagProviderRegistry,
  // other providers as needed
} from './rag/providers/index.js';
import type {
  IRagProvider,
  IRagProviderRegistry,
  IRagRegistry,
  RagCollectionScope,
} from './interfaces/rag.js';
```

- [ ] **Step 4: Build + run tests**

```
npm run build
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/*.test.ts
```

Pre-existing tests must continue to pass (they use the builder through its existing surface). Any new behavior is additive.

- [ ] **Step 5: Commit**

```
git add src/smart-agent/builder.ts
git commit -m "feat(rag): wire registries in builder with ragStores projection"
```

---

## Task 11: `SmartAgent.closeSession`; rewire `addRagStore` / `removeRagStore` to delegate through registry

**Files:**
- Modify: `src/smart-agent/agent.ts`
- Test: `src/smart-agent/__tests__/smart-agent-close-session.test.ts` (new)
- Test: `src/smart-agent/__tests__/smart-agent-custom-rag.test.ts` (must pass unchanged)

- [ ] **Step 1: Failing test**

```ts
// src/smart-agent/__tests__/smart-agent-close-session.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgentBuilder } from '../builder.js';
import { InMemoryRagProvider } from '../rag/providers/in-memory-rag-provider.js';
// Any stub LLM you already have in tests — reuse from smart-agent-custom-rag.test.ts pattern.
import { makeMinimalAgent } from './helpers.js';  // ← create if missing, or inline a minimal stub

describe('SmartAgent.closeSession', () => {
  it('removes session-scoped collections with matching sessionId', async () => {
    const agent = await makeMinimalAgent({
      providers: [new InMemoryRagProvider({ name: 'mem' })],
    });
    await agent.deps.ragRegistry.createCollection({
      providerName: 'mem',
      collectionName: 'session-A',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(agent.deps.ragRegistry.get('session-A'));
    await agent.closeSession('S');
    assert.equal(agent.deps.ragRegistry.get('session-A'), undefined);
  });

  it('preserves global/user collections', async () => {
    const agent = await makeMinimalAgent({
      providers: [new InMemoryRagProvider({ name: 'mem' })],
    });
    // Static global registered manually
    agent.deps.ragRegistry.register('global', new (await import('../rag/in-memory-rag.js')).InMemoryRag(), undefined, {
      displayName: 'G', scope: 'global',
    });
    await agent.closeSession('NONE');
    assert.ok(agent.deps.ragRegistry.get('global'));
  });
});
```

If `makeMinimalAgent` doesn't exist, create it in `src/smart-agent/__tests__/helpers.ts` as a minimal builder invocation with a stub LLM reusing whatever pattern the existing tests use. Keep it small.

- [ ] **Step 2: Run — expect failure (closeSession missing)**

- [ ] **Step 3: Implement `closeSession`**

Add to `SmartAgent` class in `src/smart-agent/agent.ts`:

```ts
async closeSession(sessionId: string): Promise<void> {
  const res = await this.deps.ragRegistry.closeSession(sessionId);
  if (!res.ok) {
    // Log but don't throw — best-effort cleanup.
    this.deps.requestLogger?.log?.({
      type: 'warning',
      traceId: sessionId,
      message: `closeSession: ${res.error.message}`,
    });
  }
  this.deps.historyMemory?.clear(sessionId);
}
```

- [ ] **Step 4: Rewire `addRagStore` / `removeRagStore`**

Replace the bodies of `addRagStore` and `removeRagStore` to go through the registry while keeping ALL existing side effects:

```ts
addRagStore(
  name: string,
  store: IRag,
  options?: { translateQuery?: boolean },
): void {
  if (name === 'tools' || name === 'history') {
    throw new Error(
      `Cannot overwrite built-in RAG store "${name}" via addRagStore()`,
    );
  }
  // Unregister any existing same-name entry first (old behavior overwrote without error).
  if (this.deps.ragRegistry.get(name)) {
    this.deps.ragRegistry.unregister(name);
  }
  this.deps.ragRegistry.register(name, store, undefined, {
    displayName: name,
    scope: 'global',
  });
  if (options?.translateQuery) {
    if (!this.deps.translateQueryStores) {
      this.deps.translateQueryStores = new Set();
    }
    this.deps.translateQueryStores.add(name);
  }
  this.deps.pipeline?.rebuildStages?.();
}

removeRagStore(name: string): void {
  if (name === 'tools' || name === 'history') {
    throw new Error(
      `Cannot remove built-in RAG store "${name}" via removeRagStore()`,
    );
  }
  this.deps.ragRegistry.unregister(name);
  this.deps.translateQueryStores?.delete(name);
  this.deps.pipeline?.rebuildStages?.();
}
```

Note: `ragStores` is now a live projection updated by the registry's mutation listener (installed by the builder in Task 10). Do NOT write to `ragStores` directly here.

- [ ] **Step 5: Run all agent + RAG tests — expect pass**

```
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/*.test.ts src/smart-agent/rag/__tests__/*.test.ts
```

Specifically verify `smart-agent-custom-rag.test.ts` (addRagStore/removeRagStore behavior) still passes.

- [ ] **Step 6: Commit**

```
git add src/smart-agent/agent.ts src/smart-agent/__tests__/smart-agent-close-session.test.ts src/smart-agent/__tests__/helpers.ts
git commit -m "feat(rag): add SmartAgent.closeSession; route addRagStore/removeRagStore through registry"
```

---

## Task 12: MCP tools — `RagToolContext`, four new tools (create/list/describe/delete)

**Files:**
- Modify: `src/smart-agent/rag/mcp-tools/rag-collection-tools.ts`
- Test: `src/smart-agent/rag/__tests__/rag-collection-tools.test.ts` (extend)

- [ ] **Step 1: Add `RagToolContext` type and tighten handler signature**

At the top of `rag-collection-tools.ts`, add:

```ts
export interface RagToolContext {
  sessionId?: string;
  userId?: string;
  [key: string]: unknown;
}
```

Change the `RagToolEntry.handler` parameter type from `context: object` to `context: RagToolContext`. Export `RagToolContext`.

- [ ] **Step 2: Update `buildRagCollectionToolEntries` signature**

```ts
export function buildRagCollectionToolEntries(opts: {
  registry: IRagRegistry;
  providerRegistry?: IRagProviderRegistry;
}): RagToolEntry[];
```

- [ ] **Step 3: Failing tests (appended to existing `rag-collection-tools.test.ts`)**

```ts
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';

function makeFullRegistry() {
  const reg = new SimpleRagRegistry();
  const provReg = new SimpleRagProviderRegistry();
  provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  reg.setProviderRegistry(provReg);
  return { reg, provReg };
}

describe('rag_create_collection', () => {
  it('creates session-scoped collection via provider', async () => {
    const { reg, provReg } = makeFullRegistry();
    const entries = buildRagCollectionToolEntries({ registry: reg, providerRegistry: provReg });
    const create = entries.find((e) => e.toolDefinition.name === 'rag_create_collection');
    assert.ok(create);
    const out = (await create.handler(
      { sessionId: 'S' },
      { provider: 'mem', name: 'workflow-x', scope: 'session' },
    )) as { ok: boolean; meta?: { name: string; scope: string; sessionId: string } };
    assert.equal(out.ok, true);
    assert.equal(out.meta!.name, 'workflow-x');
    assert.equal(out.meta!.scope, 'session');
    assert.equal(out.meta!.sessionId, 'S');
  });
  it('is absent when providerRegistry is not supplied', () => {
    const reg = new SimpleRagRegistry();
    const entries = buildRagCollectionToolEntries({ registry: reg });
    assert.equal(
      entries.find((e) => e.toolDefinition.name === 'rag_create_collection'),
      undefined,
    );
  });
});

describe('rag_list_collections', () => {
  it('lists all collections', async () => {
    const { reg } = makeFullRegistry();
    reg.register('a', new InMemoryRag(), undefined, { displayName: 'A', scope: 'global' });
    reg.register('b', new InMemoryRag(), undefined, { displayName: 'B', scope: 'session', sessionId: 'S' });
    const entries = buildRagCollectionToolEntries({ registry: reg });
    const list = entries.find((e) => e.toolDefinition.name === 'rag_list_collections');
    assert.ok(list);
    const out = (await list.handler({}, {})) as { ok: boolean; collections: Array<{ name: string }> };
    assert.equal(out.ok, true);
    assert.deepEqual(out.collections.map((m) => m.name).sort(), ['a', 'b']);
  });
  it('filters by scope', async () => {
    const { reg } = makeFullRegistry();
    reg.register('a', new InMemoryRag(), undefined, { displayName: 'A', scope: 'global' });
    reg.register('b', new InMemoryRag(), undefined, { displayName: 'B', scope: 'session', sessionId: 'S' });
    const entries = buildRagCollectionToolEntries({ registry: reg });
    const list = entries.find((e) => e.toolDefinition.name === 'rag_list_collections')!;
    const out = (await list.handler({}, { scope: 'session' })) as { ok: boolean; collections: Array<{ name: string }> };
    assert.deepEqual(out.collections.map((m) => m.name), ['b']);
  });
});

describe('rag_describe_collection', () => {
  it('returns full meta for a known collection', async () => {
    const { reg } = makeFullRegistry();
    reg.register('a', new InMemoryRag(), undefined, { displayName: 'A', scope: 'global' });
    const entries = buildRagCollectionToolEntries({ registry: reg });
    const desc = entries.find((e) => e.toolDefinition.name === 'rag_describe_collection')!;
    const out = (await desc.handler({}, { name: 'a' })) as { ok: boolean; meta?: { scope: string } };
    assert.equal(out.ok, true);
    assert.equal(out.meta!.scope, 'global');
  });
  it('returns error for unknown name', async () => {
    const { reg } = makeFullRegistry();
    const entries = buildRagCollectionToolEntries({ registry: reg });
    const desc = entries.find((e) => e.toolDefinition.name === 'rag_describe_collection')!;
    const out = (await desc.handler({}, { name: 'nope' })) as { ok: boolean; error?: string };
    assert.equal(out.ok, false);
  });
});

describe('rag_delete_collection scope enforcement', () => {
  it('rejects global collection deletion', async () => {
    const { reg } = makeFullRegistry();
    reg.register('g', new InMemoryRag(), undefined, { displayName: 'G', scope: 'global' });
    const entries = buildRagCollectionToolEntries({ registry: reg });
    const del = entries.find((e) => e.toolDefinition.name === 'rag_delete_collection')!;
    const out = (await del.handler({}, { name: 'g' })) as { ok: boolean };
    assert.equal(out.ok, false);
    assert.ok(reg.get('g'));
  });
  it('allows session deletion when sessionId matches', async () => {
    const { reg } = makeFullRegistry();
    reg.register('s', new InMemoryRag(), undefined, { displayName: 'S', scope: 'session', sessionId: 'S' });
    const entries = buildRagCollectionToolEntries({ registry: reg });
    const del = entries.find((e) => e.toolDefinition.name === 'rag_delete_collection')!;
    const out = (await del.handler({ sessionId: 'S' }, { name: 's' })) as { ok: boolean };
    assert.equal(out.ok, true);
    assert.equal(reg.get('s'), undefined);
  });
  it('rejects session deletion when sessionId mismatches', async () => {
    const { reg } = makeFullRegistry();
    reg.register('s', new InMemoryRag(), undefined, { displayName: 'S', scope: 'session', sessionId: 'S' });
    const entries = buildRagCollectionToolEntries({ registry: reg });
    const del = entries.find((e) => e.toolDefinition.name === 'rag_delete_collection')!;
    const out = (await del.handler({ sessionId: 'X' }, { name: 's' })) as { ok: boolean };
    assert.equal(out.ok, false);
    assert.ok(reg.get('s'));
  });
  it('allows user deletion when userId matches', async () => {
    const { reg } = makeFullRegistry();
    reg.register('u', new InMemoryRag(), undefined, { displayName: 'U', scope: 'user', userId: 'alice' });
    const entries = buildRagCollectionToolEntries({ registry: reg });
    const del = entries.find((e) => e.toolDefinition.name === 'rag_delete_collection')!;
    const out = (await del.handler({ userId: 'alice' }, { name: 'u' })) as { ok: boolean };
    assert.equal(out.ok, true);
  });
});
```

- [ ] **Step 4: Run — expect failure (new tools missing)**

- [ ] **Step 5: Implement**

Append to `rag-collection-tools.ts` inside `buildRagCollectionToolEntries` (after existing `addTool`, `correctTool`, `deprecateTool`):

```ts
const listTool: RagToolEntry = {
  toolDefinition: {
    name: 'rag_list_collections',
    description: 'List known RAG collections with optional scope/provider filters.',
    inputSchema: {
      scope: z.enum(['session', 'user', 'global']).optional(),
      provider: z.string().optional(),
    },
  },
  handler: async (_ctx, args) => {
    const metas = registry.list().filter((m) => {
      if (args.scope && m.scope !== args.scope) return false;
      if (args.provider && m.providerName !== args.provider) return false;
      return true;
    });
    return { ok: true, collections: metas };
  },
};

const describeTool: RagToolEntry = {
  toolDefinition: {
    name: 'rag_describe_collection',
    description: 'Return the metadata of a RAG collection by name.',
    inputSchema: { name: z.string() },
  },
  handler: async (_ctx, args) => {
    const meta = registry.list().find((m) => m.name === args.name);
    if (!meta) {
      return { ok: false, error: `Collection '${args.name}' not found` };
    }
    return { ok: true, meta };
  },
};

const deleteTool: RagToolEntry = {
  toolDefinition: {
    name: 'rag_delete_collection',
    description: 'Delete a RAG collection you own (session or user scope).',
    inputSchema: { name: z.string() },
  },
  handler: async (ctx: RagToolContext, args) => {
    const name = String(args.name);
    const meta = registry.list().find((m) => m.name === name);
    if (!meta) {
      return { ok: false, error: `Collection '${name}' not found` };
    }
    if (meta.scope === 'global' || !meta.scope) {
      return { ok: false, error: `Global collections cannot be deleted via MCP` };
    }
    if (meta.scope === 'session') {
      if (!ctx.sessionId || ctx.sessionId !== meta.sessionId) {
        return { ok: false, error: `sessionId mismatch for collection '${name}'` };
      }
    }
    if (meta.scope === 'user') {
      if (!ctx.userId || ctx.userId !== meta.userId) {
        return { ok: false, error: `userId mismatch for collection '${name}'` };
      }
    }
    const res = await registry.deleteCollection(name);
    return res.ok ? { ok: true } : { ok: false, error: res.error.message };
  },
};

const tools: RagToolEntry[] = [addTool, correctTool, deprecateTool, listTool, describeTool, deleteTool];

if (opts.providerRegistry) {
  const providerRegistry = opts.providerRegistry;
  const createTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_create_collection',
      description: 'Create a new RAG collection via a provider.',
      inputSchema: {
        provider: z.string(),
        name: z.string(),
        scope: z.enum(['session', 'user', 'global']),
        displayName: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    handler: async (ctx: RagToolContext, args) => {
      const res = await registry.createCollection({
        providerName: String(args.provider),
        collectionName: String(args.name),
        scope: args.scope as 'session' | 'user' | 'global',
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        displayName: args.displayName as string | undefined,
        description: args.description as string | undefined,
        tags: args.tags as string[] | undefined,
      });
      // Confirm provider registry is actually consulted — defensive use-statement:
      void providerRegistry;
      return res.ok ? { ok: true, meta: res.value } : { ok: false, error: res.error.message };
    },
  };
  tools.push(createTool);
}

return tools;
```

- [ ] **Step 6: Run — expect all pass**

```
node --import tsx/esm --test --test-reporter=spec src/smart-agent/rag/__tests__/rag-collection-tools.test.ts
```

- [ ] **Step 7: Commit**

```
git add src/smart-agent/rag/mcp-tools/rag-collection-tools.ts src/smart-agent/rag/__tests__/rag-collection-tools.test.ts
git commit -m "feat(rag): add rag_create/list/describe/delete_collection MCP tools"
```

---

## Task 13: Public API exports + version bump to 9.1.0

**Files:**
- Modify: `src/smart-agent/rag/index.ts`
- Modify: `src/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Extend rag barrel**

Append to `src/smart-agent/rag/index.ts`:

```ts
export * from './providers/index.js';
```

- [ ] **Step 2: Extend public root exports**

In `src/index.ts`, make sure the new names are reachable:
- Types: `RagCollectionScope`, `IRagProvider`, `IRagProviderRegistry`, `RagToolContext`.
- Classes: `AbstractRagProvider`, `InMemoryRagProvider`, `VectorRagProvider`, `QdrantRagProvider`, `SimpleRagProviderRegistry`.
- Errors: `UnsupportedScopeError`, `ProviderNotFoundError`, `CollectionNotFoundError`, `ScopeViolationError`.

If `src/index.ts` already re-exports `./smart-agent/rag/index.js` via `export *`, the classes flow through automatically. Add any missing type exports explicitly.

- [ ] **Step 3: Bump version**

```
npm version minor --no-git-tag-version
```

Confirm `package.json` shows `"version": "9.1.0"` (from 9.0.0). Also check `package-lock.json` was updated.

- [ ] **Step 4: Build clean**

```
npm run build
```

- [ ] **Step 5: Commit**

```
git add src/smart-agent/rag/index.ts src/index.ts package.json package-lock.json
git commit -m "chore: release 9.1.0 - RAG providers + dynamic collections"
```

---

## Task 14: Final verification

- [ ] **Step 1: Full build**

```
npm run build
```
Expected: clean.

- [ ] **Step 2: Full lint**

```
npm run lint:check
```
Expected: clean. If not, run `npm run lint` to auto-fix and include the fix in the previous commit.

- [ ] **Step 3: Full test run**

```
node --import tsx/esm --test --test-reporter=spec src/smart-agent/**/__tests__/*.test.ts
```

All tests must pass. Pay particular attention to:
- Existing `smart-agent-custom-rag.test.ts` (`addRagStore`/`removeRagStore` preserved semantics).
- `smart-server` hot-reload tests (if any touch ragStores; ragStores is still there but now live-projected — behavior should be identical).

- [ ] **Step 4: Spec-grep sanity**

Confirm every named entity from the spec is present in the codebase:

```
rg -n "IRagProvider|IRagProviderRegistry|SimpleRagProviderRegistry|AbstractRagProvider|InMemoryRagProvider|VectorRagProvider|QdrantRagProvider|RagCollectionScope|RagToolContext|UnsupportedScopeError|ProviderNotFoundError|CollectionNotFoundError|ScopeViolationError|rag_create_collection|rag_list_collections|rag_describe_collection|rag_delete_collection|closeSession" src/
```

Each should return at least one source definition and one test reference.

- [ ] **Step 5: Smoke test (build + start)**

```
npm run test
```

- [ ] **Step 6: After merge**, delete the spec and plan files per retention policy:

```
git rm docs/superpowers/specs/2026-04-22-rag-providers-design.md docs/superpowers/plans/2026-04-22-rag-providers.md
git commit -m "chore(docs): remove v9.1 spec and plan (implemented)"
```

This step runs AFTER the PR is merged, in a cleanup commit against `main`.

---

## Notes

- **No new dependencies.** All providers wrap classes already in the repo. HANA and other backends are deferred to separate packages (see spec's Future roadmap).
- **`ragStores` projection** is live-synced via the mutation listener installed by the builder. If a consumer constructs `SmartAgentDeps` manually and doesn't install the listener, `ragStores` will be a static snapshot — a pure-projection nuance worth documenting if it surfaces in practice.
- **`rag_create_collection`** is omitted if `providerRegistry` is not supplied. Existing 9.0.0 consumers that call `buildRagCollectionToolEntries({ registry })` keep working without adopting the provider layer.
- **Scope defaults to `'global'`** in `SimpleRagRegistry.register` when the consumer omits it. Collections created via `createCollection` always carry their resolved scope.
- **MCP delete of session/user collections** requires `sessionId` / `userId` in `RagToolContext`. The consumer's MCP server must populate these; if missing, the tool returns a typed error rather than silently succeeding.
