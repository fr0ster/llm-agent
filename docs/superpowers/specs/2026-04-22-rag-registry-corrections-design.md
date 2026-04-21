# RAG Registry and Corrections Layer — Design Spec

**Date:** 2026-04-22
**Status:** Draft → In Review
**Related:** [issue #103](https://github.com/fr0ster/llm-agent/issues/103)

## Motivation

Downstream consumers of `llm-agent` (e.g. `cloud-llm-hub`) currently re-implement four concerns that naturally belong upstream:

1. A collection **registry** mapping names to heterogeneous `IRag` instances (in-memory, Qdrant, remote vector server, MCP tool catalog) under one API.
2. A **corrections metadata convention** (`canonicalKey`, `tags`, `supersededBy`, `deprecatedAt`, `deprecatedReason`) with pure-logic helpers.
3. A **retrieval wrapper** that hides `deprecated` / `superseded` from default retrieval with opt-in `includeInactive`.
4. **MCP tools** (`rag_create_collection`, `rag_add`, `rag_correct`, `rag_deprecate`) that let agents self-manage the correction layer.

Upstreaming with an explicit interface split also unlocks heterogeneous collection sets per registry, first-class immutability, and pluggable edit/id strategies.

## Scope

- Split `IRag` (read) from `IRagEditor` (write); introduce `IRagRegistry`.
- Ship four edit strategies and four id strategies as first-class, composable classes.
- Ship a pure-logic corrections module and `ActiveFilteringRag` wrapper.
- Ship one MCP tool factory that produces `rag_*` entries bound to the registry.
- Migrate existing backends (`VectorRag`, `QdrantRag`, `InMemoryRag`) to the new split. Convenience subclasses like `OllamaRag` (which just wires `OllamaEmbedder` into `VectorRag`) inherit the migration automatically.
- **Breaking:** drop `IRag.upsert`; `getById` becomes required. Major version bump.

Out of scope: persistence of registry state, XSUAA/auth scoping (consumers subclass `SimpleRagRegistry`), endpoint/completions fallback (#100), prompt-injected tools (#102).

## Decisions (resolved questions)

| # | Question | Decision |
|---|---|---|
| 1 | `getById` on `IRag` | **Required** immediately. Major version bump. |
| 2 | id shape in `IRagEditor.upsert` | id is **always** resolved; determined by pluggable `IIdStrategy`. `upsert` returns `{ id: string }`. No anonymous records. |
| 3 | File layout for strategies | **Grouped subfolders:** `rag/strategies/edit/`, `rag/strategies/id/`, `rag/registry/`, `rag/corrections/`, `rag/mcp-tools/`. |
| 4 | Overlay collision on `canonicalKey` | **Overlay always wins.** Base record is dropped even with higher similarity. Tag filtering is handled separately by `ActiveFilteringRag`. |

## Interfaces

All interfaces live in `src/smart-agent/interfaces/rag.ts`. Prefix `I` per project convention.

```ts
export interface IRag {
  query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions & { ragFilter?: RagFilter },
  ): Promise<Result<RagResult[], RagError>>;

  /** Fetch a single document by its metadata id. Returns null if not found. */
  getById(id: string, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;

  healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
}

export interface IRagEditor {
  /**
   * Insert or overwrite a document. The final id is resolved by the editor's
   * IIdStrategy and always returned.
   */
  upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<{ id: string }, RagError>>;

  /** Delete by id. Returns true if deleted, false if absent. */
  deleteById(id: string, options?: CallOptions): Promise<Result<boolean, RagError>>;

  clear?(): Promise<Result<void, RagError>>;
}

export interface IIdStrategy {
  /** Always returns a valid id; throws a typed error when required input is missing. */
  resolve(metadata: RagMetadata, text: string): string;
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

## File layout

```
src/smart-agent/rag/
  overlays/
    overlay-rag.ts               OverlayRag (implements IRag)
    session-scoped-rag.ts        SessionScopedRag (implements IRag)
    index.ts
  strategies/
    edit/
      direct.ts                  DirectEditStrategy
      immutable.ts               ImmutableEditStrategy
      overlay.ts                 OverlayEditStrategy (write-only)
      session-scoped.ts          SessionScopedEditStrategy (write-only)
      index.ts
    id/
      caller-provided.ts         CallerProvidedIdStrategy
      session-scoped.ts          SessionScopedIdStrategy
      global-unique.ts           GlobalUniqueIdStrategy
      canonical-key.ts           CanonicalKeyIdStrategy
      index.ts
  registry/
    simple-rag-registry.ts       SimpleRagRegistry
    index.ts
  corrections/
    metadata.ts                  validate / deprecate / buildCorrection / filterActive
    active-filtering-rag.ts      ActiveFilteringRag
    errors.ts                    ReadOnlyError, MissingIdError, CanonicalKeyCollisionError
    index.ts
  mcp-tools/
    rag-collection-tools.ts      buildRagCollectionToolEntries
    index.ts
  __tests__/
    (existing + one test file per new module)
```

## Read-side: overlay RAGs

Read behavior of layered collections lives in `IRag` implementations, not in edit strategies. Registered as the `rag` argument to `registry.register(...)`, paired with a matching write-only edit strategy.

| Class | Semantics |
|---|---|
| `OverlayRag(base, overlay)` | Implements `IRag`. `query` calls both and merges with **overlay wins** on matching `canonicalKey` (base hit dropped regardless of score). `getById` tries `overlay` first, then `base`. `healthCheck` requires both healthy. |
| `SessionScopedRag(base, overlay, sessionId, ttlMs?)` | Extends overlay semantics with session-scoped filtering: overlay hits are included only when their `metadata.sessionId === sessionId` and (if TTL is set) within the TTL window. `clear` on the overlay-writer flushes just that session. |

## Edit strategies

All edit strategies are **write-only** — they implement `IRagEditor` and have no `query` / `getById` responsibility.

| Class | Semantics |
|---|---|
| `DirectEditStrategy(writer, idStrategy)` | Forwards `upsert`/`deleteById` to a single `IRagBackendWriter`. Used for editable stores (memory, Qdrant). |
| `ImmutableEditStrategy()` | All mutating calls return `Err(new ReadOnlyError(collectionName))`. No state. Used for managed/ops-owned KBs. |
| `OverlayEditStrategy(overlayWriter, idStrategy)` | Writes go to the overlay writer only. Does not know about the base. Intended to be paired with `OverlayRag` in the registry. |
| `SessionScopedEditStrategy(overlayWriter, sessionId, idStrategy, ttlMs?)` | Same as `OverlayEditStrategy` but stamps `metadata.sessionId` on every write and passes `sessionId` to the id strategy. Paired with `SessionScopedRag`. `clear()` removes only records matching `sessionId`. |

## Id strategies

| Class | Semantics |
|---|---|
| `CallerProvidedIdStrategy` | `metadata.id` required. Missing → throws `MissingIdError`. |
| `SessionScopedIdStrategy(sessionId)` | If `metadata.id` given → `${sessionId}:${metadata.id}`. Else if `canonicalKey` given → `${sessionId}:${canonicalKey}`. Else → `${sessionId}:${uuid()}`. |
| `GlobalUniqueIdStrategy` | Returns `metadata.id` if present; otherwise uuid v4. |
| `CanonicalKeyIdStrategy` | Requires `metadata.canonicalKey`. Returns `${canonicalKey}:v${version}` where version derives from metadata (default 1). Used by corrections chain. |

## Corrections module

Pure logic, no I/O. Lives in `rag/corrections/metadata.ts`.

```ts
export type CorrectionTag = 'verified' | 'deprecated' | 'superseded' | 'correction';

export interface CorrectionMetadata {
  canonicalKey: string;
  tags?: CorrectionTag[];
  sessionId?: string;
  supersededBy?: string;
  deprecatedAt?: number;      // unix seconds
  deprecatedReason?: string;
}

export function validateCorrectionMetadata(meta: CorrectionMetadata): void;

export function deprecateMetadata(
  current: CorrectionMetadata,
  reason: string,
  nowSeconds?: number,
): CorrectionMetadata;

export function buildCorrectionMetadata(input: {
  predecessor: CorrectionMetadata;
  predecessorId: string;
  newEntryId: string;
  reason: string;
}): { predecessor: CorrectionMetadata; next: CorrectionMetadata };

export function filterActive<T>(
  items: readonly T[],
  getMeta: (item: T) => CorrectionMetadata | undefined,
  options?: { includeInactive?: boolean },
): T[];
```

`ActiveFilteringRag` wraps any `IRag`: on `query`, applies `filterActive` unless `options.ragFilter?.includeInactive === true`. On `getById`, returns null when the item has `deprecated` / `superseded` tag unless `includeInactive` is set. Composable with existing `ExpositionFilteringRag`.

## MCP tool factory

```ts
export interface RagToolEntry {
  toolDefinition: {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
  };
  handler: (context: {}, args: Record<string, unknown>) => Promise<unknown>;
}

export function buildRagCollectionToolEntries(opts: {
  registry: IRagRegistry;
}): RagToolEntry[];
```

Tools (four entries):

- **`rag_create_collection`** — optional; requires a consumer-provided factory hook. If not supplied, tool is omitted from entries. Most deployments register collections ahead of time.
- **`rag_add`** — validates `canonicalKey`; rejects read-only collections with `ReadOnlyError`; calls `editor.upsert`.
- **`rag_correct`** — uses `buildCorrectionMetadata`; two `upsert` calls (predecessor marked superseded + new entry); returns both ids.
- **`rag_deprecate`** — uses `deprecateMetadata`; single `upsert`; idempotent.

All four check `registry.getEditor(name) !== undefined` before any mutation.

## Migration

### Existing backends

The three real backends — `VectorRag` (and any `*Embedder + VectorRag` subclass like `OllamaRag`), `QdrantRag`, `InMemoryRag` — today implement a unified `IRag` with `upsert`. After the split:

- They implement the new `IRag` (read surface + `getById`). `getById` is implemented natively (`InMemoryRag`: Map lookup; `VectorRag`: metadata index lookup; `QdrantRag`: point retrieve by id).
- Their write methods become the primitives used by `DirectEditStrategy`. `DirectEditStrategy` holds a reference to the backend's writable surface via a narrow `IRagBackendWriter` interface exported alongside each backend.
- `IPrecomputedVectorRag.upsertPrecomputed` moves to the backend-writer surface for the same reason.

### Call sites

All existing callers of `rag.upsert(...)` migrate to `editor.upsert(...)` via registry lookup. Affected: `src/smart-agent/rag/tool-indexing-strategy.ts`, `src/smart-agent/rag/preprocessor.ts`, and any builder/pipeline code that seeds RAG content.

### Public API

- **Remove:** `IRag.upsert`, `IRag.clear`.
- **Add:** `IRagEditor`, `IIdStrategy`, `IRagRegistry`, `RagCollectionMeta`, all strategies, `SimpleRagRegistry`, corrections module, `ActiveFilteringRag`, `buildRagCollectionToolEntries`, error types.
- Major version bump (9.0.0).

### Consumer (`cloud-llm-hub`) after migration

```ts
class BtpRagRegistry extends SimpleRagRegistry {
  // XSUAA role checks, CF persistence, user/global scoping.
}

const registry: IRagRegistry = getBtpRagRegistry();
registry.register('corp-facts', corpQdrant, new ImmutableEditStrategy());
registry.register('user-kb', userQdrant,
  new DirectEditStrategy(userQdrantWriter, new CallerProvidedIdStrategy()));

const sessionOverlay = new InMemoryRag();  // IRag with a companion writer
registry.register(
  'session',
  new SessionScopedRag(corpQdrant, sessionOverlay, sessionId),
  new SessionScopedEditStrategy(
    sessionOverlay.writer(),
    sessionId,
    new SessionScopedIdStrategy(sessionId),
  ),
);

const entries = [...coreEntries, ...buildRagCollectionToolEntries({ registry })];
```

## Error types

Defined in `rag/corrections/errors.ts`:

- `ReadOnlyError(collectionName)` — editor refused mutation.
- `MissingIdError(strategy)` — id strategy required id that wasn't provided.
- `CanonicalKeyCollisionError(key)` — overlay detected write colliding with base when colliding semantics are needed (reserved; currently unused due to "overlay always wins").

All extend a typed `RagError` variant compatible with the existing `Result<_, RagError>` pattern.

## Testing

Per-module unit tests in `src/smart-agent/rag/__tests__/`:

- Each edit strategy: happy path, error path, compose-with-id-strategy.
- Each id strategy: required-input behavior, formatting.
- `SimpleRagRegistry`: register/unregister, get, getEditor, list.
- `corrections/metadata.ts`: all four helpers, edge cases (missing tags, double-deprecate).
- `ActiveFilteringRag`: filters deprecated/superseded by default, surfaces them with `includeInactive`.
- `buildRagCollectionToolEntries`: each tool handler behavior, read-only rejection, `canonicalKey` validation.

Existing backend tests updated for the new read/write split.

## Open items for implementation plan

- Concrete shape of `IRagBackendWriter` per backend (may be identical or diverge).
- Whether `rag_create_collection` ships in the first version or is deferred — design allows either without breaking.
- Registry listing order (insertion vs alphabetical vs meta-tag-grouped) — defaulting to insertion order.
- Shape of the companion writer exposed by `InMemoryRag` / `QdrantRag` / `OllamaRag` (`rag.writer()` accessor vs separate writer class). Resolve in the implementation plan.
