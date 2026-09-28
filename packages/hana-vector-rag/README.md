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
