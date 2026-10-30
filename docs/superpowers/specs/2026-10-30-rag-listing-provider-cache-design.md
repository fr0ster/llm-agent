# RAG listing and provider cache - design

## Intent

cloud-llm-hub keeps a startup snapshot of collection records because `IRag` exposes
query, getById and writer, but no listing capability. Other instances change the DB
without updating that snapshot. Replace this host-owned data copy with paginated
store reads and narrowly scoped caches inside SQL providers.

This checkout already has `IRagScanner` in
`packages/llm-agent/src/interfaces/rag-scan.ts`, implemented by the four backends.
Reuse its scan machinery and strict metadata filters; preserve its public contract.
Expose listing directly on the typed `IRag` surface so hosts need no structural casts.

## Goals and non-goals

- Optional, additive listing without embeddings, vectors or relevance scores.
- PostgreSQL and HANA cache records by id internally. In-memory is the store and
  has no cache. Qdrant has no cache.
- Writes accept complete replacement text and metadata, never merge with or modify
  a cached record. The DB's atomic per-record upsert is sufficient; no revision
  checking, optimistic locking or cross-instance coherence protocol.
- Listing always reads the store. A cached getById may lag another instance's write
  for at most its fixed TTL, measured from the originating DB read's start, plus
  backend visibility/replication delay. Expired entries are never served.
- No consistent snapshot across pages, atomic multi-record write guarantee, host
  implementation, new edit/patch API, or cache in a registry, decorator or host.

## Listing contract

Add these exports beside `IRagBackendWriter` in
`packages/llm-agent/src/interfaces/rag.ts`, using existing `RagJsonValue`,
`RagScanFilter`, `CallOptions`, `Result` and `RagError`:

```ts
export interface RagListParams {
  cursor?: string;
  limit?: number;
  includeText?: boolean;
  filter?: RagScanFilter;
}
export interface RagListRecord {
  id: string;
  metadata: RagListMetadata;
  text?: string;
}
export interface RagListMetadata {
  id?: string;
  ttl?: number;
  namespace?: string;
  [key: string]: RagJsonValue | undefined;
}
export interface RagListPage {
  records: RagListRecord[];
  cursor?: string;
}
export interface IRagBackendReader {
  list(
    params?: RagListParams,
    options?: CallOptions,
  ): Promise<Result<RagListPage, RagError>>;
}
```

Add optional `list?: IRagBackendReader['list']` to `IRag`. A caller narrows with
`if (rag.list)` and calls `rag.list(params, options)`; no `any`, `unknown`, cast or
runtime structural guard is needed. Export types through
`packages/llm-agent/src/index.ts`. Existing implementations remain valid.
Existing RagMetadata has an unrestricted value index; do not propagate it into
the new public types. Validate listing metadata as finite JSON values (optional
absent fields allowed), returning `RAG_INVALID_METADATA` for unsupported stored
values rather than casting or silently dropping them. Legacy read/write types
remain unchanged; cache admission skips records that cannot be safely detached.
Wrappers may omit listing; do not forward it through overlays or scope/filter
wrappers unless their full visibility rules are preserved.

`limit` defaults to 100; accept integers 1..1000, reject other values with
`INVALID_ARGUMENT`. `includeText` defaults to false; false omits text, true includes
it even when empty. Records contain no vector or score. Return detached metadata
and text, with the same canonical id as getById. Enumerate expired records too,
matching scan's administrative semantics. Collection/namespace isolation still
applies; listing is not an authorization boundary.

Support only cheap existing filter keys: userId, sessionId and namespace, strict
string equality, AND together, missing keys excluded. Reuse `RagScanFilter` and
validation. Intersect with `CallOptions.ragFilter` identity constraints; conflicting
constraints return an empty terminal page rather than widening access.

Order is deterministic within a backend and unchanged collection, not portable
between backends. Cursors are opaque, versioned and bound to backend, store and
effective filter; malformed or mismatched cursors return `INVALID_ARGUMENT`.
Changing limit or includeText is allowed. Do not accept scan cursors as list
cursors. A page may be short or empty with a cursor; only its absence means done.
Concurrent inserts before the cursor may be missed; updates/deletes may change
later pages. A fresh traversal starts without a cursor. No server-side session or
collection materialization is required.

Honour `CallOptions.signal` before work, between backend steps and before returning
success, returning `ABORTED` through Result. Propagate it to cancellable driver/HTTP
operations. If a SQL driver cannot cancel, suppress its late result, release its
resources when settled and do not populate cache. Backend failures use RagError,
never a successful empty page.

## Backend implementation

Implement list on the existing collection classes; share scan primitives without
changing legacy scan defaults, ordering or cursor formats.

| Backend and files | Listing approach and order |
| --- | --- |
| In-memory: `packages/llm-agent/src/rag/in-memory-rag.ts`, `packages/llm-agent/src/rag/vector-rag.ts` | Traverse live records by existing stable numeric slot key, skipping deleted slots and applying store/filter constraints. No second record store or cached pages. |
| PostgreSQL: `packages/pg-vector-rag/src/pg-vector-rag.ts`, `src/scan-delete.ts`, `src/store-sql.ts` within that package | Parameterized keyset SQL, id greater than cursor, ascending binary/C collation for both predicate and ordering, LIMIT. Push strict filters into SQL. Both per-collection and shared layouts retain their store predicate. |
| HANA: `packages/hana-vector-rag/src/hana-vector-rag.ts`, `src/scan-delete.ts`, `src/store-sql.ts` within that package | Parameterized keyset SQL by ID with the same binary comparison in predicate and ordering, bounded LIMIT. Reuse strict client-side metadata filtering when SQL filtering is unavailable; advance cursor from the last examined row, including an empty filtered page. Decode LOBs as existing reads do. |
| Qdrant: `packages/qdrant-rag/src/qdrant-rag.ts`, `src/scan-delete.ts` within that package | Native scroll by ascending physical point id, retaining next_page_offset in the opaque cursor. Logical metadata ids need not have this order. Push payload filters and retain strict client-side checks. Request no vectors; omit text from returned records unless requested. |

All backends examine at most the requested limit per page (maximum 1000); filtering
may shorten the result. SQL projections omit text when possible; client-side HANA
filtering and Qdrant payload decoding may fetch more fields but must omit them from
the public result. Existing scan remains available to current consumers.

## PostgreSQL and HANA record caches

Add provider-private cache modules at
`packages/pg-vector-rag/src/record-cache.ts` and
`packages/hana-vector-rag/src/record-cache.ts`. Add typed optional
`recordCache?: false | { maxEntries?: number; maxBytes?: number; ttlMs?: number }`
to each package's config in `src/connection.ts` and provider config in
`src/pg-vector-rag-provider.ts` or `src/hana-vector-rag-provider.ts` respectively.
Provider config overrides connection config; standalone collection constructors
use connection config. No new environment variables.

Defaults: 1000 entries, 16 MiB serialized UTF-8 record bytes, 5000 ms TTL. Require
positive finite safe integers; false disables caching. Evict least recently used
entries to satisfy both limits; skip oversized records. Cache successful full
getById records only, never misses, errors, vectors, scores, query results, list
pages or scan pages. Return detached copies on insertion and retrieval. Reads do
not extend expiry, and a DB read that has already exceeded TTL is not cached.

Cache ownership is one SQL provider instance, shared by all its handles to the same
physical store. Standalone collection objects own a private cache. Key by physical
store identity (schema/table/layout/collection), id and any effective read scope;
never share records between connections, stores or identities. Provider shutdown
releases its entries. Handles opened and created through the same provider must
use the same cache/invalidation coordinator.

No list-page caching: a page has membership, ordering and filters that a single
record invalidation cannot safely repair. list, scan and query read authoritative
backend results and neither hydrate from nor populate the record cache. This
preserves the rule that a write invalidates only its own record. Fixed TTL bounds
external staleness without invalidating unrelated records or requiring a sweep
after each write. Cache miss means an ordinary DB read, never a host snapshot
fallback; DB failure after expiry returns an error, never stale data.

## Writes, invalidation and read ordering

Centralize invalidation below public methods so direct class writes, editor calls
and writer closures all reach it. Cover upsert, upsertPrecomputed, upsertRaw,
upsertPrecomputedRaw, deleteByIdRaw, deleteWhere, clearAll, provider deleteCollection
and every implemented bulk path, including future upsertManyPrecomputedRaw.

- Resolve the id independently of cached data. Invalidate only that id before
  submitting a write and again when it settles, success or failure. For a bulk
  write do this for every submitted id; do not flush unrelated entries.
- Prevent reads overlapping a pending write from serving or populating that id's
  cache. Reads begun before invalidation cannot repopulate it after the write.
  Use provider-local per-id in-flight coordination/tokens, discarded when idle;
  these are cache bookkeeping, not persisted revisions or optimistic locking.
- Validation/embedding failure before DB submission changes no DB state. Once
  submitted, timeout, cancellation or connection loss can mean uncertain commit:
  keep affected ids evicted, never restore their previous values. A subsequent
  read goes to the DB to establish visible state.
- deleteWhere must track actual submitted ids, not infer them from cache contents.
  PostgreSQL selects matching ids under row locks in a transaction, invalidates
  them, then deletes only those ids, using DELETE RETURNING for the count. Records
  inserted after selection are outside this operation. HANA already selects ids
  and deletes in batches: invalidate submitted batch ids even on partial/uncertain
  failure. Both retain unrelated entries; never decide membership from cached
  metadata, which could itself be stale.
- clearAll and store deletion invalidate that store's entries before and after
  submission, including failure/uncertainty. Prevent late reads or old handles from
  repopulating a deleted store. Other stores remain cached. Catalog-only failure
  before data submission need not evict records.

A getById, query or list started after a successful awaited write sees the DB's
new state through that provider, assuming the configured backend provides
read-after-write visibility and no intervening writer. Reads racing a write have
ordinary backend semantics. Do not claim ordering between independent standalone
objects or processes; their getById cache is bounded by TTL. Use authoritative DB
reads on the write connection/primary where necessary. Preserve query ranking and
existing getById result shape, including its conventional score.

Cache entries are read conveniences, never edit inputs. Hosts submit explicit full
replacement records; callers needing current content for an edit must use an
authoritative read path such as list, and still accept concurrent last-writer-wins
upserts. This design does not prevent application-level lost updates.

## Host migration and release

cloud-llm-hub can capability-check `rag.list`, fetch pages on demand, and remove its
startup snapshot and write-side snapshot maintenance. Handle unsupported capability
explicitly rather than silently maintaining a stale copy. Host UI, routes and
migration code are outside this repository's scope.

Implementation requires minor changesets for `@mcp-abap-adt/llm-agent`,
`@mcp-abap-adt/pg-vector-rag`, `@mcp-abap-adt/hana-vector-rag` and
`@mcp-abap-adt/qdrant-rag`. Document listing and cache options in `README.md` and
the affected package READMEs. No breaking scan/writer changes, DB schema migration,
new required capability or host dependency. This document creates no changeset.

## Verification plan

Add shared listing conformance cases in
`packages/llm-agent/src/testing/rag-list-conformance.ts`, following
`packages/llm-agent/src/testing/rag-filter-conformance.ts`, and run them from each
backend's existing tests. Cover empty stores, exact page boundaries, short/empty
filtered pages, deterministic order, deletion gaps, cursor mismatch/validation,
limits, text projection, detached metadata, strict identity filters, expired records,
store isolation, errors and cancellation. Verify concurrent traversal semantics
without asserting snapshot isolation; typecheck optional capability narrowing and
unchanged custom IRag implementations.

SQL cache tests use fake time and controllable DB responses: expiry without sliding,
entry/byte bounds, oversized records, no negative cache, disabled cache, mutation
isolation, exact per-id eviction across handles and stores, all write entry points,
bulk partial failure, filtered deletion, store deletion and uncertain outcomes.
Exercise delayed reads racing successful/failed writes and deletion so old data
cannot repopulate. Assert list/query/scan always reach the backend and other ids
remain cached after a record write. Verify in-memory and Qdrant add no cache.

Run real PostgreSQL/HANA tests for both layouts, plus Qdrant integration tests for
scroll order and read-after-write visibility. Two provider instances must observe
external writes immediately through listing and by the TTL bound through getById.
Run targeted package tests, repository lint/type/build checks and existing smoke
checks when implementing. For this design-only change, review the Markdown and
verify the diff and LF line endings; no runtime code or tests change.
