# @mcp-abap-adt/pg-vector-rag

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

PostgreSQL + pgvector backend for @mcp-abap-adt/llm-agent.

Provides:
- `PgVectorRag` — `IRag` implementation backed by `vector(dim)` columns (pgvector extension).
- `PgVectorRagProvider` — `IRagProvider` for session/user/global collections.

## Prerequisites

- PostgreSQL 13+
- `pgvector` extension installed (`CREATE EXTENSION IF NOT EXISTS vector;`)

## Install

```bash
npm install @mcp-abap-adt/pg-vector-rag pg
```

## Minimal config

```yaml
# the address only; the login is a credential
rag:
  store:
    type: pg-vector
    connectionString: postgres://host:5432/mydb
    collectionName: llm_agent_docs
    dimension: 1536
    autoCreateSchema: true
    credentialRef: RAG_PG          # the llm-agent binary reads RAG_PG_USER and RAG_PG_PASSWORD
```

In code: `new PgVectorRag({ connectionString: 'postgres://host:5432/mydb', credential: staticLogin(user, password), … })`
— a connection string carrying `user:pass` is refused at construction.

See the monorepo root README for full configuration surface.

## Catalog and the rights it needs

`PgVectorRagProvider` keeps one record per collection in a catalog table of its own
(`rag_collection_catalog` by default, `catalogTable` to rename it). `createCollection` creates the
collection's table and then writes its record; `deleteCollection` deletes the record first, then
drops the table; `describeCollections` reads the catalog back. The account the connection uses needs:

| with `autoCreateSchema` | rights |
|---|---|
| `true` (default) | `CREATE` on the schema (the catalog table on first use, one table per collection); `SELECT`, `INSERT`, `DELETE` on the catalog; ownership of the collection tables it creates (for `DROP TABLE`); the `vector` extension installed, or the right to create it |
| `false` | no creating DDL is issued: the operator creates the catalog with `createCatalogTableSql(table)` (exported) and each collection table. The account needs `SELECT`, `INSERT`, `DELETE` on the catalog, read and write on the collection tables, and ownership of them — the flag governs creation only, and `deleteCollection` still drops the table |

Without those rights `createCollection` fails where it used to succeed. A collection created before
this release has a table and no record: take it over once with
`createCollection(..., { adoptExisting: true })`.

## Shared table layout

By default every collection is its own table, created at runtime (`layout: 'per-collection'`). For
deployments where the application account has no DDL rights, set `layout: 'shared'`: one documents
table holds every collection (a `collection` column tells them apart) and one catalog table lists
them. Both are created outside the app, and **no DDL statement ever reaches the database at
runtime** (`CREATE`, `DROP`, `TRUNCATE`, `ALTER`, `IF NOT EXISTS`). The default stays
`per-collection`; without `layout` nothing changes.

```yaml
rag:
  store:
    type: pg-vector
    connectionString: postgres://host:5432/mydb
    collectionName: llm_agent_docs   # the value of the "collection" column
    dimension: 1536                  # must equal the deployed vector(n)
    layout: shared
    # documentsTable: rag_documents  # default
    credentialRef: RAG_PG
```

In code: `layout: 'shared'` and `documentsTable` on `PgVectorRag` / `PgVectorRagProvider`; the
provider also takes `catalogTable`. In `shared` the defaults are `rag_documents` and
`rag_collections` (exported as `SHARED_DOCUMENTS_TABLE`, `SHARED_CATALOG_TABLE`). Every shared
identifier is quoted and lower case (columns `"collection"`, `"id"`, `"text"`, `"vector"`,
`"metadata"`, `"created_at"`; primary key `("collection", "id")`). When the connection sets
`schema`, every shared statement and the startup check qualify the tables with it. Table names
follow the usual rule `[a-zA-Z_][a-zA-Z0-9_]{0,62}`; HDI namespaces do not apply to Postgres.

`autoCreateSchema` is `false` by default in `shared`; setting it to `true` explicitly throws
`RagError` `INVALID_CONFIG` at construction. The `vector` extension is then yours to install.

The error codes are exported as constants — `SHARED_LAYOUT_NOT_DEPLOYED`, `INVALID_CONFIG`, `INVALID_VECTOR` — so a consumer can branch on `error.code === SHARED_LAYOUT_NOT_DEPLOYED` without a string literal. A `layout` other than `'per-collection'` or `'shared'` is `INVALID_CONFIG` at construction.

### Deploying the tables

The package ships `ddl/shared-layout.sql` (published with it): `CREATE EXTENSION IF NOT EXISTS
vector`, the catalog table, then the documents table, with the default names. Run it once as a
privileged account (`psql -f node_modules/@mcp-abap-adt/pg-vector-rag/ddl/shared-layout.sql`); the
application account then needs only `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the two tables.

### The dimension rule

The shipped DDL is `vector(1536)` (`SHIPPED_DIMENSION`). For an embedder with another dimension,
generate the script:

```ts
import { sharedLayoutSql } from '@mcp-abap-adt/pg-vector-rag';

sharedLayoutSql({ dimension: 1024 }); // documentsTable, catalogTable are optional
```

`sharedLayoutSql` has no `schema` option and its statements are unqualified. To deploy into a schema
set by the connection's `schema`, run the script with that schema first on the `search_path`
(`SET search_path TO myschema;` before the script) or qualify the table names by hand.

On its first operation (lazily; a success is remembered, a failure is retried) a store or provider
checks that the tables exist and that the `vector` column has exactly the configured `dimension`.
It never calls the embedder. A missing table or a different dimension fails every operation with
`RagError` `SHARED_LAYOUT_NOT_DEPLOYED`, naming the table, the found and the expected dimension; a
driver error during the check is `HEALTH_CHECK_ERROR`. `healthCheck()` runs the same check. A direct
store checks the documents table only; the provider checks both.

Vectors are validated before any SQL: a non-finite component is refused in both layouts, a length
other than `dimension` only in `shared` (callers see `UPSERT_ERROR` / `QUERY_ERROR` whose message
names the lengths).

### Semantics

- A direct store reads and writes its `collectionName` as the `collection` value and needs no
  catalog row.
- A collection "exists" when its catalog record exists or the documents table holds rows for it.
  `listCollections` returns the union of both; `createCollection` for a name that has rows but no
  record returns `OrphanStoreError` unless `adoptExisting: true`, which writes the record and keeps
  the rows.
- `deleteCollection` deletes the collection's documents first, then its record (the per-collection
  layout deletes the record first); `clearAll` deletes only that collection's rows.
- **A handle is not tied to its collection.** In `shared`, a handle obtained before `deleteCollection` can still write: it only writes rows with its `collection` value, which no longer needs a record. Those rows become an orphan — listed by `listCollections`, and `createCollection` of that name returns `OrphanStoreError` until `adoptExisting: true` or the rows are removed. (In `per-collection` such a write fails, because the table is gone.) Consumers must drop the handles of a deleted collection.

## Scan, filtered delete and catalog update

The store implements `IRagScanner` and `IRagFilteredDeleter`, and the provider implements `IRagCatalogUpdater` (guards `isRagScanner`, `isRagFilteredDeleter`, `isRagCatalogUpdater` from `@mcp-abap-adt/llm-agent`). The library wrappers (`OverlayRag`, `SessionScopedRag`, ...) do not forward them; use the provider's handle.

- `scan({ filter?, pageSize?, cursor? })` returns `{ records, cursor? }`: `id`, `text`, `metadata`, never a vector, expired records included. `filter` is strict string equality on `userId`, `sessionId`, `namespace`. `pageSize` is a positive integer (default `DEFAULT_SCAN_PAGE_SIZE`, 500), otherwise `INVALID_ARGUMENT`. **Only a missing `cursor` ends the scan**: a page may be short or empty while a cursor is still returned. `id` is `metadata.id` when the record has one, otherwise the `id` column; the round trip into `getById` / `deleteById` is guaranteed only for records written with an id.
- `deleteWhere(filter)` deletes the matching records of this collection only and returns `{ deleted }`. An empty filter is `INVALID_ARGUMENT`. It is exact against a snapshot, not atomic: one `DELETE ... RETURNING` with the strict predicates, and the count is the rows it returned. A matching record inserted while it runs may survive; repeat the call if you need to.
- An aborted `signal` gives `ABORTED` (`Aborted after deleting N record(s)` once a delete has started).
- `updateCollection(storeName, { collectionName?, attributes? })` is one `UPDATE` of the catalog row by `store_name`. `attributes` replaces the stored attributes as a whole; `storeName`, `scope` and the owner never change. A missing record is `RAG_COLLECTION_NOT_FOUND`, an empty patch `INVALID_ARGUMENT`, an attribute value that cannot be stored `RAG_INVALID_ATTRIBUTES`.
In `shared` layout both run the startup check first and return its failure unchanged (`SHARED_LAYOUT_NOT_DEPLOYED` / `HEALTH_CHECK_ERROR`); no DDL runs, and `deleteWhere` stays inside its own `collection` value.
The scan cursor is a key-set cursor on the primary key, stable under concurrent inserts. `scan` and `deleteWhere` are strict on JSON strings, while per-collection `query` keeps its existing `->>` semantics, so the two can differ there.
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
