# RAG Providers and Dynamic Collections — Design Spec

**Date:** 2026-04-22
**Target release:** v9.1.0 (minor, additive)
**Status:** Draft → In Review
**Builds on:** v9.0.0 (RAG registry + corrections layer)

## Motivation

v9.0.0 shipped `IRagRegistry` with static, startup-only collection registration. Consumers that want the LLM to create collections at runtime (for workflow scratch space, session overlays, per-task result stores) must pre-register every possible collection — which is either impossible (unknown names) or wasteful.

The provider layer splits the static part (backend configuration: Qdrant URL, credentials, embedder, editability policy) from the dynamic part (collection instances created on demand). Providers are injected at agent construction; collections are created during execution via an MCP tool the LLM can call.

Consumer flow after this release: register a few providers at startup (one per editability+backend combination), register long-lived "global" collections statically, let the LLM create session/user-scoped collections on demand through skills.

## Scope

- `IRagProvider` interface + `IRagProviderRegistry` + `SimpleRagProviderRegistry` default implementation.
- Extend `RagCollectionMeta` with `scope: 'session' | 'user' | 'global'` plus `sessionId`, `userId`, `providerName` fields.
- Extend `IRagRegistry` with `createCollection`, `deleteCollection`, `closeSession` methods.
- Three provider wrappers around existing RAG backends: `InMemoryRagProvider`, `VectorRagProvider`, `QdrantRagProvider`. No new runtime dependencies.
- Extend `buildRagCollectionToolEntries` with four MCP tools: `rag_create_collection`, `rag_list_collections`, `rag_describe_collection`, `rag_delete_collection`. Keep existing `rag_add`, `rag_correct`, `rag_deprecate`.
- Refactor pipeline wiring: add `ragRegistry` and `ragProviderRegistry` to `SmartAgentDeps`/`PipelineContext`. Keep `ragStores: Record<string, IRag>` as a **live projection** from `ragRegistry` for back-compat (see Migration section).
- `SmartAgent.closeSession(sessionId)` hook for explicit session cleanup (frees session-scoped collections and history memory).
- Typed errors for provider lookup, scope constraints, scope violations, collection-not-found.

Out of scope for v9.1.0:
- New backends. `HanaVectorRag`, `SapHanaVectorRagProvider`, any non-core provider — planned as separate packages (see Future roadmap below).
- Monorepo split — planned as v10.0.0.
- Collection name validation / sanitization policy — left to the consumer; registry passes names through as given.
- Automatic TTL sweeper — not needed given explicit `closeSession` hook. If a consumer wants TTL, it can call `closeSession` on a timer.

## Resolved questions

| # | Question | Decision |
|---|---|---|
| 1 | v9.1.0 scope | Full: providers + tools + three default provider wrappers + `HanaVectorRag` deferred to a separate package |
| 2 | Editability selection | Fixed at provider construction. `editable: true` → `DirectEditStrategy`; `editable: false` → `ImmutableEditStrategy`. Caller does not override per call. |
| 3 | Registry layering | Two registries: `IRagProviderRegistry` (static, providers) + `IRagRegistry` (dynamic, collections). Both injected into pipeline. |
| 4 | Delete safety | Scope-based. `global` — not deletable via MCP. `user` — requires matching `userId`. `session` — requires matching `sessionId`. |
| 5 | Scope attribute location | Both provider (`supportedScopes`) and collection (`scope`). Providers declare which scopes they can fulfill. |
| 6 | Session cleanup trigger | `SmartAgent.closeSession(sessionId)`. Consumer calls it from their session manager (logout, WebSocket disconnect, explicit end). LLM can additionally delete its own session collections earlier via `rag_delete_collection`. |
| 7 | Id strategy per provider | Provider-configurable via `idStrategyFactory` in constructor. Default: `SessionScopedIdStrategy` for `session` scope, `GlobalUniqueIdStrategy` for `user`/`global`. |
| 8 | Concrete provider shipping | Three wrappers ship in core: `InMemoryRagProvider`, `VectorRagProvider`, `QdrantRagProvider`. No new dependencies; these wrap classes already in the package. |
| 9 | Monorepo / package split | Deferred to v10.0.0. v9.1.0 stays single-package. |

## Interfaces

All new interfaces live in `src/smart-agent/interfaces/rag.ts`. Prefix `I` per project convention.

```ts
export type RagCollectionScope = 'session' | 'user' | 'global';

export interface RagCollectionMeta {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly editable: boolean;
  readonly scope?: RagCollectionScope;   // optional in the interface; SimpleRagRegistry normalizes missing → 'global'
  readonly sessionId?: string;           // populated when scope === 'session'
  readonly userId?: string;              // populated when scope === 'user'
  readonly providerName?: string;        // set when created via a provider
  readonly tags?: readonly string[];
}

export interface IRagProvider {
  readonly name: string;
  readonly kind: string;           // 'vector' today; other kinds reserved
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

Extended `IRagRegistry` (existing methods unchanged):

```ts
export interface IRagRegistry {
  register(/* existing */): void;
  unregister(/* existing */): boolean;
  get(/* existing */): IRag | undefined;
  getEditor(/* existing */): IRagEditor | undefined;
  list(): readonly RagCollectionMeta[];

  /** Create a collection via a provider and register it in one atomic step. */
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

  /** Delete a collection (unregister + delegate to provider if registered through one). */
  deleteCollection(name: string): Promise<Result<void, RagError>>;

  /** Unregister and delete all session-scoped collections for the given sessionId. */
  closeSession(sessionId: string): Promise<Result<void, RagError>>;
}
```

Existing `register` signature stays. The `meta` parameter gains optional `scope` (default `'global'` for back-compat when consumer doesn't specify).

## File layout

```
src/smart-agent/rag/
  providers/
    in-memory-rag-provider.ts      InMemoryRagProvider
    vector-rag-provider.ts         VectorRagProvider
    qdrant-rag-provider.ts         QdrantRagProvider
    simple-provider-registry.ts    SimpleRagProviderRegistry
    base-provider.ts               AbstractRagProvider (helpers: pickIdStrategy, checkScope, buildEditor)
    index.ts
  registry/
    simple-rag-registry.ts         (extended with createCollection / deleteCollection / closeSession)
  corrections/
    errors.ts                      (extended with new error types)
  mcp-tools/
    rag-collection-tools.ts        (extended with 4 new tools)
  __tests__/
    providers-simple-registry.test.ts
    in-memory-rag-provider.test.ts
    vector-rag-provider.test.ts
    qdrant-rag-provider.test.ts    (uses stub from existing qdrant-rag.test.ts)
    simple-rag-registry-create.test.ts
    simple-rag-registry-delete.test.ts
    simple-rag-registry-close-session.test.ts
    rag-collection-tools-create.test.ts
    rag-collection-tools-list.test.ts
    rag-collection-tools-describe.test.ts
    rag-collection-tools-delete.test.ts
    (plus updates to existing tests that used ragStores)
```

## Provider implementations

### `AbstractRagProvider`

Shared base with non-abstract helpers:

```ts
protected pickIdStrategy(opts: { scope, sessionId? }): IIdStrategy {
  if (this.idStrategyFactory) return this.idStrategyFactory(opts);
  if (opts.scope === 'session' && opts.sessionId) {
    return new SessionScopedIdStrategy(opts.sessionId);
  }
  return new GlobalUniqueIdStrategy();
}

protected buildEditor(rag: IRag, idStrategy: IIdStrategy): IRagEditor {
  return this.editable
    ? new DirectEditStrategy(rag.writer()!, idStrategy)
    : new ImmutableEditStrategy(this.name);
}

protected checkScope(scope: RagCollectionScope): Result<void, RagError> {
  if (!this.supportedScopes.includes(scope)) {
    return { ok: false, error: new UnsupportedScopeError(this.name, scope) };
  }
  return { ok: true, value: undefined };
}
```

### `InMemoryRagProvider`

```ts
class InMemoryRagProvider extends AbstractRagProvider {
  readonly kind = 'vector';
  readonly supportedScopes = ['session'] as const;

  async createCollection(name, opts) {
    const scoped = this.checkScope(opts.scope);
    if (!scoped.ok) return scoped;
    const rag = new InMemoryRag();
    const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
    return { ok: true, value: { rag, editor } };
  }
}
```

`deleteCollection` and `listCollections` are not implemented — in-memory has no persistent backing store to query. Registry-side unregister is enough; the `InMemoryRag` instance is garbage-collected.

### `VectorRagProvider`

Config: `{ name, embedder: IEmbedder, editable?: boolean, idStrategyFactory?, vectorRagConfig? }`. `supportedScopes: ['session']` (VectorRag is in-process, no persistence across sessions). Creates a new `VectorRag(embedder, cfg)` per collection.

### `QdrantRagProvider`

Config: `{ name, url, apiKey?, embedder, editable?, timeoutMs?, idStrategyFactory? }`. `supportedScopes: ['session', 'user', 'global']`. Creates `new QdrantRag({ url, apiKey, collectionName: name, embedder, timeoutMs })`. `deleteCollection(name)` calls `DELETE /collections/:name` on the Qdrant server. `listCollections()` calls `GET /collections` and returns names.

## Extended `SimpleRagRegistry`

`createCollection` — atomic with explicit preflight:
1. Look up provider: if missing → `ProviderNotFoundError`.
2. **Preflight duplicate-name check:** if `this.entries.has(name)` → `RagError('RAG_DUPLICATE_COLLECTION')`. Reject before touching the backend.
3. Call `provider.createCollection(name, opts)`. If it fails — return the provider error.
4. Try `this.register(name, rag, editor, { scope, sessionId, userId, providerName })`. This should not fail because of the preflight, but as defense-in-depth: if registration throws (e.g., race in subclass), best-effort rollback via `provider.deleteCollection?.(name)` and return the registration error.
5. On success, return the registered `RagCollectionMeta`.

`deleteCollection`:
1. Look up entry: if missing → `CollectionNotFoundError`.
2. If `meta.providerName` set, look up provider; call `provider.deleteCollection(name)` (ignore if provider has no delete). Errors propagate.
3. `unregister(name)`.

`closeSession`:
1. Collect all entries with `meta.scope === 'session'` and `meta.sessionId === sessionId`.
2. For each, call `this.deleteCollection(entry.name)`.
3. Aggregate errors: return first failure, or `ok` if all succeeded.

## MCP tool factory — extended

Updated signature:

```ts
export function buildRagCollectionToolEntries(opts: {
  registry: IRagRegistry;
  providerRegistry: IRagProviderRegistry;
}): RagToolEntry[];
```

New tools:

### `rag_create_collection`

Input: `{ provider, name, scope, displayName?, description?, tags? }`.
Handler:
1. Resolve provider from `providerRegistry`.
2. Extract `sessionId` / `userId` from `CallOptions` (available via MCP handler context — see "Context propagation" below).
3. Call `registry.createCollection({ providerName, collectionName: name, scope, sessionId, userId, ... })`.
4. Return `{ ok, meta }` on success, `{ ok: false, error }` on failure.

The tool is omitted from the returned entries if `providerRegistry.listProviders().length === 0` — there's nothing to create with.

### `rag_list_collections`

Input: `{ scope?, provider? }` (both optional filters).
Handler: filters `registry.list()` by scope and/or providerName. Returns array of `RagCollectionMeta` (filtered).

### `rag_describe_collection`

Input: `{ name }`.
Handler: finds the collection in `registry.list()`. Returns its full `RagCollectionMeta` or `{ ok: false, error: CollectionNotFoundError }`.

### `rag_delete_collection`

Input: `{ name }`.
Handler:
1. Find collection via `registry.list()` entry with that name. If not found → `CollectionNotFoundError`.
2. Scope check:
   - `global` → reject with `ScopeViolationError` ("global collections can't be deleted via MCP").
   - `user` → require `ctx.userId === meta.userId`, else `ScopeViolationError`.
   - `session` → require `ctx.sessionId === meta.sessionId`, else `ScopeViolationError`.
3. On pass, call `registry.deleteCollection(name)`.

`ctx` here is the tool handler context; see below.

## Context propagation

MCP tool handlers need `sessionId` and `userId` from the call context for scope enforcement. Current `RagToolEntry.handler(context: object, args)` accepts `context: object` — any shape. We formalize a typed shape:

```ts
export interface RagToolContext {
  sessionId?: string;
  userId?: string;
  // Consumers may attach more fields (auth claims, trace IDs, etc.).
  [key: string]: unknown;
}
```

**Propagation path (confirmed from code):** `buildRagCollectionToolEntries` returns handlers that the consumer's MCP server invokes. `llm-agent` itself does NOT run an embedded MCP server for these tools (per the architectural decision in v9.0.0). Therefore, `sessionId` and `userId` must be populated by the **consumer's MCP wiring**:

1. The consumer's MCP server receives a tool call from the LLM (which runs inside llm-agent as an MCP client).
2. The consumer's MCP server knows the session/user context from its own auth/session layer (e.g., JWT claims in the MCP HTTP request).
3. The consumer passes that into the handler: `handler({ sessionId, userId, ...extra }, args)`.

**What llm-agent guarantees:** it exports `RagToolContext` as a typed shape; handlers read `sessionId` / `userId` from it; if missing for a scope that requires them, handler returns a typed error (`ScopeViolationError` with reason `'missing sessionId'` or `'missing userId'`).

**Compatibility classification:**
- **Type-level:** `RagToolContext` is structurally compatible with `object` — any existing `{}` still satisfies the type. No breaking import.
- **Runtime:** new tools (create/delete) require fields in context that old consumers aren't necessarily providing. For consumers who only use v9.0.0 tools (`rag_add`, `rag_correct`, `rag_deprecate`) — behavior unchanged. For consumers who adopt the new tools — they must wire context in their MCP server. This is an **additive contract** on new tools, not a breaking change to existing ones.

The 9.0.0 existing tools (`rag_add`, `rag_correct`, `rag_deprecate`) do **not** start reading from context in v9.1.0 — they remain context-agnostic. Only the four new tools check context.

## Builder API

New fluent methods on `SmartAgentBuilder`:

```ts
.addRagProvider(provider: IRagProvider): this
.addRagCollection(params: {
  name: string;
  rag: IRag;
  editor?: IRagEditor;
  meta?: Omit<RagCollectionMeta, 'name' | 'editable'>;
}): this
.createRagCollection(params: {
  providerName: string;
  collectionName: string;
  scope: RagCollectionScope;
  sessionId?: string;
  userId?: string;
  displayName?: string;
  description?: string;
  tags?: readonly string[];
}): this  // queued at build time; actual creation happens during buildAgent()
.setRagRegistry(registry: IRagRegistry): this             // inject custom registry
.setRagProviderRegistry(registry: IRagProviderRegistry): this
```

Default behavior when consumer doesn't touch these: builder creates `SimpleRagProviderRegistry` and `SimpleRagRegistry` internally; `addRagProvider` / `addRagCollection` populate them.

## Pipeline integration

`SmartAgentDeps`:

```ts
export interface SmartAgentDeps {
  // existing fields…
  ragRegistry: IRagRegistry;
  ragProviderRegistry: IRagProviderRegistry;
  ragStores: Record<string, IRag>;  // retained as a LIVE PROJECTION from ragRegistry; see below
  translateQueryStores?: Set<string>;  // unchanged
}
```

`PipelineContext`: same addition; `ragStores` retained.

`ragStores` is maintained as a **derived view** backed by `ragRegistry`. Two options for implementation:

- **Eager:** whenever the registry mutates (register/unregister/createCollection/deleteCollection/closeSession), it recomputes `deps.ragStores = Object.fromEntries(registry.list().map(m => [m.name, registry.get(m.name)!]))`. Simple, predictable.
- **Proxy-based:** `ragStores` becomes a `Proxy` whose `get(key)` delegates to `registry.get(key)` and whose `ownKeys` returns `registry.list().map(m => m.name)`. No sync needed but harder to reason about when debugging.

Lean: **eager**, with the sync hook baked into `SimpleRagRegistry` via a `mutationListener` injected by the builder.

Code that iterates `ragStores` today (`assembler.ts`, `rag-query.ts`, `revectorizeTools` in `agent.ts`, `smart-server.ts` hot-reload) continues to work unchanged because `ragStores` is still there with the same shape. New code written in v9.1.0 should prefer `ragRegistry` — it carries scope and meta info; `ragStores` only has the `IRag` instances.

Public API retained with full semantics. `SmartAgent.addRagStore(name, store, opts)` keeps all current behavior:
- Rejects overwrite of built-in names `tools` and `history` (throws as today).
- Internally calls `this.deps.ragRegistry.register(name, store, undefined, { scope: 'global' })`.
- Updates `this.deps.translateQueryStores` when `opts.translateQuery === true`.
- Triggers `this.deps.pipeline?.rebuildStages?.()`.

`SmartAgent.removeRagStore(name)`:
- Rejects removal of built-in names `tools` and `history`.
- Internally calls `this.deps.ragRegistry.unregister(name)`.
- Removes `name` from `translateQueryStores`.
- Triggers `this.deps.pipeline?.rebuildStages?.()`.

The `ragStores` projection updates automatically after `register` / `unregister` through the mutation listener (see "Projection sync mechanism" in open items). No consumer code needs to change for existing callers.

## `SmartAgent.closeSession`

```ts
async closeSession(sessionId: string): Promise<void> {
  await this.deps.ragRegistry.closeSession(sessionId);
  this.deps.historyMemory?.clear(sessionId);
  // Hook for future cleanup (caches, connections, etc.)
}
```

`IHistoryMemory.clear(sessionId): void` is the existing interface — no interface change.

Failures from `closeSession` are logged but not thrown — best-effort cleanup. Consumer can still inspect logs if needed.

## Error types

New errors in `src/smart-agent/rag/corrections/errors.ts` (grouped with existing `ReadOnlyError` / `MissingIdError` for symmetry):

- `UnsupportedScopeError(providerName, scope)` — code `RAG_UNSUPPORTED_SCOPE`.
- `ProviderNotFoundError(providerName)` — code `RAG_PROVIDER_NOT_FOUND`.
- `CollectionNotFoundError(name)` — code `RAG_COLLECTION_NOT_FOUND`.
- `ScopeViolationError(name, reason)` — code `RAG_SCOPE_VIOLATION`.

All extend `RagError` per existing pattern.

## Testing

Unit tests per new module (as listed in file layout). Key scenarios:

- **Providers:** supportedScopes rejection path; editable flag selects correct strategy; id strategy defaults follow documented rules; `idStrategyFactory` override wins.
- **Registry:** `createCollection` atomic (fails if provider fails, no orphan registration); `deleteCollection` delegates to provider; `closeSession` cleans matching session-scoped and leaves other scopes intact.
- **MCP tools:** scope enforcement on delete (session/user/global paths); list/describe correctness; create through in-memory provider in integration-style test (no network).
- **Pipeline:** existing `assembler.ts` / `history-upsert.ts` tests must pass after the `ragStores` → `ragRegistry` refactor.
- **Session close hook:** integration test asserting session-scoped collections disappear after `agent.closeSession(sessionId)` but user/global survive.

## Migration for 9.0.0 consumers

Runtime behavior stays backward-compatible for builder-based consumers. TypeScript surface remains compatible except where explicitly noted below.

- `SmartAgentDeps.ragStores` — **retained as a live projection** from `ragRegistry` (sync via mutation listener). Consumers who build `SmartAgentDeps` manually or use the builder get transparent compatibility.
- `SmartAgent.addRagStore` / `removeRagStore` — **semantics fully preserved** (built-in name protection, `translateQueryStores` sync, `pipeline.rebuildStages()` trigger). See "Pipeline integration" above for the exact delegate flow.
- `buildRagCollectionToolEntries({ registry })` — signature accepts an optional `providerRegistry`. When omitted, the four new tools (`rag_create_collection`, `rag_list_collections`, `rag_describe_collection`, `rag_delete_collection`) are omitted from the returned entries; existing tools work unchanged.
- `RagCollectionMeta.scope` — added as **optional** field on the public interface. Existing code that constructs `RagCollectionMeta` literals without `scope` keeps compiling. `SimpleRagRegistry` internally normalizes missing values to `'global'` for consistent handling.
- `RagToolEntry.handler` — `context` parameter type tightens from `object` to `RagToolContext` (structurally compatible; old `{}` still satisfies). Existing handler bodies unchanged.
- New public methods on `SmartAgent`: `closeSession(sessionId)`. Additive.
- New public methods on `SmartAgentBuilder`: `addRagProvider(...)`, `addRagCollection(...)`, `createRagCollection(...)`, `setRagRegistry(...)`, `setRagProviderRegistry(...)`. Additive.

**Known source-compatibility edge cases** (not breaking for typical consumers):
- Consumers that directly implement the `IRagRegistry` interface (rather than extending `SimpleRagRegistry`) must add the three new methods (`createCollection`, `deleteCollection`, `closeSession`). This is legitimately a TypeScript source-breaking change. Documented in release notes.
- Consumers that construct `RagCollectionMeta` literals with `scope` set stay compatible — the field is optional.

## Future roadmap (not in v9.1.0)

### v10.0.0 — monorepo restructure
- Convert repo to npm workspaces.
- Extract `@mcp-abap-adt/llm-agent-server` (CLI + HTTP server + smart-server.yaml).
- Extract `@mcp-abap-adt/hana-vector-provider` (new `HanaVectorRag` + provider; depends on `@sap/hana-client`).
- Extract `@mcp-abap-adt/sap-aicore-provider` (SAP AI Core LLM + embedder; depends on `@sap-ai-sdk/*`).
- Potentially extract `@mcp-abap-adt/openai-provider`, `@mcp-abap-adt/anthropic-provider`, `@mcp-abap-adt/ollama-provider`.
- `@mcp-abap-adt/llm-agent` core becomes backend-agnostic abstractions + pipeline + session management. Minimum runtime deps (zod, axios/fetch).
- Release management via `@changesets/cli`.
- Major bump because published import paths change.

This directly informs v9.1.0 design: the `IRagProvider` interface and provider implementations must be self-contained enough that moving `QdrantRagProvider` into its own package later requires only re-homing the file + updating its imports, not rewriting the interface or touching core.

## Open items for implementation plan

- Hot-reload integration in `smart-server.ts`: currently it iterates `Object.values(ragStores)` for reconfigure paths; when registry becomes source of truth and `ragStores` is derived, confirm that rebuild hooks fire in the right order on reconfigure.
- `rag_create_collection` sessionId source: auto-populate from `context.sessionId` rather than requiring the LLM to pass it — minimizes LLM error surface.
- Projection sync mechanism for `ragStores` ← `ragRegistry`: eager via `mutationListener` (lean) vs. Proxy. Resolve before coding `SimpleRagRegistry` extensions.

