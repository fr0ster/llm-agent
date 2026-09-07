# @mcp-abap-adt/pg-vector-rag

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
rag:
  type: pg-vector
  connectionString: postgres://user:pass@host:5432/mydb
  collectionName: llm_agent_docs
  dimension: 1536
  autoCreateSchema: true
```

See the monorepo root README for full configuration surface.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`COPYING`](COPYING) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
