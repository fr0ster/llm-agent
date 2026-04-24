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
