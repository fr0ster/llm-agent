# @mcp-abap-adt/hana-vector-rag

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
rag:
  type: hana-vector
  connectionString: hdbsql://user:pass@host:443
  collectionName: llm_agent_docs
  dimension: 1536
  autoCreateSchema: true
```

See the monorepo root README for full configuration surface.
