# v11.0.0 Completion — HANA + pgvector RAG packages

**Date:** 2026-04-24
**Target release:** v11.0.0 (extends the already-merged but not-yet-published v11 refactor)
**Status:** Draft → In Review
**Builds on:** PR #114 (provider/backend extraction) already on `main`

## Motivation

PR #114 merged into `main` at version `11.0.0` but has not been published to npm yet. Before tagging and publishing, add two more RAG backend packages so consumers get a single v11.0.0 migration instead of drip-feeding 11.1/11.2. Both packages complete the coverage of RAG backends that deployments routinely need:

- **HANA Cloud Vector Engine** — the SAP BTP CF native option. Without this package, consumers running on BTP have only Qdrant-in-Kyma as a sanctioned option.
- **PostgreSQL + pgvector** — the industry-standard self-hosted option. Commonly paired with existing Postgres OLTP deployments.

Both are net-new code (no extraction — these classes don't exist in the repo). `InMemoryRag` and `VectorRag` stay in core: lightweight, no deps, useful for PoC and for storing MCP tool descriptions in the default agent.

## Scope

### New packages (2)

- **`@mcp-abap-adt/hana-vector-rag`** — `HanaVectorRag` + `HanaVectorRagProvider`. Runtime dep: `@sap/hana-client` (official SAP driver).
- **`@mcp-abap-adt/pg-vector-rag`** — `PgVectorRag` + `PgVectorRagProvider`. Runtime deps: `pg` (most-used Postgres driver). Optional pgvector helper is NOT required — we issue SQL directly.

Both implement `IRag` from core and produce editors paired with `IRagBackendWriter`. Both expose a Provider implementing `IRagProvider` with `supportedScopes: ['session', 'user', 'global']`.

### What stays unchanged

- `InMemoryRag`, `VectorRag`, their providers, `SimpleRagRegistry`, `SimpleRagProviderRegistry`, all other RAG infrastructure in core.
- `QdrantRag` in its extracted package.
- Server's factory registry (just gains two more entries).
- Server's optional peer deps list gains two more packages.

### Version + release

- All 12 packages ship at 11.0.0 (10 from PR #114 + 2 new).
- Single `npx changeset publish` after this PR merges.
- Single `v11.0.0` git tag.

## Resolved questions

| # | Question | Decision |
|---|---|---|
| 1 | Package naming | `hana-vector-rag` + `pg-vector-rag` (symmetric with `qdrant-rag`) |
| 2 | HANA driver | `@sap/hana-client` (official, production-ready) |
| 3 | Postgres driver | `pg` (ecosystem default) |
| 4 | Schema management | Hybrid — `autoCreateSchema: boolean` config flag. Default `true`. |
| 5 | Connection shape | Accept both URL string (`postgres://…`, HANA equivalent) AND config object. Internal resolve. |
| 6 | `supportedScopes` | `['session', 'user', 'global']` for both |
| 7 | Auto-schema DDL location | Inside the provider's `createCollection` method when `autoCreateSchema: true`. Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE EXTENSION IF NOT EXISTS vector`). |
| 8 | Distance metric | Cosine similarity (default; matches Qdrant's default and SmartAgent's RAG query shape). |
| 9 | Vector dimension | Fixed per collection, supplied via config. Default 1536 (OpenAI text-embedding-3-small). Consumer overrides per collection. |

## Shared architecture (both packages)

### Public surface

Each package exports:

```ts
export class HanaVectorRag implements IRag { /* ... */ }
export class HanaVectorRagProvider extends AbstractRagProvider { /* ... */ }
export interface HanaVectorRagConfig { /* connection + schema + dimension */ }
export interface HanaVectorRagProviderConfig { /* same plus provider metadata */ }
```

(Analogous names for `PgVector*`.)

### `IRag` method mapping

| IRag method | HANA SQL | Postgres SQL |
|---|---|---|
| `query(embedding, k, options)` | `SELECT ... ORDER BY COSINE_SIMILARITY(vec, ?) DESC LIMIT ?` | `SELECT ... ORDER BY vec <=> ? LIMIT ?` (pgvector) |
| `getById(id, options)` | `SELECT ... WHERE id = ?` | same |
| `healthCheck(options)` | `SELECT 1 FROM DUMMY` | `SELECT 1` |
| `writer().upsertRaw(id, text, meta, options)` | `UPSERT INTO ... VALUES (...)` | `INSERT ... ON CONFLICT (id) DO UPDATE SET ...` |
| `writer().deleteByIdRaw(id, options)` | `DELETE FROM ... WHERE id = ?` | same |
| `writer().clearAll()` | `DELETE FROM ...` (or `TRUNCATE`) | `TRUNCATE ...` |
| `writer().upsertPrecomputedRaw(id, text, vector, meta, options)` | UPSERT with vector literal | INSERT … ON CONFLICT with vector literal |

### Schema shape (both backends)

```
<collection_name> table:
  id          VARCHAR(255) PRIMARY KEY
  text        VARCHAR / TEXT
  vector      REAL_VECTOR(<dim>) / vector(<dim>)
  metadata    NVARCHAR / JSONB
  created_at  TIMESTAMP
```

HANA uses `REAL_VECTOR(dim)` column type. Postgres uses `vector(dim)` from pgvector. Both auto-created when `autoCreateSchema: true`.

Metadata is serialized JSON. On retrieval, parsed back to `RagMetadata`.

### Config shape

```ts
interface HanaVectorRagConfig {
  // Connection: URL or explicit fields
  connectionString?: string;                 // e.g. jdbc-style SAP HANA URL
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  schema?: string;                            // default: inferred from user

  // Collection
  collectionName: string;                     // table name (sanitized)
  dimension?: number;                         // default: 1536
  autoCreateSchema?: boolean;                 // default: true

  // Connection pool
  poolMax?: number;                           // default: 5
  connectTimeout?: number;                    // ms, default: 30000
}
```

```ts
interface PgVectorRagConfig {
  // Connection: URL or explicit fields
  connectionString?: string;                 // e.g. postgres://user:pass@host:5432/db
  host?: string;
  port?: number;                              // default: 5432
  user?: string;
  password?: string;
  database?: string;
  schema?: string;                            // default: 'public'

  // Collection
  collectionName: string;                     // table name (sanitized)
  dimension?: number;                         // default: 1536
  autoCreateSchema?: boolean;                 // default: true

  // Connection pool
  poolMax?: number;                           // default: 10
  connectTimeout?: number;                    // default: 30000
}
```

Internal resolver converts either URL or explicit fields into the driver's native connection args.

### Collection name sanitization

Both backends use the collection name as a SQL table identifier. Must be SQL-safe. Rule: regex `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`. Violations throw `RagError('INVALID_COLLECTION_NAME')` at construction.

### Provider wiring

```ts
export class HanaVectorRagProvider extends AbstractRagProvider {
  readonly name = 'hana-vector';
  readonly kind = 'vector-db';
  readonly supportedScopes = ['session', 'user', 'global'] as const;

  constructor(private readonly cfg: {
    defaultEmbedder: IEmbedder;
    connection: HanaVectorRagConfig | string;
    defaultDimension?: number;
    autoCreateSchema?: boolean;
    defaultIdStrategy?: 'caller-provided' | 'uuid' | 'session-scoped' | 'canonical-key';
  }) {
    super();
  }

  async createCollection(name: string, opts: { scope, sessionId?, userId? }): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    // 1. Validate scope against supportedScopes
    // 2. Instantiate HanaVectorRag with cfg.connection + name
    // 3. If autoCreateSchema: run CREATE TABLE IF NOT EXISTS + CREATE INDEX
    // 4. Build editor via buildEditor() helper from AbstractRagProvider
    // 5. Return pair
  }

  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    // DROP TABLE IF EXISTS
  }

  async listCollections(): Promise<Result<string[], RagError>> {
    // Query SYS.TABLES / information_schema.tables filtered by schema
  }
}
```

(`PgVectorRagProvider` follows the same shape.)

### Server integration

Add to server's factory registry (`embedder-factories.ts` analog for RAG providers — or in a new file if a dedicated RAG factory registry is warranted). For v11.0.0 scope, the factory registry stays on embedders; RAG backends are instantiated by name inside `SmartServer` composition. Task plan inspects `SmartServer.ts` to see how `rag.type` resolves today and extends that resolver with `hana-vector` and `pg-vector` cases.

Server's `peerDependencies` gains:

```json
"@mcp-abap-adt/hana-vector-rag": "^11.0.0",
"@mcp-abap-adt/pg-vector-rag": "^11.0.0"
```

Both marked optional in `peerDependenciesMeta`.

Server's `devDependencies` gains both packages at `*` so tests and dev builds have them.

Server's `tsconfig.json` gains `{ "path": "../hana-vector-rag" }` and `{ "path": "../pg-vector-rag" }` in `references`.

Root `package.json` `build`/`clean` scripts extended with `packages/hana-vector-rag` and `packages/pg-vector-rag`.

Changesets `fixed` group extended to 12 packages.

### Factory registry additions

In `packages/llm-agent-server/src/smart-agent/embedder-factories.ts` (if that's where RAG resolution lives — or a sibling RAG factory file), add:

```ts
// PACKAGE_BY_NAME (for RAG backends requiring peer resolution)
'hana-vector': '@mcp-abap-adt/hana-vector-rag',
'pg-vector':   '@mcp-abap-adt/pg-vector-rag',
```

If SmartServer's config resolution for `rag.type` is hard-coded (switch statement) rather than factory-based, extend the switch with the two new cases, each preceded by a prefetch step that dynamic-imports the peer and falls back to `MissingProviderError` when absent.

## Testing

Unit tests per package follow the Qdrant pattern from the existing `packages/qdrant-rag/src/__tests__/qdrant-rag.test.ts`: mock the driver client. For HANA, mock `@sap/hana-client` objects. For pg, mock `pg.Pool` and `Client`.

Cover:
- `query`, `getById`, `upsertRaw`, `deleteByIdRaw`, `clearAll`, `upsertPrecomputedRaw`
- Provider: `createCollection` (happy path + autoCreateSchema on/off), `deleteCollection`, `listCollections`, scope rejection
- Connection string parsing (URL vs explicit fields)
- Collection-name validation rejection
- `MissingProviderError` path when peer isn't installed (integration test in server)

No real-database tests in CI for v11.0.0. Real-DB integration is out-of-scope (separate smoke suite later).

## File layout (both packages, same shape)

```
packages/hana-vector-rag/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── hana-vector-rag.ts          — HanaVectorRag class
│   ├── hana-vector-rag-provider.ts — HanaVectorRagProvider class
│   ├── connection.ts                — config + URL parsing
│   ├── schema.ts                    — DDL helpers
│   ├── index.ts                     — public exports
│   └── __tests__/
│       ├── hana-vector-rag.test.ts
│       └── hana-vector-rag-provider.test.ts
```

(`pg-vector-rag/` mirrors this structure with corresponding filenames.)

## Dependency graph

```
@mcp-abap-adt/llm-agent (zod)
  ↑
  ├─ ... (10 existing v11 packages)
  │
  ├─ hana-vector-rag (@sap/hana-client)  ←─ optional peer of llm-agent-server
  └─ pg-vector-rag (pg)                   ←─ optional peer of llm-agent-server
```

Both new packages depend only on core. No cross-deps with other peers. Clean fan-out.

## Release flow

1. Implement both packages (plan has parallel tasks).
2. Update server peer deps, tsconfig refs, factory registry, root build scripts, changesets config.
3. `MIGRATION-v11.md` gains a "New RAG backends" section naming both packages.
4. README gains both in the package table.
5. Extend root CHANGELOG entry for 11.0.0 to mention the two new packages.
6. Full workspace build + test clean.
7. Merge PR to `main`.
8. Post-merge: `npx changeset publish` → all 12 packages published at 11.0.0.
9. `git tag -a v11.0.0 -m "Release 11.0.0"` + push → GitHub release workflow.

## Out of scope

- Real-database integration tests (deferred).
- `pgvector` / `@sap/hana-client` operational docs beyond "install and configure" (belongs in provider READMEs).
- Alternative Postgres drivers (`postgres.js` etc.).
- Alternative HANA drivers (`hdb`).
- Schema migration tooling for production deployments.
- Distance metrics other than cosine similarity.

## Known items for implementation plan

- Collection-name → SQL table-identifier sanitization: single regex, same in both packages. Centralize in a core utility? For v11.0.0 scope, keep the regex duplicated in each package; consolidate later if multiple backends grow.
- Connection pool lifecycle: both packages own their pool. Server doesn't manage it. Pool closes on `rag.close?()` (if IRag gains an optional close method) or on process exit via handler.
- Metadata JSON column type: Postgres supports native `JSONB` (preferred). HANA has `NCLOB` for JSON; `NVARCHAR` as fallback with size limit. Tests must round-trip metadata correctly.
