# @mcp-abap-adt/hana-vector-rag

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

SAP HANA Cloud Vector Engine backend for [@mcp-abap-adt/llm-agent](https://www.npmjs.com/package/@mcp-abap-adt/llm-agent).

Provides:
- `HanaVectorRag` — `IRag` implementation backed by `REAL_VECTOR(dim)` columns.
- `HanaVectorRagProvider` — `IRagProvider` for session/user/global collections.

## Install

```bash
npm install @mcp-abap-adt/hana-vector-rag @sap/hana-client
```

## Minimal config

```yaml
# the address only; the login is a credential (required — HANA has no anonymous login)
rag:
  store:
    type: hana-vector
    connectionString: hdbsql://host:443
    collectionName: llm_agent_docs
    dimension: 1536
    autoCreateSchema: true
    credentialRef: RAG_HANA          # the llm-agent binary reads RAG_HANA_USER and RAG_HANA_PASSWORD
```

In code: `new HanaVectorRag({ connectionString: 'hdbsql://host:443', credential: staticLogin(user, password), … })`
— `credential` is **required**, and a bare-string `connection` is refused at construction.

See the monorepo root README for full configuration surface.

## Catalog and the rights it needs

`HanaVectorRagProvider` keeps one record per collection in a catalog table of its own
(`rag_collection_catalog` by default, `catalogTable` to rename it), in the configured schema or the
connection's current one. `createCollection` creates the collection's table and then writes its
record; `deleteCollection` deletes the record first, then drops the table; `describeCollections`
reads the catalog back. The database user the connection uses needs:

| with `autoCreateSchema` | rights |
|---|---|
| `true` (default) | `CREATE ANY` on the schema (the catalog table on first use, one table per collection); `SELECT`, `INSERT`, `DELETE` on the catalog; `DROP` on the collection tables (it owns those it created); `SELECT` on `SYS.TABLES` (granted to `PUBLIC` by default) |
| `false` | no creating DDL is issued: the operator creates the catalog with `createCatalogTableSql(table)` (exported) and each collection table. The user needs `SELECT`, `INSERT`, `DELETE` on the catalog, `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the collection tables, and `DROP` on them — the flag governs creation only, and `deleteCollection` still drops the table |

Without those rights `createCollection` fails where it used to succeed. A collection created before
this release has a table and no record: take it over once with
`createCollection(..., { adoptExisting: true })`.

## Shared table layout (HDI)

By default every collection is its own table, created at runtime (`layout: 'per-collection'`).
That cannot work in an **SAP HANA HDI container** (the standard `hana` / `hdi-shared` service on
BTP): tables there are created only at deploy time, by the HDI deployer, and the application runs
as the **runtime user**, which has DML rights but no DDL. For that case set `layout: 'shared'`: one
documents table holds every collection (a `COLLECTION` column tells them apart) and one catalog
table lists them. Both are deployed outside the app, and **no DDL statement ever reaches the
database at runtime** (`CREATE`, `DROP`, `TRUNCATE`, `ALTER`). The default stays `per-collection`;
without `layout` nothing changes.

```yaml
rag:
  store:
    type: hana-vector
    connectionString: hdbsql://host:443
    collectionName: llm_agent_docs   # the value of the COLLECTION column
    dimension: 1536                  # must equal the deployed REAL_VECTOR(n)
    layout: shared
    # documentsTable: RAG_DOCUMENTS  # default
    credentialRef: RAG_HANA
```

In code: `layout: 'shared'` and `documentsTable` on `HanaVectorRag` / `HanaVectorRagProvider`; the
provider also takes `catalogTable`. In `shared` the defaults are `RAG_DOCUMENTS` and
`RAG_COLLECTIONS` (exported as `SHARED_DOCUMENTS_TABLE`, `SHARED_CATALOG_TABLE`). Every shared
identifier is quoted and upper case (`"RAG_DOCUMENTS"`, columns `"COLLECTION"`, `"ID"`, `"TEXT"`,
`"VECTOR"`, `"METADATA"`, `"CREATED_AT"`; primary key `("COLLECTION", "ID")`). The tables are
resolved in the connection's current schema, which for an HDI runtime user is the container
schema. Table names follow the usual rule `[a-zA-Z_][a-zA-Z0-9_]{0,62}`; **HDI namespaces
(`.hdinamespace`, `a.b::NAME`) are not supported in this release** — deploy into a container
without a namespace.

`autoCreateSchema` is `false` by default in `shared`; setting it to `true` explicitly throws
`RagError` `INVALID_CONFIG` at construction.

The error codes are exported as constants — `SHARED_LAYOUT_NOT_DEPLOYED`, `INVALID_CONFIG`, `INVALID_VECTOR` — so a consumer can branch on `error.code === SHARED_LAYOUT_NOT_DEPLOYED` without a string literal. A `layout` other than `'per-collection'` or `'shared'` is `INVALID_CONFIG` at construction.

### Deploying the tables

The package ships `ddl/` (published with it):

- `RAG_DOCUMENTS.hdbtable`, `RAG_COLLECTIONS.hdbtable`, `.hdiconfig` — for the HDI deployer;
- `shared-layout.sql` — the same tables as plain SQL (catalog first), for a classic schema or
  manual use.

Copy the two `.hdbtable` files into the `src/` of your db module (next to your own artifacts) and **merge** the `hdbtable` plugin entry of the shipped `.hdiconfig` into the db module's existing `.hdiconfig` — do not copy it over your own file, which usually lists more plugins (create it from the shipped one only if the module has none). Then run
`@sap/hdi-deploy` with the container's **design-time user** (`hdi_user`); on Cloud Foundry that is
the deployer app bound to the HDI service instance. The application itself is bound to the same
instance and connects as the **runtime user** (`..._RT`), which only needs `SELECT`, `INSERT`,
`UPDATE`, `DELETE` on the two tables. A working example is in
`test/integration/sql-shared-table/` of the repository.

### The dimension rule

The shipped DDL is `REAL_VECTOR(1536)` (`SHIPPED_DIMENSION`). For an embedder with another
dimension, generate the files instead of using the shipped ones:

```ts
import {
  sharedCatalogHdbtable,
  sharedDocumentsHdbtable,
  sharedLayoutSql,
} from '@mcp-abap-adt/hana-vector-rag';

sharedDocumentsHdbtable('RAG_DOCUMENTS', 1024); // body of RAG_DOCUMENTS.hdbtable
sharedCatalogHdbtable('RAG_COLLECTIONS');       // body of RAG_COLLECTIONS.hdbtable
sharedLayoutSql({ dimension: 1024 });           // plain SQL (documentsTable, catalogTable optional)
```

On its first operation (lazily; a success is remembered, a failure is retried) a store or provider
checks that the tables exist and that the `"VECTOR"` column has exactly the configured
`dimension`. It reads the catalog views only; it never calls the embedder. A missing table or a
different dimension fails every operation with `RagError` `SHARED_LAYOUT_NOT_DEPLOYED`, naming the
table, the found and the expected dimension; a driver error during the check is
`HEALTH_CHECK_ERROR`. `healthCheck()` runs the same check. A direct store checks the documents
table only; the provider checks both.

Vectors are validated before any SQL: a non-finite component is refused in both layouts, a length
other than `dimension` only in `shared` (callers see `UPSERT_ERROR` / `QUERY_ERROR` whose message
names the lengths).

### Semantics

- A direct store reads and writes its `collectionName` as the `COLLECTION` value and needs no
  catalog row.
- A collection "exists" when its catalog record exists or the documents table holds rows for it.
  `listCollections` returns the union of both; `createCollection` for a name that has rows but no
  record returns `OrphanStoreError` unless `adoptExisting: true`, which writes the record and keeps
  the rows.
- `deleteCollection` deletes the collection's documents first, then its record (the per-collection
  layout deletes the record first); `clearAll` deletes only that collection's rows.
- **A handle is not tied to its collection.** In `shared`, a handle obtained before `deleteCollection` can still write: it only writes rows with its `COLLECTION` value, which no longer needs a record. Those rows become an orphan — listed by `listCollections`, and `createCollection` of that name returns `OrphanStoreError` until `adoptExisting: true` or the rows are removed. (In `per-collection` such a write fails, because the table is gone.) Consumers must drop the handles of a deleted collection.

## Connections, and `clientFactory` for per-session hydration

`openCollection` builds a collection's handles without a statement and without a connection; a
handle connects on its first query or write. Without `clientFactory`, each handle then opens a
connection of its own — one physical connection per collection handle, which nothing closes.
Per-session hydration opens every one of a caller's catalog records in every session, so a
deployment that hydrates per session should pass **`clientFactory` returning one shared client**:
every handle and the provider's own catalog work then run on that client.

```ts
const shared = await createHanaClient({ host, credential: staticLogin(user, password), collectionName: '_' });
new HanaVectorRagProvider({
  name: 'hana',
  embedder: symmetricEmbedder(myEmbedder), // writes with embedDocument, searches with embedQuery
  connection,
  clientFactory: () => shared,
});
```

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
