# SQL Shared-Table Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `hana-vector-rag` and `pg-vector-rag` gain an opt-in `shared` table layout. It uses one documents table plus a catalog, and no DDL at runtime, so both run in an HDI container. The HANA upper-case column defect is fixed in every layout.

**Architecture:**
- Each package gets a small store-SQL strategy (`per-collection` | `shared`). `HanaVectorRag` / `PgVectorRag` build their statements through it instead of inline SQL.
- The providers branch on the same layout: catalog rows instead of `CREATE`/`DROP TABLE`.
- Each package ships generated DDL for the shared layout. A lazy, memoised check verifies the tables and the vector dimension.
- One conformance kit in `@mcp-abap-adt/llm-agent/testing` pins identical semantics for both backends, against storing fakes and against live databases.

**Tech Stack:**
- TypeScript (strict, ESM), Node ≥ 22, `node:test` via tsx, Biome;
- `@sap/hana-client`, `pg`, `@sap/hdi-deploy` (live check only).

**Spec:** `docs/superpowers/specs/2026-10-19-sql-shared-table-layout-design.md` (read it first; §6 holds the decided details).

## Global Constraints

- Default layout is `per-collection`. With no `layout` set, every emitted SQL statement is byte-identical to 30.1.0, **except** the HANA case fix of Task 1.
- `shared` layout: no DDL statement ever reaches the client (`CREATE`, `DROP`, `TRUNCATE`, `ALTER`, `IF NOT EXISTS`). An explicit `autoCreateSchema: true` together with `layout: 'shared'` throws `RagError(code 'INVALID_CONFIG')` at construction. An unset `autoCreateSchema` means `false` in `shared`.
- Shared identifiers are always quoted. HANA: `"RAG_DOCUMENTS"`, `"RAG_COLLECTIONS"`, with columns `"COLLECTION"`, `"ID"`, `"TEXT"`, `"VECTOR"`, `"METADATA"`, `"CREATED_AT"`. Postgres: `"rag_documents"`, `"rag_collections"`, with the same columns in lower case.
- Shared documents primary key: `(collection, id)`. `collection` is `NVARCHAR(63)` (HANA) / `VARCHAR(63)` (PG). The other column types are as in today's `createTableSql`.
- The catalog's columns are unchanged (today's `createCatalogTableSql` body). Only the default table name differs in `shared`.
- The table-name rule stays `/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`. No HDI namespaces.
- The dimension check compares against the configured `dimension` (store) / `connection.dimension ?? defaultDimension` (provider). It never calls the embedder. It is lazy, success is memoised, and failure is not memoised.
- No change to any interface in `packages/llm-agent/src/interfaces/`. New exports only.
- Files stay small: each new module has one responsibility. Do not grow `hana-vector-rag.ts` or `*-provider.ts` with layout branches. They delegate.
- Code, comments and commits are in English. Conventional Commits. Each commit is signed (the repo's YubiKey GPG). Never pass `--no-gpg-sign`. If a commit waits, it is pinentry waiting for the PIN.
- Per task gate: `npm run build && npm run typecheck && npm run lint:check && npm test --workspace <touched packages>`.

## Review Focus

1. **HANA hands NCLOB columns back as `Buffer`.** Text and metadata must come back as strings and parsed JSON, in both layouts. Test in Task 1.
2. **Embedder returns a vector whose length differs from the configured dimension.** Expected: `RagError('UPSERT_ERROR')` / `('QUERY_ERROR')` whose message names both lengths, raised before any SQL is sent. Tests in Tasks 3 and 5.
3. **Non-finite vector components (`NaN`, `Infinity`).** Expected: the same refusal before SQL, never a malformed literal. Tests in Tasks 3 and 5.
4. **Same document id in two collections of the shared table.** They are independent rows: upsert, get, delete and clear in one never touch the other. This is a conformance case in Task 7.
5. **A collection whose rows outlive their catalog record** (delete raced, or a direct store wrote first). `createCollection` returns `OrphanStoreError` without `adoptExisting`, and adopts with it. `listCollections` still lists it. Tests in Tasks 4 and 6, and a conformance case in Task 7.

---

### Task 1: HANA column case fix (both layouts' foundation)

**Files:**
- Modify: `packages/hana-vector-rag/src/hana-vector-rag.ts` (`query`, `getById`, `withId`)
- Test: `packages/hana-vector-rag/src/__tests__/hana-vector-rag.test.ts`

**Interfaces:**
- Produces: `decodeLob(v: unknown): string` (exported from new `packages/hana-vector-rag/src/lob.ts`). Task 4 reuses it for the catalog's `attributesJson`, replacing the local `Buffer.isBuffer` check there.

- [ ] **Step 1: Write the failing tests**
  - `it('search SELECT quotes every alias')`: run `query` on a fake that records SQL. Assert that the statement contains `AS "id"`, `AS "text"`, `AS "metadata"`, `AS "score"` and `ORDER BY "score" DESC`, and contains no `AS score`.
  - `it('getById SELECT quotes every alias')`: the same for `AS "id"`, `AS "text"`, `AS "metadata"`.
  - `it('NCLOB values that arrive as Buffer are decoded')`: the fake returns `{ id: 'a', text: Buffer.from('hello'), metadata: Buffer.from('{"k":1}'), score: 0.9 }`. Expect `text === 'hello'`, `metadata.k === 1`, `metadata.id === 'a'`.
- [ ] **Step 2: Run, and confirm the first two fail on the alias assertions.** `npm test --workspace @mcp-abap-adt/hana-vector-rag`
- [ ] **Step 3: Implement.** Use quoted lower-case aliases in both SELECTs. Add `src/lob.ts` with `decodeLob`: a Buffer becomes utf8, `null`/`undefined` becomes `''`, otherwise `String(v)`. Apply it to `text` and `metadata` in `withId` and in result mapping.
- [ ] **Step 4: Run the package tests.** Expected: PASS, and the existing tests are still green.
- [ ] **Step 5: Commit** `fix(hana-vector-rag): quote result aliases — HANA folds them to upper case; decode NCLOB buffers`

### Task 2: Shared-layout DDL generators and shipped files (both packages)

**Files:**
- Create: `packages/hana-vector-rag/src/shared-ddl.ts`, `packages/pg-vector-rag/src/shared-ddl.ts`
- Create: `packages/hana-vector-rag/ddl/RAG_DOCUMENTS.hdbtable`, `ddl/RAG_COLLECTIONS.hdbtable`, `ddl/.hdiconfig`, `ddl/shared-layout.sql`
- Create: `packages/pg-vector-rag/ddl/shared-layout.sql`
- Create: `packages/hana-vector-rag/scripts/write-ddl.ts`, `packages/pg-vector-rag/scripts/write-ddl.ts` (run with `tsx`, wired as `npm run ddl` in each package)
- Modify: both `package.json` (`"files"` gains `"ddl"`, script `"ddl"`), both `src/index.ts`
- Test: `src/__tests__/shared-ddl.test.ts` in each package

**Interfaces:**
- Produces, HANA (`shared-ddl.ts`):
  - `SHARED_DOCUMENTS_TABLE = 'RAG_DOCUMENTS'`, `SHARED_CATALOG_TABLE = 'RAG_COLLECTIONS'`, `SHIPPED_DIMENSION = 1536`
  - `sharedDocumentsHdbtable(table: string, dimension: number): string`
  - `sharedCatalogHdbtable(table: string): string`
  - `sharedLayoutSql(opts: { documentsTable?: string; catalogTable?: string; dimension: number }): string`
- Produces, PG (`shared-ddl.ts`):
  - `SHARED_DOCUMENTS_TABLE = 'rag_documents'`, `SHARED_CATALOG_TABLE = 'rag_collections'`, `SHIPPED_DIMENSION = 1536`
  - `sharedLayoutSql(opts: { documentsTable?: string; catalogTable?: string; dimension: number }): string`

- [ ] **Step 1: Write the failing tests**
  - `sharedDocumentsHdbtable('RAG_DOCUMENTS', 1536)` equals exactly:
    ```
    COLUMN TABLE "RAG_DOCUMENTS" (
      "COLLECTION" NVARCHAR(63) NOT NULL,
      "ID" NVARCHAR(255) NOT NULL,
      "TEXT" NCLOB,
      "VECTOR" REAL_VECTOR(1536),
      "METADATA" NCLOB,
      "CREATED_AT" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("COLLECTION", "ID")
    )
    ```
  - `sharedCatalogHdbtable('RAG_COLLECTIONS')` is `COLUMN TABLE "RAG_COLLECTIONS" (` followed by the column list of today's `createCatalogTableSql`.
  - HANA `sharedLayoutSql({ dimension: 1536 })` is both statements prefixed `CREATE `, separated by `;\n`, catalog first.
  - PG `sharedLayoutSql({ dimension: 1536 })` contains, in order:
    - `CREATE EXTENSION IF NOT EXISTS vector`;
    - the catalog table `"rag_collections"`;
    - `CREATE TABLE "rag_documents"` with `"collection" VARCHAR(63) NOT NULL`, `"id" VARCHAR(255) NOT NULL`, `"text" TEXT`, `"vector" vector(1536)`, `"metadata" JSONB`, `"created_at" TIMESTAMPTZ DEFAULT NOW()`, and `PRIMARY KEY ("collection", "id")`.
  - An invalid name (`'a-b'`) throws `INVALID_COLLECTION_NAME`.
  - `it('shipped ddl files match the generators')`: read every file under `ddl/` (except `.hdiconfig`) and compare it to the generator output at `SHIPPED_DIMENSION` and the default names.
  - `.hdiconfig` parses as JSON and maps `hdbtable` to `com.sap.hana.di.table`.
- [ ] **Step 2: Run, and confirm they fail** (the module is missing).
- [ ] **Step 3: Implement the generators.** Then run `npm run ddl` in each package to write the files. The script imports the generators and writes the files with a trailing newline.
- [ ] **Step 4: Run the package tests.** Expected: PASS. Also check that `npm pack --dry-run --workspace @mcp-abap-adt/hana-vector-rag` lists `ddl/RAG_DOCUMENTS.hdbtable`.
- [ ] **Step 5: Commit** `feat(hana-vector-rag,pg-vector-rag): shipped DDL for the shared table layout`

### Task 3: HANA store — layout strategy, shared SQL, startup check

**Files:**
- Create: `packages/hana-vector-rag/src/store-sql.ts` (strategy + both implementations)
- Create: `packages/hana-vector-rag/src/shared-check.ts`
- Create: `packages/hana-vector-rag/src/vector-literal.ts` (validated literal)
- Modify: `packages/hana-vector-rag/src/connection.ts` (`HanaVectorRagConfig` gains `layout?: 'per-collection' | 'shared'` and `documentsTable?: string`)
- Modify: `packages/hana-vector-rag/src/hana-vector-rag.ts` (it delegates all SQL to the strategy, and in `shared` awaits the check before every operation)
- Test: `src/__tests__/store-sql.test.ts`, `src/__tests__/shared-check.test.ts`, additions to `hana-vector-rag.test.ts`

**Interfaces:**
- Produces (`store-sql.ts`):
  ```ts
  export type SqlStatement = { sql: string; params: unknown[] };
  export interface HanaStoreSql {
    readonly layout: 'per-collection' | 'shared';
    createTable(): string | undefined;          // undefined in shared
    search(vectorLiteral: string, limit?: number): SqlStatement;
    byId(id: string): SqlStatement;
    upsert(vectorLiteral: string, id: string, text: string, metadataJson: string): SqlStatement;
    deleteById(id: string): SqlStatement;
    clear(): SqlStatement;                      // TRUNCATE per-collection; DELETE … WHERE "COLLECTION" = ? shared
    countRows(): SqlStatement;                  // SELECT COUNT(*) AS "n" … (shared: WHERE "COLLECTION" = ?)
  }
  export function perCollectionStoreSql(collection: string, dimension: number): HanaStoreSql;
  export function sharedStoreSql(collection: string, documentsTable: string): HanaStoreSql;
  ```
  The per-collection SQL is today's, plus the Task 1 aliases. Shared statements put `collection` as the first parameter.
- Produces (`shared-check.ts`):
  - `checkSharedTables(client: HanaClient, opts: { schema?: string; tables: string[]; documentsTable: string; dimension: number }): Promise<Result<void, RagError>>`
  - error code `'SHARED_LAYOUT_NOT_DEPLOYED'`. The message names the missing table or the found and expected dimension, and points to `ddl/` / `sharedLayoutSql`.
  - Dimension query: `SELECT LENGTH AS "dim" FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = <schema|CURRENT_SCHEMA> AND TABLE_NAME = ? AND COLUMN_NAME = 'VECTOR'`. This is **unverified on live HANA**. Task 9 confirms it. If HANA reports the dimension elsewhere, fix it there and note it in the commit.
- Produces (`vector-literal.ts`): `hanaVectorLiteral(vec: readonly number[], dimension: number): string`. It throws `RagError('INVALID_VECTOR')` naming both lengths, or the first non-finite index.

- [ ] **Step 1: Write the failing tests**
  - Shared `search` emits `SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata", COSINE_SIMILARITY("VECTOR", <lit>) AS "score" FROM "RAG_DOCUMENTS" WHERE "COLLECTION" = ? ORDER BY "score" DESC`, with `params[0] === 'docs'`. With a limit it appends ` LIMIT <n>`.
  - Shared `upsert` emits `UPSERT "RAG_DOCUMENTS" ("COLLECTION", "ID", "TEXT", "VECTOR", "METADATA") VALUES (?, ?, ?, <lit>, ?) WITH PRIMARY KEY`.
  - Shared `clear` is a `DELETE`, never a `TRUNCATE`. `createTable()` is `undefined`.
  - `it('per-collection SQL is unchanged except the aliases')`: snapshot-compare every statement against the 30.1.0 SQL text with only the alias change.
  - `it('shared store sends no DDL')`: run a full store lifecycle (upsert, query, getById, writer delete, clearAll, healthCheck) on a recording fake. Assert that no recorded statement matches `/^\s*(CREATE|DROP|TRUNCATE|ALTER)\b/i`.
  - `it('layout shared + autoCreateSchema true throws at construction')` → `INVALID_CONFIG`.
  - `checkSharedTables`: a missing table → `SHARED_LAYOUT_NOT_DEPLOYED` naming it; dim 768 vs 1536 → the message contains `768` and `1536`; success is memoised (one SQL round on two calls); failure is not memoised (the fake fails then succeeds, and the second call passes).
  - `it('a vector of the wrong length is refused before SQL')` (Review Focus 2) and `it('a non-finite component is refused before SQL')` (Review Focus 3). In both, the fake records zero statements and the result is `!ok`.
- [ ] **Step 2: Run, and confirm they fail.**
- [ ] **Step 3: Implement.**
  - `HanaVectorRag` picks the strategy in its constructor from `config.layout`.
  - In `shared` it awaits a memoised `checkSharedTables(..., tables: [documentsTable])` before each operation and in `healthCheck`.
  - Identity, namespace and ttl filtering stay client-side as today, now over rows already filtered by `"COLLECTION"`. Moving them into SQL is optional (spec §5). If you do it, the conformance kit of Task 7 must still pass.
- [ ] **Step 4: Run the package tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(hana-vector-rag): shared table layout for HanaVectorRag`

### Task 4: HANA provider — shared layout

**Files:**
- Create: `packages/hana-vector-rag/src/shared-provider-ops.ts` (create, delete, list in shared; the provider delegates)
- Modify: `packages/hana-vector-rag/src/hana-vector-rag-provider.ts`:
  - config gains `layout?` and `documentsTable?`;
  - `catalogTable` defaults to `SHARED_CATALOG_TABLE` in shared;
  - `handles()` passes `layout`/`documentsTable` to `HanaVectorRag`;
  - `decodeRow` uses `decodeLob`.
- Test: `src/__tests__/hana-vector-rag-provider-shared.test.ts`

**Interfaces:**
- Consumes: `sharedStoreSql`, `checkSharedTables` (Task 3); `SHARED_*` (Task 2); `decodeLob` (Task 1).
- Produces: `HanaVectorRagProviderConfig.layout?: 'per-collection' | 'shared'`, `.documentsTable?: string`.

- [ ] **Step 1: Write the failing tests** (recording fake, shared layout)
  - Every public method first runs `checkSharedTables` with `tables: [catalogTable, documentsTable]`. A missing catalog makes `createCollection` return `SHARED_LAYOUT_NOT_DEPLOYED`.
  - `createCollection('kb', …)` sends `INSERT INTO "RAG_COLLECTIONS" …` and no DDL. A second create gives `DuplicateCollectionError`.
  - Orphan (Review Focus 5): the fake reports `COUNT(*) = 3` rows for `kb` and no record.
    - Without `adoptExisting` → `OrphanStoreError`.
    - With it → the record is inserted and no `DELETE` is sent.
  - `deleteCollection('kb')` sends `DELETE FROM "RAG_DOCUMENTS" WHERE "COLLECTION" = ?` **before** `DELETE FROM "RAG_COLLECTIONS" WHERE store_name = ?`. If the documents delete fails, the result is `RAG_DELETE_ERROR` and the record is kept.
  - `listCollections()` returns the sorted union of the catalog `store_name`s and `SELECT DISTINCT "COLLECTION" AS "c" FROM "RAG_DOCUMENTS"`, without duplicates.
  - The whole-lifecycle no-DDL assertion, as in Task 3.
  - The per-collection provider tests are untouched and green.
- [ ] **Step 2: Run, and confirm they fail.**
- [ ] **Step 3: Implement.** The provider branches once per method on `this.layout` into `shared-provider-ops.ts`.
- [ ] **Step 4: Run the package tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(hana-vector-rag): shared table layout for HanaVectorRagProvider`

### Task 5: PG store — layout strategy, shared SQL, startup check

Mirror of Task 3 for `packages/pg-vector-rag`.

**Files:**
- Create: `src/store-sql.ts`, `src/shared-check.ts`, `src/vector-literal.ts`
- Modify: `src/connection.ts`, `src/pg-vector-rag.ts`
- Tests: the same three test files as Task 3

**Interfaces:**
- Produces: `PgStoreSql` with the same members as `HanaStoreSql`, using `$n` placeholders. The shared WHERE begins `"collection" = $1`, and the existing jsonb conditions follow with renumbered placeholders.
- Produces: `perCollectionStoreSql`, `sharedStoreSql`, `checkSharedTables` (same signature, `PgClient`), `pgVectorLiteral(vec, dimension)`.
- Shared upsert: `INSERT INTO "rag_documents" ("collection", "id", "text", "vector", "metadata") VALUES ($1, $2, $3, <lit>, $4::jsonb) ON CONFLICT ("collection", "id") DO UPDATE SET "text" = EXCLUDED."text", "vector" = EXCLUDED."vector", "metadata" = EXCLUDED."metadata"`.
- Dimension query: `SELECT a.atttypmod AS "dim" FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attname = 'vector' AND NOT a.attisdropped`. `$1` is the schema-qualified, quoted table name. Existence: `to_regclass($1) IS NOT NULL`.

- [ ] **Step 1: Write the failing tests.** The same cases as Task 3, with PG SQL text. Extend `storing-pg.ts` to understand the `"collection" = $1` condition and the shared statements. Unknown shapes still throw.
- [ ] **Step 2: Run, and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, and `rag-filter-conformance.test.ts` is still green for per-collection.
- [ ] **Step 5: Commit** `feat(pg-vector-rag): shared table layout for PgVectorRag`

### Task 6: PG provider — shared layout

Mirror of Task 4 for `packages/pg-vector-rag` (`src/shared-provider-ops.ts`, `pg-vector-rag-provider.ts`, `src/__tests__/pg-vector-rag-provider-shared.test.ts`). It has the same cases with PG SQL and the same commit shape: `feat(pg-vector-rag): shared table layout for PgVectorRagProvider`.

### Task 7: Shared-table conformance kit, run against both storing fakes

**Files:**
- Create: `packages/llm-agent/src/testing/shared-table-conformance.ts`
- Modify: `packages/llm-agent/package.json` (export `./testing/shared-table-conformance`, alongside `./testing/rag-filter-conformance`)
- Create: `packages/hana-vector-rag/src/__tests__/storing-hana.ts` (evaluates the shared statements the way HANA does: upper-case unquoted names, cosine order, `LIMIT`; it throws on unknown SQL)
- Create: `packages/hana-vector-rag/src/__tests__/shared-conformance.test.ts`, `packages/pg-vector-rag/src/__tests__/shared-conformance.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SharedTableSubject {
    openStore(collection: string): Promise<IRag>;          // a direct store, shared layout, one backing table
    provider(): Promise<IRagProvider>;                     // a provider over the same backing tables
    rawInsert(collection: string, id: string, text: string): Promise<void>; // orphan setup, bypassing the provider
  }
  export const sharedTableConformanceCases: ReadonlyArray<{ name: string; run(s: () => Promise<SharedTableSubject>): Promise<void> }>;
  ```
  Reuse `conformanceEmbedder` / `CONFORMANCE_EMBEDDING_DIM` from `rag-filter-conformance`.
- Cases (exact names):
  - `same id in two collections is independent` (Review Focus 4);
  - `clearAll empties only its collection`;
  - `query returns only its collection's rows, best first`;
  - `identity, namespace and ttl filters hold within a collection`, re-running the existing `ragFilterConformanceCases` on `openStore('docs')`;
  - `orphan rows: refused without adoptExisting, adopted with it, listed either way` (Review Focus 5);
  - `delete removes rows then record`;
  - `list is the union of records and row collections`.

- [ ] **Step 1: Write the kit and the two runner tests.**
- [ ] **Step 2: Run both packages.** Expected: every case passes on both fakes. A failure here is a semantic difference between the backends: fix the store, not the case.
- [ ] **Step 3: Commit** `test: shared-table conformance kit, run on HANA and PG fakes`

### Task 8: `makeRag` and YAML config reach the shared layout

**Files:**
- Modify: `packages/llm-agent-rag/src/rag-factories.ts` (the `pg-vector` and `hana-vector` arms of `RagResolution` gain `layout?: 'per-collection' | 'shared'` and `documentsTable?: string`, passed through; doc comment updated)
- Modify: `packages/llm-agent-rag/src/__typechecks__/rag-resolution.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/rag-config.ts`, `config-validator.ts` (the allowed-keys list near `'autoCreateSchema'`, and `layout` validated against the two values), `resolve-config-sections.ts`
- Test: the existing factory tests in `llm-agent-rag/src/__tests__/`, and `config-validator` / `resolve-config-sections` tests in server-libs

- [ ] **Step 1: Write the failing tests**
  - `makeRag({ type: 'hana-vector', …, layout: 'shared' })` builds a store whose first query sends `… FROM "RAG_DOCUMENTS" WHERE "COLLECTION" = ?`, using the injected client seam the factory tests already use.
  - The YAML `rag.store: { type: pg-vector, layout: shared, documentsTable: kb_docs }` resolves to `layout: 'shared', documentsTable: 'kb_docs'`.
  - `layout: other` → a validator error listing `per-collection, shared`.
  - Typecheck: `layout: 'other'` is `@ts-expect-error`.
- [ ] **Step 2: Run, and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm run build && npm run typecheck && npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(llm-agent-rag,server-libs): layout and documentsTable for SQL stores`

### Task 9: Live HANA verification in BTP (`hdi-llm`)

**Files:**
- Create: `test/integration/sql-shared-table/hana/deployer/` (`package.json` with `@sap/hdi-deploy`, `src/` = the package's shipped `ddl/` incl. `.hdiconfig`, `manifest.yml`: no route, `services: [hdi-llm]`, command `node node_modules/@sap/hdi-deploy/deploy.js`)
- Create: `test/integration/sql-shared-table/hana/runner/` (`package.json` depending on the packed tarballs of `llm-agent`, `hana-vector-rag`; `run.mjs` reads `VCAP_SERVICES.hana[0].credentials` — the **runtime** `user`/`password`, never `hdi_user` — and runs `sharedTableConformanceCases` plus the Task 3 dimension check; it prints `CONFORMANCE PASS n/n` or the failures; `manifest.yml`, no route)
- Create: `test/integration/sql-shared-table/README.md` (how to run; the cleanup commands)

**Precondition:** this pushes two temporary apps into CF org `cloud-llm-hub-dev`, space `llm-agent`. **Ask the user before the first push.** Delete both apps afterwards (`cf delete <app> -f`, retrying while an unbind is in progress), and confirm `cf apps` is empty and `hdi-llm` has no bound apps.

- [ ] **Step 1:** `npm run build`, then `npm pack` the two packages into the runner folder.
- [ ] **Step 2:** Push the deployer and wait until the logs show `Deployment to container … done`. Check via the runner, or a one-off query, that `RAG_DOCUMENTS` and `RAG_COLLECTIONS` now exist.
- [ ] **Step 3:** Push the runner and read `cf logs <runner> --recent`. Expected: `CONFORMANCE PASS`, and the dimension check reports 1536. If `SYS.TABLE_COLUMNS.LENGTH` is not the dimension, fix `checkSharedTables` (Task 3), re-run the package tests, and commit `fix(hana-vector-rag): …`.
- [ ] **Step 4:** Delete both apps and verify the cleanup. The tables stay: they are the hub's future tables. Then clean the test rows: the runner's last case deletes the collections it created.
- [ ] **Step 5: Commit** `test(integration): live shared-table check on HANA HDI`

### Task 10: Live Postgres verification

**Files:**
- Create: `test/integration/sql-shared-table/pg/run.mjs`. It reads `PG_TEST_URL`, applies `sharedLayoutSql({ dimension: CONFORMANCE_EMBEDDING_DIM })` in a fresh schema, runs `sharedTableConformanceCases`, and drops the schema.
- Modify: root `package.json` with the script `"test:integration:sql-shared:pg": "node test/integration/sql-shared-table/pg/run.mjs"`

**Precondition:** a Postgres with pgvector. The user has **not** yet decided where it runs: WSL on this machine was proposed. Ask before installing anything.

- [ ] **Step 1:** Write `run.mjs`.
- [ ] **Step 2:** Run `PG_TEST_URL=… npm run test:integration:sql-shared:pg`. Expected: `CONFORMANCE PASS n/n`.
- [ ] **Step 3: Commit** `test(integration): live shared-table check on pgvector`

### Task 11: Docs and changelogs

**Files:**
- Modify: `packages/hana-vector-rag/README.md`, `packages/pg-vector-rag/README.md`. Each gets a section "Shared table layout (HDI)": when to use it, the config, deploying `ddl/`, the dimension rule, and no HDI namespaces.
- Modify: `docs/` pages that describe these stores. Find them with `git grep -l "hana-vector\|pg-vector" docs`.
- Modify: the `Unreleased` sections of `packages/hana-vector-rag/CHANGELOG.md`, `packages/pg-vector-rag/CHANGELOG.md`, `packages/llm-agent/CHANGELOG.md` (the kit), `packages/llm-agent-rag/CHANGELOG.md`, `packages/llm-agent-server-libs/CHANGELOG.md`, and root `CHANGELOG.md`. The HANA alias fix is listed under **Fixed**.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run `npm run lint:check && node scripts/check-example-configs.mjs`. Expected: clean.
- [ ] **Step 3: Commit** `docs: shared table layout for the SQL vector stores`

The release (`npm run bump` to 30.2.0, removing this plan and its spec, publishing) is **not** part of this plan. It needs the user's go-ahead after the PR is reviewed.
