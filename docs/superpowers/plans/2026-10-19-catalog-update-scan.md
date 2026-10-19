# Catalog Update, Store Scan and Filtered Delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three focused interfaces, `IRagCatalogUpdater`, `IRagScanner` and `IRagFilteredDeleter`, implemented on the SQL, Qdrant and in-process stores and providers, with identical semantics pinned by a conformance kit.

**Architecture:**
- The new interfaces and type guards live in `@mcp-abap-adt/llm-agent` and leave the existing interfaces untouched.
- Each store implements `scan` and `deleteWhere` in a small module of its own package, reusing that package's store-SQL strategy where one exists.
- Each provider implements `updateCollection` with one catalog write.
- A kit in `@mcp-abap-adt/llm-agent/testing/scan-delete-conformance` runs against the storing fakes and against live backends.

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 22, `node:test` via tsx, Biome, `@sap/hana-client`, `pg`, the Qdrant REST API.

**Spec:** `docs/superpowers/specs/2026-10-19-catalog-update-scan-design.md`. Read §2, §5 and §6, including the "settled by the author" rulings.

## Global Constraints

- No existing interface or exported type changes; additions only. Every existing test passes unchanged.
- Existing operations keep their SQL byte-for-byte in both layouts. New statements are added alongside them.
- No DDL in the `shared` layout. In `shared`, `scan` and `deleteWhere` run the memoised startup check first, and a failure is returned unchanged (`SHARED_LAYOUT_NOT_DEPLOYED` / `HEALTH_CHECK_ERROR`).
- Filters for `scan` and `deleteWhere` use strict string equality on `userId`, `sessionId` and `namespace`, in every backend and layout. A store-configured namespace (`InMemoryRag`, `VectorRag`) bounds both.
- `scan` includes expired records, never returns vectors, and never skips a record. Pages may be short or empty. Only a missing `cursor` ends a scan. The order is stable, with a key-set cursor on the primary key. The default `pageSize` is 500.
- `deleteWhere` refuses an empty filter (`INVALID_ARGUMENT`). It is exact against a snapshot: it selects the matching keys, deletes them, and returns `{ deleted }`. It never deletes outside its collection.
- `updateCollection` refuses an empty patch (`INVALID_ARGUMENT`). A missing record gives `RAG_COLLECTION_NOT_FOUND`. `attributes` replaces the stored attributes. `storeName`, `scope` and the owner never change.
- Error codes are exported as constants from `@mcp-abap-adt/llm-agent`: `RAG_COLLECTION_NOT_FOUND`, `INVALID_ARGUMENT`.
- Windows: run npm scripts with `npm_config_script_shell="C:/Program Files/Git/bin/bash.exe"`, or the test glob matches nothing.
- Every commit is signed with the YubiKey. Never pass `--no-gpg-sign`. Never push from a task.
- HANA can be reached only from CF. A live HANA run pushes a temporary app into `cloud-llm-hub-dev`/`llm-agent` and needs the user's go-ahead first.

## Review Focus

1. **Concurrent insert during a paged `scan`.** No record that existed when the scan started is skipped or repeated; a new record may or may not appear. Test in Task 3 (kit).
2. **`deleteWhere({ userId })` in a `shared` table holding the same `userId` in another collection.** The other collection is untouched. Test in Task 3 (kit) and Tasks 4/5.
3. **Numeric identity value (`userId: 123`) against the filter `'123'`.** No match in `scan` or `deleteWhere`, on every backend. Test in Task 3 (kit).
4. **A record without `metadata.id` (raw write).** `scan` returns it with the backend key and does not skip it. Test in Tasks 2, 4, 5 and 6.
5. **`updateCollection` on a record that another instance deleted.** Returns `RAG_COLLECTION_NOT_FOUND`, and writes no new record. Test in Task 7.

---

### Task 1: Interfaces, guards, error codes (`@mcp-abap-adt/llm-agent`)

**Files:**
- Create: `packages/llm-agent/src/interfaces/rag-scan.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`, `packages/llm-agent/src/index.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/rag-scan.test.ts` (or the package's existing test location), plus `__typechecks__` if the package has them

**Produces:**
```ts
export interface RagScanFilter { userId?: string; sessionId?: string; namespace?: string }
export interface RagScanRecord { id: string; text: string; metadata: RagMetadata }
export interface RagScanPage { records: RagScanRecord[]; cursor?: string }
export interface IRagScanner {
  scan(opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string }, options?: CallOptions): Promise<Result<RagScanPage, RagError>>;
}
export interface IRagFilteredDeleter {
  deleteWhere(filter: RagScanFilter, options?: CallOptions): Promise<Result<{ deleted: number }, RagError>>;
}
export interface RagCatalogPatch { collectionName?: string; attributes?: Record<string, unknown> }
export interface IRagCatalogUpdater {
  updateCollection(storeName: string, patch: RagCatalogPatch): Promise<Result<void, RagError>>;
}
export function isRagScanner(x: unknown): x is IRagScanner;
export function isRagFilteredDeleter(x: unknown): x is IRagFilteredDeleter;
export function isRagCatalogUpdater(x: unknown): x is IRagCatalogUpdater;
export const RAG_COLLECTION_NOT_FOUND = 'RAG_COLLECTION_NOT_FOUND';
export const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
export const DEFAULT_SCAN_PAGE_SIZE = 500;
export function matchesScanFilter(metadata: RagMetadata, filter: RagScanFilter | undefined): boolean; // strict string equality on each set field
export function assertNonEmptyFilter(filter: RagScanFilter): Result<void, RagError>;
```
If `INVALID_ARGUMENT` already exists as a code in the package, reuse it.

- [ ] **Step 1:** Write tests:
  - each guard is true for an object with the method and false otherwise;
  - `matchesScanFilter({ userId: 123 }, { userId: '123' })` is false;
  - `matchesScanFilter({ userId: 'a' }, { userId: 'a' })` is true;
  - an unset filter matches all;
  - `assertNonEmptyFilter({})` gives `INVALID_ARGUMENT`.
- [ ] **Step 2:** Run the tests and see them fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and see them pass. Run build and typecheck.
- [ ] **Step 5: Commit** `feat(llm-agent): IRagScanner, IRagFilteredDeleter, IRagCatalogUpdater`

### Task 2: In-process stores — `InMemoryRag`, `VectorRag`

**Files:** Modify `packages/llm-agent/src/rag/in-memory-rag.ts` and `vector-rag.ts` (put the logic in a small helper module if it grows). Tests sit next to the existing tests of these stores.

**Consumes:** Task 1.

- [ ] **Step 1:** Write tests:
  - paged `scan` with `pageSize: 2` over 5 records returns all 5 exactly once, in a stable order, and the last page has no cursor;
  - the filter applies;
  - a configured namespace bounds `scan` and `deleteWhere`;
  - an id-less record is returned with its insertion key;
  - `deleteWhere` returns the exact count and removes only the matches;
  - an empty filter is refused;
  - expired records are included in `scan`;
  - a raw-written record is not skipped.
- [ ] **Step 2:** Run the tests and see them fail.
- [ ] **Step 3:** Implement.
  - Give `InMemoryRag` a monotonically increasing insertion key for a stable cursor; the existing `splice` behaviour of its other operations stays.
  - The cursor is the last key seen, encoded opaquely.
- [ ] **Step 4:** Run the tests and see them pass. Run the full llm-agent suite.
- [ ] **Step 5: Commit** `feat(llm-agent): scan and deleteWhere for InMemoryRag and VectorRag`

### Task 3: Conformance kit `scan-delete-conformance`

**Files:**
- Create: `packages/llm-agent/src/testing/scan-delete-conformance.ts`
- Modify: the `package.json` exports, beside the other two kits, and `src/testing/index.ts` if it exists
- Create runner tests for `InMemoryRag` and `VectorRag` in llm-agent

**Produces:**
```ts
export interface ScanDeleteSubject {
  store(): Promise<IRag & IRagScanner & IRagFilteredDeleter>;
  sibling?(): Promise<IRag & IRagScanner & IRagFilteredDeleter>; // another collection on the same backend storage (shared layout); absent → the sibling case is skipped
  catalog?(): Promise<{ provider: IRagProvider & IRagCatalogUpdater; create(name: string): Promise<void> }>;
}
export const scanDeleteConformanceCases: ReadonlyArray<{ name: string; run(s: () => Promise<ScanDeleteSubject>): Promise<void> }>;
```

Cases, with exact names:
- `scan pages cover every record exactly once`
- `scan applies the filter with strict string equality` (Review Focus 3)
- `scan includes expired records`
- `scan under a concurrent insert neither skips nor repeats` (Review Focus 1)
- `deleteWhere removes exactly the matches and counts them`
- `deleteWhere refuses an empty filter`
- `deleteWhere stays inside its collection` (Review Focus 2; uses `sibling`)
- `scan ids round-trip through getById and deleteById`
- `updateCollection replaces attributes and keeps the owner` (uses `catalog`)
- `updateCollection on a missing record is RAG_COLLECTION_NOT_FOUND` (uses `catalog`; Review Focus 5)
- `updateCollection refuses an empty patch` (uses `catalog`)

Cases whose seam is absent are skipped and reported as skipped, not passed.

- [ ] **Step 1:** Write the kit and the two runners.
- [ ] **Step 2:** Run. Expect every applicable case to pass on both in-process stores. A failure is a store defect: fix it in Task 2's code.
- [ ] **Step 3: Commit** `test(llm-agent): scan/delete/catalog-update conformance kit`

### Task 4: HANA — `scan`, `deleteWhere` (both layouts)

**Files:**
- Create: `packages/hana-vector-rag/src/scan-delete.ts`, holding the SQL in `store-sql.ts` as new strategy members: `scanPage(afterKey?: string, limit: number): SqlStatement` and `deleteByIds(ids: string[]): SqlStatement`
- Modify: `hana-vector-rag.ts`, which delegates to it
- Tests: `src/__tests__/scan-delete.test.ts`; extend `storing-hana.ts`; add a kit runner

**Consumes:** Task 1 and Task 3.

SQL:
- shared: `SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM <docs> WHERE "COLLECTION" = ? [AND "ID" > ?] ORDER BY "ID" LIMIT n`;
- per-collection: the same without the collection predicate.

Filtering is client-side with `matchesScanFilter`. `deleteWhere` scans everything (internal loop), collects the matching ids, then sends `DELETE … WHERE "COLLECTION" = ? AND "ID" IN (?, …)` in batches of at most 1000.

- [ ] **Step 1:** Write tests:
  - the SQL text for both layouts;
  - paging over the storing fake;
  - the shared check runs first and its error is returned unchanged;
  - no DDL across the lifecycle (the regex from 30.2.0 tests);
  - an id-less record cannot occur in SQL, because `ID` is the primary key, so assert that id comes from the `ID` column.
- [ ] **Step 2:** Run the tests and see them fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and see them pass. Run the kit on the storing fake in `shared`, with a sibling, and in per-collection.
- [ ] **Step 5: Commit** `feat(hana-vector-rag): scan and deleteWhere`

### Task 5: PG — `scan`, `deleteWhere` (both layouts)

This mirrors Task 4, in `packages/pg-vector-rag`. The differences:
- the filter is in SQL, with the strict predicates from PR #334 (`CASE WHEN jsonb_typeof(...) = 'string' THEN ... END = $n`), in **both** layouts for these new statements only;
- the key-set cursor is `ORDER BY "id"` / `id`;
- `deleteWhere` is one `DELETE … WHERE <collection and filter> RETURNING "id"`, with the count taken from the returned rows;
- shared names are schema-qualified through `qualifiedTable`.

Extend `storing-pg.ts`, where unknown shapes still throw, and add a kit runner. The commit is `feat(pg-vector-rag): scan and deleteWhere`.

### Task 6: Qdrant — `scan`, `deleteWhere`

**Files:** `packages/qdrant-rag/src/scan-delete.ts`, with `qdrant-rag.ts` delegating to it. Tests use the package's existing fetch-mocking pattern, and the kit runs against a small storing fake of the scroll/delete REST API.

- `scan`: `POST /collections/{c}/points/scroll { filter, limit, offset, with_payload: true, with_vector: false }`.
  - The filter matches `userId`/`sessionId`/`namespace` payload keys with `match.value` on strings, which is strict, so a number does not match a string.
  - `cursor` is `next_page_offset`.
  - `id` is `payload.id` when present, else the point id.
- `deleteWhere`: scroll the matches (internal loop), then `POST /collections/{c}/points/delete?wait=true { points: [...] }` in batches, and return the count.
- Commit: `feat(qdrant-rag): scan and deleteWhere`

### Task 7: Providers — `updateCollection`

**Files:** `hana-vector-rag-provider.ts` (both layouts, through `catalog-record.ts`), `pg-vector-rag-provider.ts`, `qdrant-rag-provider.ts`, and the SQL in each package's `catalog.ts` (`updateRecordSql(table)`). Tests sit next to the existing provider tests, plus the kit's catalog cases on each storing fake.

- SQL: `UPDATE <catalog> SET collection_name = COALESCE(?, collection_name), attributes_json = COALESCE(?, attributes_json) WHERE store_name = ?`. Zero rows updated means `RAG_COLLECTION_NOT_FOUND`. PG uses `$n` and the schema qualification of the shared layout.
- Qdrant: read the catalog point by its store name. If it is absent, return `RAG_COLLECTION_NOT_FOUND`. Otherwise `POST /points/payload?wait=true` (set payload) for `name` and `attributes`, and never create a point.
- Attributes are encoded with the same `encodeRagAttributes` the create path uses.
- Commit: `feat(*-rag): updateCollection on the catalog providers`

### Task 8: Live checks

**Files:**
- PG: extend `test/integration/sql-shared-table/pg/run.mjs` (or a sibling `run-scan.mjs` called by the same npm script) to also run `scanDeleteConformanceCases` in both layouts.
- HANA: extend `test/integration/sql-shared-table/hana/runner/run.mjs` the same way.
- Qdrant: a gated runner under `test/integration/`, run only when `QDRANT_TEST_URL` is set.

- [ ] **Step 1:** PGlite: `npm run test:integration:sql-shared:pg` prints `CONFORMANCE PASS n/n` for both kits.
- [ ] **Step 2: HANA, controller only, after the user's go-ahead.**
  - Build, then run `node hana/runner/pack.mjs`.
  - `cf push` the runner. The tables are already deployed, so the deployer is not needed.
  - Read `SST` logs and expect a pass for both kits.
  - Delete the app, and verify `cf apps` is empty and `hdi-llm` is unbound.
- [ ] **Step 3:** Qdrant is skipped unless a URL is available; record which.
- [ ] **Step 4: Commit** `test(integration): scan/delete/catalog-update live checks`

### Task 9: Docs and changelogs

- Store and provider READMEs (hana, pg, qdrant): the three interfaces, the semantics from §6, and the snapshot rule of `deleteWhere`. Also `docs/INTEGRATION.md`.
- CHANGELOG `Unreleased` entries, Added, in llm-agent, hana-vector-rag, pg-vector-rag, qdrant-rag and the root changelog.
- Run `npm run lint:check` and `node scripts/check-example-configs.mjs`.
- Commit: `docs: scan, deleteWhere and updateCollection`

The release (bump to 30.3.0, removing this plan and the spec, the PR, merge and publish) is not part of this plan.
