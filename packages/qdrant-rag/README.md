# @mcp-abap-adt/qdrant-rag

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

QdrantRag vector store and QdrantRagProvider for @mcp-abap-adt/llm-agent.

Provides vector search capabilities using Qdrant as the backend.

## Record embeddings

Each record is one Qdrant point with its existing payload and a dense
multivector configured with the `max_sim` comparator. A search sends one
query vector, so the point score is the best fragment score. Replacing a
record overwrites its point and all its vectors. Short records have one
vector in the multivector.

### Upgrade an existing collection

Multivectors require Qdrant 1.10 or newer. The catalogued provider requires
Qdrant 1.17 or newer for catalog creation. Legacy single-vector collections
remain available for reads, search, deletes and single-fragment writes. A
write with several fragments returns an error with the migration command.

Run this migration offline only. Stop every process that writes to the Qdrant
collections being migrated or recovered, including application servers and
background workers. Never run two migrations at once. An operator can run the
CLI, or one application process can call the migration before it starts serving
requests. Set `QDRANT_URL` and, when needed, `QDRANT_API_KEY` in the environment.

```sh
qdrant-migrate-multivector --collection my_collection --dry-run
qdrant-migrate-multivector --collection my_collection
qdrant-migrate-multivector --all
```

Use `--all --catalog NAME` when the provider has a custom catalog, or
`--collection NAME` for an independently managed store. Applications can
call `migrateQdrantMultivectors({ url, collection, credential, signal })`.
The migration copies IDs, payloads, dense vectors, sparse vectors and collection
and payload-index settings, and restores collection aliases. It verifies the
temporary copy before replacing the original under its existing name, then
verifies the restored copy. Each invocation recovers interrupted migrations
before processing the requested collection or catalog, including collections
without a catalog entry. A dry run reports these recoveries as `resume` and
leaves Qdrant unchanged.

After an interruption or an unconfirmed operation, keep writers stopped and
wait for all pending Qdrant operations from that run to settle. Then rerun the
same command or API call. The migration resumes from any surviving temporary
collection. If an unconfirmed delete already removed the temporary collection,
the verified original remains in place. The migration reports the operation and
stops immediately on an unconfirmed mutation, with one exception. An HTTP 429
on an upsert to the private temporary collection retries the identical request
according to `Retry-After` without an attempt limit. If the retry succeeds, the
migration restores and verifies the original and reports
`temporaryCollectionRetained: true`. After pending server operations settle,
rerun the same command to finish cleanup before restarting writers.

An unreadable recovery marker stops the command and leaves its temporary
collection intact. Custom shard keys keep their own points. The server's native
multivector size constraints apply. Pass an `AbortSignal` to cancel requests.
Qdrant may still apply a write that was in flight when the request was canceled.

Configure `fragmentSizeChars` for embedders that do not declare their capacity
(default 2,048 Unicode code points).

## Query embedding fallback

`QdrantRagConfig.fallbackOnQueryEmbeddingError?: boolean` defaults to `true`:
if a caller-supplied query embedding rejects, `QdrantRag` tries its own embedder.
Set `fallbackOnQueryEmbeddingError: false` in `new QdrantRag({ ... })` to return
the first failure as a failed `Result` without a second embedder call.
An explicit `TextOnlyEmbedding` is always embedded once by the store, and its
failure is returned without retrying. Successful caller embeddings are reused.

Requires Qdrant 1.17 or later: the collection catalog is written with an insert-only operation.

## Catalog, rights, and the Qdrant version

`QdrantRagProvider` keeps one record per collection in a catalog collection of its own
(`rag_collection_catalog` by default, `catalogCollection` to rename it): one point per collection,
the record in its payload. `createCollection` embeds one probe string to learn the vector size,
creates the collection, and then writes its record; `deleteCollection` deletes the record first, then
the collection; `describeCollections` reads the catalog back.

- **Qdrant 1.17 or later is required** for a catalogued store: the record is written with
  `update_mode: "insert_only"`, which exists from 1.17.
- **The key must be able to manage collections**: create collections (the catalog on first use, one
  per collection), write, read and delete points in the catalog, and delete collections. A
  `read-only-api-key`, or a JWT restricted to named collections, is not enough.
- A standalone `QdrantRag` (a store configured directly, not through the provider) keeps creating
  its collection on the first write (`autoCreateCollection`, default `true`); the provider's handles
  never create theirs.

A collection created before this release has a collection and no record: take it over once with
`createCollection(..., { adoptExisting: true })`.

## Collection access persistence

Run `migrateQdrantVectorRagAccess(provider)` before serving requests and check its
`Result`. The idempotent migration creates `rag_collection_roles` alongside
`rag_roles`, `rag_role_assignments`, and `rag_session_bindings`. Legacy role-owned
catalog entries and records tagged `ownerScope: 'role'` remain unchanged and are
reported for administrative resolution. They are never converted to global data.

`createQdrantVectorRagAccessStores(provider)` returns `{ roles, roleAdmin, bindings }`
from the same persistence. Pass `{ decision, roles, bindings }` as `RagAccess`;
keep `roleAdmin` in trusted host administration code. A collection has one session,
user, or global owner plus zero or more bound roles. Call
`roleAdmin.bindCollection(collectionName, roleId)` to share an existing collection.
A missing role or collection is refused. Delete a role only after revoking every
assignment and unbinding every collection; otherwise deletion returns `RoleInUseError`.

Access requires the owner or at least one bound role and the host decision.
Global reads remain available to everyone subject to that decision; global writes
require an admin and a write decision. Admin status does not bypass other owners.
Retrieval applies the collection owner's record filter before top-k; `roleId` is
not a record identity key. Access-check errors deny access.

Qdrant stores collection-role intents in the `rag_collection_roles` access
collection. Binding verifies the catalog write identity and role generation after
persisting its intent, and compensates refused writes. Role deletion uses the
existing revision CAS chain, scanning both assignments and collection bindings
while fenced in the deleting state. Access accepts only active role generations.
Custom catalogs use the existing catalog-prefixed access collection names.

Collection deletion removes the catalog record, then data, then role bindings.
A durable generation marker denies role access during deletion and lets a new
provider resume after a crash. Bindings match `catalog_write_id`, so old grants
never apply to a recreated collection. Deleting the same Qdrant collection from
two processes concurrently is not supported: run deletions from one process;
retries are safe. An owner with an existing handle may still read their own
collection while it is being deleted, until the data is removed; global readers
may likewise continue reading, subject to the host decision.


Every valid new record carries a positive `ownerScope` tag. Queries match this scope
and its required identity before top-k. Global queries use `ownerScope = 'global'`
and have no exact-version gate or missing-field predicate. Records without a scope,
with mismatched scope/identity, or conflicting keys fail closed. Writers refuse
inconsistent owners (including precomputed and batch paths). Migration marks
conflicting stored owners as `ownerScope: 'invalid'` and reports each record.
Shared read validation rejects all extra owner keys, including null keys on global
records; backend query predicates remain positive equalities.

These backend stores provide ownership persistence, not server authorization.
The core access layer must also approve every request; global management requires
both the trusted caller's admin flag and the server decision.

## Scan, filtered delete and catalog update

The store implements `IRagScanner` and `IRagFilteredDeleter`, and the provider implements `IRagCatalogUpdater` (guards `isRagScanner`, `isRagFilteredDeleter`, `isRagCatalogUpdater` from `@mcp-abap-adt/llm-agent`). The library wrappers (`OverlayRag`, `SessionScopedRag`, ...) do not forward them; use the provider's handle.

- `scan({ filter?, pageSize?, cursor? })` returns `{ records, cursor? }`: `id`, `text`, `metadata`, never a vector, expired records included. `filter` is strict string equality on `userId`, `sessionId`, `namespace`. `pageSize` is a positive integer (default `DEFAULT_SCAN_PAGE_SIZE`, 500), otherwise `INVALID_ARGUMENT`; a filter value that is not a string and a malformed cursor are `INVALID_ARGUMENT` too. **Only a missing `cursor` ends the scan**: a page may be short or empty while a cursor is still returned. `id` is `metadata.id` when the record has one, otherwise the Qdrant point id; the round trip into `getById` / `deleteById` is guaranteed only for records written with an id.
- `deleteWhere(filter)` deletes the matching records of this collection only and returns `{ deleted }`. An empty filter is `INVALID_ARGUMENT`. It is exact against a snapshot, not atomic: it scrolls the matching point ids with a payload filter, then deletes them with `wait=true` in batches and returns how many it deleted: Qdrant's delete reports no count, so before each batch it retrieves the batch ids, deletes exactly those still present and counts them: the count is exact except when another caller deletes the same ids in the window between that retrieve and the delete (Qdrant has no server-side count). The server-side `match` is only a prefilter: Qdrant's `match.value` also matches an element of an array payload value, so every scrolled point is re-checked with the strict string-equality matcher, and a point whose `userId`/`sessionId`/`namespace` is an array is neither scanned nor deleted. The scan cursor is Qdrant's point offset (unsigned integer or UUID); anything else is `INVALID_ARGUMENT`. A matching record inserted while it runs may survive; repeat the call if you need to.
- An aborted `signal` gives `ABORTED` (`Aborted after deleting N record(s)` once a delete has started).
- `updateCollection(storeName, { collectionName?, attributes? })` rewrites the catalog point's payload (the record is read first). `attributes` replaces the stored attributes as a whole; `storeName`, `scope` and the owner never change. A missing record is `RAG_COLLECTION_NOT_FOUND`, an empty patch or a `collectionName` that is not a non-empty string `INVALID_ARGUMENT`, an attribute value that cannot be stored `RAG_INVALID_ATTRIBUTES`.

`scan` uses `POST /collections/{c}/points/scroll` with the payload filter; the cursor is the scroll offset. A 404 on the catalog write is `RAG_COLLECTION_NOT_FOUND` too. Note: `match.value` also matches an element of an array payload (`userId: ['u1']` matches the filter `userId: 'u1'`), which the SQL and in-process stores do not; identity fields are strings by convention.
See [INTEGRATION.md](../../docs/INTEGRATION.md#scan-filtered-delete-and-catalog-update).

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`GPL-3.0.txt`](GPL-3.0.txt) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).

## Listing RAG records

`InMemoryRag`, `VectorRag` and `QdrantRag` support optional `IRag.list(params?, options?)`.
Listing reads the store directly without embeddings or a cache, including expired
records. PostgreSQL and HANA support is planned for a later stage.

```typescript
if (rag.list) {
  let cursor: string | undefined;
  do {
    const result = await rag.list({ cursor, limit: 100, includeText: true });
    if (!result.ok) throw result.error;
    for (const record of result.value.records) console.log(record.id, record.text);
    cursor = result.value.cursor;
  } while (cursor !== undefined);
}
```

`limit` defaults to 100 and accepts integers from 1 to 1000. Text is omitted unless
`includeText` is true. Results contain detached finite JSON metadata and no scores
or vectors; unsupported stored metadata returns `RAG_INVALID_METADATA`. Filters use
strict string equality on `userId`, `sessionId` and `namespace`, intersected with
`CallOptions.ragFilter`. Conflicting constraints return an empty terminal page.
Cursors are opaque and bound to the backend, store and effective filter. Keep the
filter unchanged between pages; changing the limit or text projection is allowed.
Pages may be short or empty with a cursor; only its absence means completion.
Ordering is stable within an unchanged backend store, without snapshot isolation
across pages. Pass `CallOptions.signal` to cancel with an `ABORTED` result.
