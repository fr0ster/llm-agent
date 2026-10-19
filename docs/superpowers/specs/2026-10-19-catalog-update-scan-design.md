# Catalog update, store scan and filtered delete

Status: design, for review. Target release: **30.3.0**, branched from `main` (30.2.0).

## 1. Intent

cloud-llm-hub is making its RAG collections persistent: its "Plan B", now on SAP HANA (HDI, `shared` layout), Postgres or Qdrant. The hub keeps its own collection registry, with the documents of each collection mirrored in memory for listing, counters and export. Each collection maps to a store opened through an `IRagProvider` with a catalog.

The provider API cannot carry three things the hub needs, and none of them belongs in the hub (principle 1):

1. **Update a catalog record.** The hub renames a collection, edits its description and enables or disables it. All of these live in the record's `collectionName` and `attributes`. `IRagProvider` can create, delete, describe and open, but it cannot update. This was already a stated prerequisite of the hub's Plan B in its 2026-09-29 spec.
2. **Read every record of a store.** At startup the hub rebuilds each collection's document list from the store. `IRag` offers `query` (top-k by similarity) and `getById`, but no way to enumerate.
3. **Delete by owner.** The hub's persistent session history must forget one user's or session's turns, and cap them at N per owner. Today it tracks its own ids in process memory, and those are lost on restart.

## 2. Goals

1. **Three new focused interfaces** in `@mcp-abap-adt/llm-agent` (principle 4). No existing interface grows. Each comes with a type guard.
   - `IRagCatalogUpdater`, implemented by providers with a catalog:
     `updateCollection(storeName: string, patch: { collectionName?: string; attributes?: Record<string, unknown> }): Promise<Result<void, RagError>>`
     - `attributes` **replaces** the record's attributes as a whole: the caller reads them through `describeCollections`, changes them and writes them back.
     - `collectionName` changes the display name only. `storeName`, `scope` and the owner never change.
     - A missing record fails with `RagError` code `RAG_COLLECTION_NOT_FOUND`.
     - An empty patch is refused with `INVALID_ARGUMENT`.
   - `IRagScanner`, implemented by stores:
     `scan(opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string }, options?: CallOptions): Promise<Result<{ records: RagScanRecord[]; cursor?: string }, RagError>>`
     - `RagScanRecord = { id: string; text: string; metadata: RagMetadata }`. There is no vector.
     - `RagScanFilter = { userId?: string; sessionId?: string; namespace?: string }`, with the same semantics as the query identity and namespace filters: strict string equality.
     - Expired records (`metadata.ttl` in the past) are **included**, because a scan reads what is stored.
     - The order is stable within one scan and pages never overlap.
     - `cursor` is opaque. Its absence on a result means the scan is finished.
     - `pageSize` defaults to 500, and its maximum is the backend's own limit.
   - `IRagFilteredDeleter`, implemented by stores:
     `deleteWhere(filter: RagScanFilter, options?: CallOptions): Promise<Result<{ deleted: number }, RagError>>`
     - The filter must carry at least one field. An empty filter is refused with `INVALID_ARGUMENT`; `clearAll` already exists for that.
     - In the `shared` SQL layout it deletes only within its own collection.
2. **Implementations:**
   - `HanaVectorRagProvider`, `PgVectorRagProvider` and `QdrantRagProvider` implement `IRagCatalogUpdater`.
   - `HanaVectorRag` and `PgVectorRag` (both layouts), `QdrantRag`, `VectorRag` and `InMemoryRag` implement `IRagScanner` and `IRagFilteredDeleter`.
   - In the SQL `shared` layout everything stays DML: no DDL.
3. **Same semantics on every backend,** pinned by a new conformance kit, `@mcp-abap-adt/llm-agent/testing/scan-delete-conformance`, which also covers the catalog update. It runs against the storing fakes of every implementation and against live databases:
   - HANA in BTP;
   - PGlite;
   - Qdrant when a URL is set.
4. **Additive release 30.3.0.** No existing behaviour changes.

## 3. Non-goals

- Vectors in scan results.
- Server-side ordering by `created_at` or "trim oldest" as one call. The hub trims by scanning one owner, at most a few hundred records, and calling `deleteById` on the oldest. A dedicated method can be added later if the data grows.
- Scanning across collections.
- Access policy.
- A new catalog column. Roles and other hub metadata stay in `attributes`.
- Changes for `feat/collection-profiles` (#322).

## 4. Anti-goals

- Changing `IRag`, `IRagProvider` or any other existing interface.
- A scan that silently skips records or repeats them across pages.
- `deleteWhere` deleting outside its own collection or owner.
- Any DDL in the `shared` layout.

## 5. Constraints

- The Architecture Principles in `CLAUDE.md` are binding.
- The conventions and constraints of 30.2.0 still hold:
  - quoted identifiers in the shared layout;
  - the same table-name rule;
  - `SHARED_LAYOUT_NOT_DEPLOYED` from the startup check, which also runs before `scan` and `deleteWhere`;
  - the per-collection SQL for existing operations is unchanged.
- The cursor must be stable under concurrent inserts. A key-set cursor on the primary key satisfies this: on SQL that is `(collection, id)` / `id`; on Qdrant the scroll offset.
- HANA cannot be reached from the developer machine. It is verified live with a temporary CF app bound to `hdi-llm`, as in 30.2.0, after asking the user.

## 6. Decided parts of the how

- Filter semantics come from `matchesRagIdentity` / `ragIdentityFilter`, and from the shared PG predicates that match JSON strings only (fixed in PR #334).
- Qdrant:
  - `scan` uses `POST /collections/{c}/points/scroll` with a payload filter and `offset` as the cursor;
  - `deleteWhere` scrolls with a filter, then deletes by point ids with `wait=true` (see below);
  - `updateCollection` rewrites the catalog point's payload.
- SQL providers: `updateCollection` is one `UPDATE` of the catalog row by `store_name`. `rowCount = 0` means `RAG_COLLECTION_NOT_FOUND`.

The following were settled by the author after the builder check (author's call):

- **`deleteWhere` is exact against a snapshot, not atomic.**
  - It deletes the matching records that exist when it starts, and returns exactly how many it deleted.
  - A matching record inserted while it runs may survive. This is documented; the caller repeats the call if it needs to.
  - Every backend implements it as "select the matching keys, then delete those keys":
    - Qdrant: scroll with a filter, then delete the point ids. This replaces the filter-delete route from §6, because that route returns no count.
    - HANA: SELECT, filter in the client with the strict rules, then delete by ids. No `JSON_VALUE`, which would match `123` and `'123'` alike.
    - PG: one `DELETE … RETURNING` with the strict predicates.
- **Filter rules for `scan` and `deleteWhere` are strict string equality on every backend and in both layouts.**
  - These are new methods, so being strict changes no existing behaviour. PG per-collection `query` keeps its current `->>` semantics, and the difference is documented.
  - A store configured with a namespace (`InMemoryRag`, `VectorRag`) only scans and deletes inside that namespace, the same boundary its `query` applies. Neither method ever reaches outside the store.
- **Pages may be short or empty while a cursor is still returned.** Only a missing cursor ends a scan. The hub's paging loop relies on exactly this rule.
- **Wrappers are out of scope.** The interfaces are implemented on the five raw stores and the three providers. The library wrappers (`OverlayRag`, `SessionScopedRag`, `ActiveFilteringRag`, the editor) do not forward them in 30.3.0, and the guards return `false` for them. The hub reaches the raw stores through provider handles and `RagStoreFactory.create`.
- **Ids.**
  - `scan` returns `id` = the record's `metadata.id` when it has one. Otherwise it returns the backend's own key: the SQL `ID` column, the Qdrant point id, or an insertion sequence for `InMemoryRag`. The record is never skipped.
  - The `scan` → `getById`/`deleteById` round trip is guaranteed only for records written with an id. Every provider and editor write has one. The conformance kit pins that case.
  - `InMemoryRag` gets a monotonically increasing insertion key, so it has a stable cursor.

## 7. Left to the builder

- Module split and the names of the guard helpers.
- The page-size limits per backend.
- Docs and CHANGELOG entries (Unreleased).
