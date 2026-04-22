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
- Refactor pipeline wiring: `ragStores` field in builder/deps/context is replaced by `ragRegistry` and `ragProviderRegistry`.
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
  readonly scope: RagCollectionScope;
  readonly sessionId?: string;    // populated when scope === 'session'
  readonly userId?: string;       // populated when scope === 'user'
  readonly providerName?: string; // set when created via a provider
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

`createCollection`:
1. Look up provider: if missing → `ProviderNotFoundError`.
2. Call `provider.createCollection(name, opts)`.
3. On success, call `this.register(name, rag, editor, { scope, sessionId, userId, providerName })`.
4. Return the registered `RagCollectionMeta`.

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

MCP tool handlers need `sessionId` and `userId` from `CallOptions`. Current `RagToolEntry.handler(context, args)` passes `context: object` — insufficient. Change signature to `handler(context: RagToolContext, args: Record<string, unknown>)` where:

```ts
export interface RagToolContext {
  sessionId?: string;
  userId?: string;
  // Extensible: consumers may attach more fields for their own tools.
  [key: string]: unknown;
}
```

Consumer wiring: the consumer's MCP server receives tool calls and must forward its own per-call context (session/user) into the handler. `buildRagCollectionToolEntries` returns handlers that read from `context`. If `sessionId` or `userId` is missing for a scope that requires it — the handler rejects.

This is a **non-breaking** change because current `RagToolContext` accepted `object` (anything). Existing consumers that pass `{}` will get the same behavior, just with optional extra fields now typed.

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
  // ragStores: Record<string, IRag>  — REMOVED
}
```

`PipelineContext`: same change.

Code that iterated `ragStores` (`assembler.ts`, `revectorizeTools` in `agent.ts`) now iterates `ragRegistry.list()` and looks up via `ragRegistry.get(name)`.

Back-compat note: `ragStores` never appeared in public API documentation as a consumer-facing contract; it was an internal wiring detail. Removing it is not a breaking public API change.

## `SmartAgent.closeSession`

```ts
async closeSession(sessionId: string): Promise<void> {
  await this.deps.ragRegistry.closeSession(sessionId);
  this.deps.historyMemory?.flush?.(sessionId);
  // Hook for future cleanup (caches, connections, etc.)
}
```

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

Fields renamed and methods added; no breaking changes to public types.

- `SmartAgentDeps.ragStores` → removed; use `ragRegistry` / `ragProviderRegistry`. Consumers who built `SmartAgentDeps` manually must switch. Consumers using `SmartAgentBuilder` are transparently migrated — builder exposes the same ergonomics.
- `buildRagCollectionToolEntries({ registry })` → `buildRagCollectionToolEntries({ registry, providerRegistry })`. Consumers without a provider registry pass an empty `SimpleRagProviderRegistry`; create-tool won't appear in the returned entries, other tools work as before.
- `RagCollectionMeta.scope` — new required field at interface level but defaulted to `'global'` by `SimpleRagRegistry.register` when not provided, preserving back-compat for code that calls `register(name, rag, editor)` without meta.

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

- Exact shape of `CallOptions` / `RagToolContext` propagation in the MCP handler path: need to confirm whether llm-agent's own MCP integration passes these through from `agent.process(options)`, or consumer supplies them via their MCP server wiring.
- Whether `rag_create_collection` should default `sessionId` from the handler context (auto) or require the LLM to pass it (explicit). Lean: auto from context, to minimize LLM error surface.
- Handling of name collisions: `register` already throws on duplicate name; what happens on `createCollection` with an existing name — reject, or treat as "attach"? Lean: reject with `RagError(DUPLICATE)`, force explicit intent.
