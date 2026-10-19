# Shared-table layout for the SQL vector stores (`hana-vector-rag`, `pg-vector-rag`)

Status: design, for review. Target release: **30.2.0**, branched from `main` (30.1.0).

## 1. Intent

Today both SQL stores keep **one table per collection**. The table is created
with `CREATE TABLE` when a collection is created and dropped with `DROP TABLE`
when it is deleted. So the database user the application runs as must be allowed
to run DDL at runtime.

On SAP BTP the standard HANA container is an **HDI container** (`hana` /
`hdi-shared`). There, tables are created only at deploy time, by the HDI
deployer from `.hdbtable` artifacts. The runtime user is DML-only. This was
verified on 2026-10-19 against SAP HANA Cloud 4.00 (`hdi-llm` container), from
an app bound to the container:

- runtime user `…_RT` privileges on its schema: `SELECT, INSERT, UPDATE, DELETE,
  EXECUTE, CREATE TEMPORARY TABLE`; no system privileges;
- so `HanaVectorRag` with `autoCreateSchema` and `HanaVectorRagProvider.createCollection`
  cannot work in an HDI container.

The same probe found a defect that makes `HanaVectorRag` return empty results on
a real HANA, whatever the layout:

- HANA folds unquoted identifiers to upper case, so
  `SELECT id, text, metadata, … AS score` returns rows keyed `ID`, `TEXT`,
  `METADATA`, `SCORE` (verified). `HanaVectorRag` reads `row.id`, `row.text`,
  `row.metadata`, `row.score`, so each result has an empty text, empty metadata,
  score 0 and id `"undefined"`. Quoted aliases (`AS "id"`) come back as written
  (verified). The catalog queries already quote their aliases. The store queries
  do not.
- The test double (`__tests__/fake-hana.ts`) returns whatever keys it is given,
  so the unit tests cannot see this.

The consumer driving this is **cloud-llm-hub**. It will select `hana-vector`,
`pg-vector` or `qdrant` by configuration for its three store classes: tools,
session and persistent collections. It has shared (admin-managed), per-user and
per-session collections, and role-based access later. The hub enforces access
itself, because it holds the user's identity. The library only has to store and
return the facts the hub needs.

## 2. Goals

1. **The table layout is a strategy the consumer picks** (principle 5). There
   are two layouts:
   - `per-collection`: today's behaviour, and the **default**. Nothing changes
     for current consumers (principle 7).
   - `shared`: one **documents table** for all collections, with a `collection`
     column, plus the existing **catalog table**. Both are created outside the
     application.
2. **No DDL at runtime in the `shared` layout.** Not `CREATE TABLE`, not
   `IF NOT EXISTS`, not `DROP` or `TRUNCATE`:
   - creating a collection inserts a catalog row;
   - deleting a collection deletes its documents, then its catalog row;
   - `clearAll` deletes the collection's documents;
   - the store and the provider never issue DDL, whatever `autoCreateSchema` says.
     In this layout `autoCreateSchema: true` is a configuration error, reported
     at construction.
3. **The package ships the DDL for the `shared` layout,** for the consumer to
   deploy:
   - HANA: `.hdbtable` artifacts for the HDI deployer, plus plain SQL for a
     classic schema (`hana` / `schema`) or for manual use;
   - Postgres: a plain SQL script, which includes `CREATE EXTENSION IF NOT EXISTS vector`;
   - each is also exported as a function, generated from the table names and the
     dimension, so a consumer can generate rather than copy;
   - the shipped files are generated from those same functions, and a test pins
     that they match.
4. **Fix the HANA column case** in every store query, in both layouts: quoted
   aliases, lower-case keys in the rows. A regression test asserts on the SQL
   text, so it cannot depend on the fake's key handling.
5. **HANA and Postgres behave the same** in the `shared` layout:
   - same tables and columns, modulo types;
   - same semantics for ids, upsert, identity filter, namespace filter, ttl and
     scores;
   - one shared contract test suite runs against both fakes, and against live
     databases when the integration env vars are set.
6. **Startup check in the `shared` layout.** The provider or store checks that
   both tables exist and that the vector column's dimension equals the
   configured `dimension` (see §6). If not, it fails with a clear `RagError` naming the table and the
   DDL to deploy, instead of failing on the first query. The check is reported
   through the existing `healthCheck`.
7. **Release 30.2.0.** It is additive: new config fields, a new layout, new
   exports. The HANA case fix ships as a fix in the same release.

## 3. Non-goals

- **Enforcing access.** Who may read or write a collection (shared/admin, user,
  roles) is the consumer's policy. The catalog already stores `scope`, `userId`,
  `sessionId` and `attributes` (JSON). A consumer keeps roles in `attributes`.
  No new column for roles in 30.2.0 (decided: the library records facts; the
  consumer decides). See open issue #304 for the library-side isolation work. It
  is not part of this change.
- **Searching several collections in one query.** It is possible later
  (`WHERE collection IN (…)`), but `IRag` is per collection. Not in 30.2.0.
- **An ANN index** (HANA HNSW, pgvector `ivfflat`/`hnsw`). Exact scan, as today.
- **Migrating existing per-collection tables** into the shared table.
- **Qdrant.** No change.
- **The `feat/collection-profiles` work (#322).** It is not merged, and this
  change must not depend on it. Its diff does not touch `hana-vector-rag` or
  `pg-vector-rag` (checked). Whichever lands second rebases.

## 4. Anti-goals

These would make it a failure even if it works:

- any change in behaviour for a consumer that does not opt in to `shared`;
- any DDL statement reaching the database in the `shared` layout;
- a breaking change to `IRag`, `IRagProvider` or the existing config types (they
  are extended, not changed);
- a new god-file: the layout logic goes in small focused modules (principle 6).

## 5. Constraints

- The repository's Architecture Principles (`CLAUDE.md`, `docs/ARCHITECTURE.md`)
  are binding. The layout is a strategy. Small focused interfaces, additive only.
- ESM, Biome, strict TypeScript, Node ≥ 22, tests on the built-in runner.
- HANA: `REAL_VECTOR(<dim>)` fixes the dimension per column, so the shared table
  has one dimension. That is acceptable, because a deployment has one embedder,
  and changing the embedder is a redeploy for the consumer.
- HDI: table names in `.hdbtable` must match the object names. Table names are
  **configurable**, with defaults, and validated with the existing identifier
  rule. See §6 for namespaces.
- The `shared` documents table needs a composite key `(collection, id)`. A
  document id is unique within a collection, not globally, as today.
- The identity, namespace and ttl filters keep their current semantics. In the
  `shared` layout the collection filter **must** be in SQL
  (`WHERE "COLLECTION" = ?`). Postgres already does the other filters in SQL.
  For HANA, moving them into SQL (`JSON_VALUE`) is allowed but not required;
  the requirement is the semantics, checked live.

## 6. Decided parts of the how

- Layout is selected in the store/provider config, e.g. `layout: 'per-collection' | 'shared'`
  (exact shape left to the builder), default `per-collection`.
- Shared documents table, logical columns: `collection`, `id`, `text`, `vector`,
  `metadata` (JSON in `NCLOB` / `JSONB`), `created_at`; primary key `(collection, id)`.
  The catalog table keeps its current columns.

The following were settled by the author after the builder check (author's call;
the consumer may revisit):

- **Names and case.** Every identifier in the shared layout, in the shipped DDL
  and in every query, is **quoted**, in the backend's native case:
  - HANA: upper case: `"RAG_DOCUMENTS"`, `"RAG_COLLECTIONS"`, `"COLLECTION"`,
    `"ID"`, `"TEXT"`, `"VECTOR"`, `"METADATA"`, `"CREATED_AT"`;
  - Postgres: lower case: `"rag_documents"`, `"rag_collections"`, and lower-case
    columns.

  These are the shared layout's own defaults. The per-collection layout keeps
  its current names (`rag_collection_catalog` and so on) unchanged. Table names
  are configurable. **HDI namespaces (`.hdinamespace`, `a.b::NAME`) are not
  supported in 30.2.0**: the identifier rule stays as it is, and a consumer
  deploys into a container without a namespace. Supporting them later means
  widening the rule for table names only, which is additive.
- **Dimension check.** It compares against the **configured** `dimension`. It
  never embeds a sample: no AI call and no credential at startup. It runs
  lazily on the first operation of a store or provider, and the result is
  memoised. A failure is not memoised, so the next call retries, like
  `client()`.
  - When it fails, every operation returns that `RagError`. It names the table,
    the found and expected dimension, and the DDL to deploy.
  - `healthCheck` runs the same check.
  - No change to `IRagProvider` or any `llm-agent` interface.
- **Direct stores are in scope.** `HanaVectorRag` / `PgVectorRag` accept
  `layout: 'shared'` and the table names, and so does `makeRag`'s config in
  `llm-agent-rag` (with its `__typechecks__`), so a YAML-configured server can
  use it.
  - A direct store writes and reads its `collectionName` as the `collection`
    value.
  - It needs no catalog row, and its startup check covers the documents table
    only.
  - The provider's check covers both tables.
- **Orphans and listing** keep today's meaning, translated to the shared layout.
  A collection "physically exists" when the documents table holds rows for it.
  - `createCollection` for a name that has rows but no catalog record returns
    `OrphanStoreError` unless `adoptExisting` is set. With `adoptExisting` it
    records the catalog row and keeps the rows, as today.
  - `listCollections` returns the union of the catalog names and the distinct
    `collection` values in the documents table: everything that physically
    exists, as today's table listing does.
  - `deleteCollection` deletes the documents first, then the record, as stated
    in goal 2.
  - The contract suite pins all of this identically for both backends.
- Live verification is part of done:
  - HANA: the container is the existing `hdi-llm` (CF org
    `cloud-llm-hub-dev`, space `llm-agent`; it holds no tables today).
    - Its service key carries both users. The **design-time `hdi_user`**
      deploys the shipped `.hdbtable` with `@sap/hdi-deploy`. The **runtime
      `user` (`…_RT`)** runs the shared contract suite.
    - The HANA Cloud instance does not accept connections from the developer
      machine (`Socket closed by peer`, seen 2026-10-19), so the deployer and
      the integration suite both run **inside BTP**: a temporary CF app or task
      bound to `hdi-llm`, which is removed afterwards.
    - The suite reads its connection from `VCAP_SERVICES` there, or from env
      vars named by the builder.
  - Postgres: run the suite against a local pgvector.

## 7. Left to the builder

- Interface names and module split for the layout strategy.
- Exact SQL, and whether HANA JSON filters move into SQL.
- How the shipped DDL files are laid out in the package (`ddl/hana/*.hdbtable`,
  `ddl/hana/*.sql`, `ddl/pg/*.sql` is a suggestion) and exported (`files` in
  `package.json`).
- Docs: package READMEs, `docs/` pages that mention these stores, CHANGELOG.
