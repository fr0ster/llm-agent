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
