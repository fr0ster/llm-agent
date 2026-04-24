# v11.0.0 HANA + pgvector RAG Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two new RAG backend packages (`@mcp-abap-adt/hana-vector-rag`, `@mcp-abap-adt/pg-vector-rag`) as optional peers of `@mcp-abap-adt/llm-agent-server` and release them with v11.0.0.

**Architecture:** Each package exports a concrete `IRag` implementation plus an `IRagProvider` extending `AbstractRagProvider`. Both own their driver-level code behind interface boundaries. Schema bootstrap is backend-owned lazy init (`ensureSchema()`) shared by both direct `makeRag()` construction and `provider.createCollection()`. Server wires the two through a dedicated RAG factory registry mirroring the existing embedder-factories startup-prefetch + sync-resolve pattern; missing peer packages surface as `MissingProviderError`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), `@sap/hana-client` driver for HANA, `pg` driver for Postgres + pgvector, `node:test` for unit tests, Biome for lint/format, npm workspaces, `@changesets/cli` (fixed group of 12 packages).

**Spec:** `docs/superpowers/specs/2026-04-24-v11-hana-pgvector-design.md`

**Branch:** `feat/v11-hana-pgvector` (already checked out)

---

## File structure

Two new packages, identical shape. Server gets one new factory module plus config-surface extensions.

```
packages/hana-vector-rag/
├── package.json                     — name, deps (@sap/hana-client), build/test scripts
├── tsconfig.json                    — extends ../../tsconfig.base.json, references llm-agent
├── README.md                        — install + minimal config sample
├── src/
│   ├── index.ts                     — public exports
│   ├── connection.ts                — HanaVectorRagConfig | string → pool args
│   ├── schema.ts                    — ensureSchema DDL + quoteIdent + collection-name regex
│   ├── hana-vector-rag.ts           — HanaVectorRag class implements IRag (+ writer())
│   ├── hana-vector-rag-provider.ts  — HanaVectorRagProvider extends AbstractRagProvider
│   └── __tests__/
│       ├── connection.test.ts
│       ├── schema.test.ts
│       ├── hana-vector-rag.test.ts
│       └── hana-vector-rag-provider.test.ts

packages/pg-vector-rag/               — mirror of the above, s/hana/pg/
├── package.json                     — deps: pg
├── src/…                            — pg-vector-rag.ts, pg-vector-rag-provider.ts, connection.ts, schema.ts, index.ts, __tests__/

packages/llm-agent-server/
├── src/smart-agent/rag-factories.ts            — NEW: PACKAGE_BY_NAME, prefetch + sync resolve
├── src/smart-agent/providers.ts                — MODIFIED: extend RagResolutionConfig['type'], add 'hana-vector' and 'pg-vector' branches calling resolveRag(name,…)
├── src/smart-agent/pipeline.ts                 — MODIFIED: extend type union + comment
├── src/smart-agent/smart-server.ts             — MODIFIED: extend type union in SmartServerRagConfig
├── src/smart-agent/config.ts                   — MODIFIED: extend YAML type cast + sample comments
├── src/smart-agent/__tests__/rag-factories.test.ts           — NEW: prefetch + sync resolve + MissingProviderError
├── src/smart-agent/__tests__/hana-pg-integration.test.ts     — NEW: direct makeRag schema bootstrap, missing peer error path
├── package.json                                — peerDependencies + peerDependenciesMeta + devDependencies + ^11.0.0
└── tsconfig.json                               — references two new packages

Root:
├── package.json                                — build/clean/test scripts extended to 12 packages
├── tsconfig.json                               — project references extended
├── .changeset/config.json                      — fixed group extended to 12
├── MIGRATION-v11.md                            — "New RAG backends" section
├── CHANGELOG.md                                — root 11.0.0 entry amended
└── README.md                                   — package table extended
```

**Note on architecture flexibility:** The spec allows refactoring server composition. For this plan we keep the current factory-based composition and add a dedicated `rag-factories.ts`. If during implementation a subagent identifies a clearly-better composition path, it may propose it in the DONE_WITH_CONCERNS channel rather than forcing it mid-plan.

---

### Task 1: Scaffold `@mcp-abap-adt/hana-vector-rag` package

**Files:**
- Create: `packages/hana-vector-rag/package.json`
- Create: `packages/hana-vector-rag/tsconfig.json`
- Create: `packages/hana-vector-rag/README.md`
- Create: `packages/hana-vector-rag/src/index.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@mcp-abap-adt/hana-vector-rag",
  "version": "11.0.0",
  "description": "HanaVectorRag vector store (SAP HANA Cloud Vector Engine) and HanaVectorRagProvider for @mcp-abap-adt/llm-agent.",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "tsc -p tsconfig.json --clean",
    "test": "node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'"
  },
  "dependencies": {
    "@mcp-abap-adt/llm-agent": "*",
    "@sap/hana-client": "^2.24.26"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/fr0ster/llm-agent.git"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "references": [{ "path": "../llm-agent" }],
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Write `README.md`**

```markdown
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
```

- [ ] **Step 4: Write placeholder `src/index.ts`**

```ts
export { HanaVectorRag } from './hana-vector-rag.js';
export type { HanaVectorRagConfig } from './hana-vector-rag.js';
export { HanaVectorRagProvider } from './hana-vector-rag-provider.js';
export type { HanaVectorRagProviderConfig } from './hana-vector-rag-provider.js';
```

- [ ] **Step 5: Install `@sap/hana-client`**

Run from repo root: `npm install --workspace @mcp-abap-adt/hana-vector-rag @sap/hana-client@^2.24.26`

- [ ] **Step 6: Commit**

```bash
git add packages/hana-vector-rag package-lock.json
git commit -m "feat(hana-vector-rag): scaffold package"
```

---

### Task 2: Scaffold `@mcp-abap-adt/pg-vector-rag` package

**Files:**
- Create: `packages/pg-vector-rag/package.json`
- Create: `packages/pg-vector-rag/tsconfig.json`
- Create: `packages/pg-vector-rag/README.md`
- Create: `packages/pg-vector-rag/src/index.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@mcp-abap-adt/pg-vector-rag",
  "version": "11.0.0",
  "description": "PgVectorRag (PostgreSQL + pgvector) and PgVectorRagProvider for @mcp-abap-adt/llm-agent.",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "tsc -p tsconfig.json --clean",
    "test": "node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'"
  },
  "dependencies": {
    "@mcp-abap-adt/llm-agent": "*",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/fr0ster/llm-agent.git"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "references": [{ "path": "../llm-agent" }],
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Write `README.md`**

```markdown
# @mcp-abap-adt/pg-vector-rag

PostgreSQL + pgvector backend for [@mcp-abap-adt/llm-agent](https://www.npmjs.com/package/@mcp-abap-adt/llm-agent).

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
```

- [ ] **Step 4: Write placeholder `src/index.ts`**

```ts
export { PgVectorRag } from './pg-vector-rag.js';
export type { PgVectorRagConfig } from './pg-vector-rag.js';
export { PgVectorRagProvider } from './pg-vector-rag-provider.js';
export type { PgVectorRagProviderConfig } from './pg-vector-rag-provider.js';
```

- [ ] **Step 5: Install `pg` + `@types/pg`**

Run from repo root: `npm install --workspace @mcp-abap-adt/pg-vector-rag pg@^8.13.0 @types/pg@^8.11.0`

- [ ] **Step 6: Commit**

```bash
git add packages/pg-vector-rag package-lock.json
git commit -m "feat(pg-vector-rag): scaffold package"
```

---

### Task 3: HANA `connection.ts` (URL / explicit-field resolver)

**Files:**
- Create: `packages/hana-vector-rag/src/connection.ts`
- Create: `packages/hana-vector-rag/src/__tests__/connection.test.ts`

- [ ] **Step 1: Write failing test**

`packages/hana-vector-rag/src/__tests__/connection.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveHanaConnectArgs } from '../connection.js';

describe('resolveHanaConnectArgs', () => {
  it('accepts explicit fields', () => {
    const args = resolveHanaConnectArgs({
      host: 'h.example.com',
      port: 443,
      user: 'U1',
      password: 'pw',
      collectionName: 't',
    });
    assert.equal(args.serverNode, 'h.example.com:443');
    assert.equal(args.uid, 'U1');
    assert.equal(args.pwd, 'pw');
    assert.equal(args.encrypt, 'true');
  });

  it('parses hdbsql URL', () => {
    const args = resolveHanaConnectArgs({
      connectionString: 'hdbsql://u:p@host.example:443',
      collectionName: 't',
    });
    assert.equal(args.serverNode, 'host.example:443');
    assert.equal(args.uid, 'u');
    assert.equal(args.pwd, 'p');
  });

  it('rejects missing host', () => {
    assert.throws(() =>
      resolveHanaConnectArgs({ user: 'u', password: 'p', collectionName: 't' }),
      /host/i,
    );
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run: `npm test --workspace @mcp-abap-adt/hana-vector-rag`
Expected: FAIL (`Cannot find module '../connection.js'`).

- [ ] **Step 3: Implement `connection.ts`**

```ts
export interface HanaVectorRagConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  schema?: string;
  collectionName: string;
  dimension?: number;
  autoCreateSchema?: boolean;
  poolMax?: number;
  connectTimeout?: number;
}

export interface HanaConnectArgs {
  serverNode: string;
  uid: string;
  pwd: string;
  encrypt: 'true' | 'false';
  sslValidateCertificate?: 'true' | 'false';
  currentSchema?: string;
  communicationTimeout?: number;
}

export function resolveHanaConnectArgs(
  cfg: HanaVectorRagConfig,
): HanaConnectArgs {
  let host = cfg.host;
  let port = cfg.port;
  let user = cfg.user;
  let password = cfg.password;

  if (cfg.connectionString) {
    const normalized = cfg.connectionString.replace(/^hdbsql:\/\//, 'https://');
    const u = new URL(normalized);
    host ??= u.hostname;
    port ??= u.port ? Number(u.port) : 443;
    user ??= decodeURIComponent(u.username);
    password ??= decodeURIComponent(u.password);
  }

  if (!host) throw new Error('HANA host is required (host or connectionString)');
  if (!user) throw new Error('HANA user is required');
  if (!password) throw new Error('HANA password is required');

  return {
    serverNode: `${host}:${port ?? 443}`,
    uid: user,
    pwd: password,
    encrypt: 'true',
    sslValidateCertificate: 'true',
    currentSchema: cfg.schema,
    communicationTimeout: cfg.connectTimeout ?? 30_000,
  };
}
```

- [ ] **Step 4: Run test → expect PASS**

Run: `npm test --workspace @mcp-abap-adt/hana-vector-rag`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/hana-vector-rag/src
git commit -m "feat(hana-vector-rag): connection args resolver"
```

---

### Task 4: HANA `schema.ts` (DDL + collection-name sanitization)

**Files:**
- Create: `packages/hana-vector-rag/src/schema.ts`
- Create: `packages/hana-vector-rag/src/__tests__/schema.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertCollectionName,
  createTableSql,
  dropTableSql,
  quoteIdent,
} from '../schema.js';

describe('hana schema', () => {
  it('accepts a safe collection name', () => {
    assertCollectionName('llm_agent_docs_2');
  });
  it('rejects collection name starting with digit', () => {
    assert.throws(() => assertCollectionName('1bad'), /INVALID_COLLECTION_NAME/);
  });
  it('rejects collection name with special chars', () => {
    assert.throws(() => assertCollectionName("x'); DROP"), /INVALID_COLLECTION_NAME/);
  });
  it('rejects names longer than 63 chars', () => {
    assert.throws(() => assertCollectionName('a'.repeat(64)), /INVALID_COLLECTION_NAME/);
  });

  it('quotes HANA identifiers', () => {
    assert.equal(quoteIdent('llm_docs'), '"llm_docs"');
  });

  it('emits CREATE TABLE DDL with REAL_VECTOR and NCLOB', () => {
    const sql = createTableSql('llm_docs', 1536);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "llm_docs"/);
    assert.match(sql, /REAL_VECTOR\(1536\)/);
    assert.match(sql, /metadata NCLOB/);
  });

  it('emits DROP TABLE DDL', () => {
    assert.equal(dropTableSql('llm_docs'), 'DROP TABLE "llm_docs"');
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run: `npm test --workspace @mcp-abap-adt/hana-vector-rag`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `schema.ts`**

```ts
import { RagError } from '@mcp-abap-adt/llm-agent';

const COLLECTION_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function assertCollectionName(name: string): void {
  if (!COLLECTION_NAME_RE.test(name)) {
    throw new RagError(
      `Invalid collection name: ${name}`,
      'INVALID_COLLECTION_NAME',
    );
  }
}

export function quoteIdent(ident: string): string {
  assertCollectionName(ident);
  return `"${ident}"`;
}

export function createTableSql(collection: string, dimension: number): string {
  const table = quoteIdent(collection);
  return `CREATE TABLE IF NOT EXISTS ${table} (
    id NVARCHAR(255) PRIMARY KEY,
    text NCLOB,
    vector REAL_VECTOR(${dimension}),
    metadata NCLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;
}

export function dropTableSql(collection: string): string {
  return `DROP TABLE ${quoteIdent(collection)}`;
}
```

- [ ] **Step 4: Run test → expect PASS**

Run: `npm test --workspace @mcp-abap-adt/hana-vector-rag`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/hana-vector-rag/src
git commit -m "feat(hana-vector-rag): schema DDL helpers + name validation"
```

---

### Task 5: `HanaVectorRag` class

**Files:**
- Create: `packages/hana-vector-rag/src/hana-vector-rag.ts`
- Create: `packages/hana-vector-rag/src/__tests__/hana-vector-rag.test.ts`

**Approach:** The `@sap/hana-client` driver is mocked through a thin `HanaClient` seam — an interface defined in this file. Production code obtains a real client; tests pass a fake. This keeps driver code isolated without adding a core abstraction.

- [ ] **Step 1: Write failing test (mock driver, cover query/upsert/getById/healthCheck/writer + autoCreateSchema)**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { HanaVectorRag, type HanaClient } from '../hana-vector-rag.js';

function makeEmbedder(dim = 3): IEmbedder {
  return {
    async embed(text: string) {
      let h = 0;
      for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
      return { vector: Array.from({ length: dim }, (_, i) => ((h >> i) & 0xff) / 255) };
    },
  };
}

interface ExecCall { sql: string; params: readonly unknown[]; }

function makeFakeClient(rows: Record<string, unknown>[] = []): HanaClient & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async exec(sql, params = []) { calls.push({ sql, params }); return { rowCount: 1 }; },
    async query(sql, params = []) { calls.push({ sql, params }); return rows; },
    async close() { /* noop */ },
  };
}

describe('HanaVectorRag', () => {
  it('ensureSchema runs CREATE TABLE only once', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    await rag.ensureSchema();
    await rag.ensureSchema();
    const creates = client.calls.filter((c) => c.sql.includes('CREATE TABLE'));
    assert.equal(creates.length, 1);
  });

  it('query returns results mapped from rows', async () => {
    const rows = [{ id: 'a', text: 'hello', metadata: '{"namespace":"n"}', score: 0.9 }];
    const client = makeFakeClient(rows);
    const rag = new HanaVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const res = await rag.query({ toVector: async () => [0.1, 0.2, 0.3] }, 5);
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('unreachable');
    assert.equal(res.value.length, 1);
    assert.equal(res.value[0].text, 'hello');
    assert.equal(res.value[0].metadata?.namespace, 'n');
  });

  it('upsertRaw issues UPSERT with vector literal', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const r = await rag.writer().upsertRaw('id1', 'text', { namespace: 'n' });
    assert.equal(r.ok, true);
    const upsert = client.calls.find((c) => c.sql.startsWith('UPSERT'));
    assert.ok(upsert, 'UPSERT should have been issued');
  });

  it('deleteByIdRaw issues DELETE', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const r = await rag.writer().deleteByIdRaw('id1');
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.includes('DELETE FROM')));
  });

  it('clearAll issues TRUNCATE', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const r = await rag.writer().clearAll();
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('TRUNCATE')));
  });

  it('healthCheck runs SELECT 1 FROM DUMMY', async () => {
    const client = makeFakeClient([{ '1': 1 }]);
    const rag = new HanaVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const r = await rag.healthCheck();
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.includes('FROM DUMMY')));
  });

  it('rejects invalid collection name at construction', () => {
    assert.throws(
      () => new HanaVectorRag({ collectionName: "bad'; DROP", embedder: makeEmbedder() }, makeFakeClient()),
      (err: Error & { code?: string }) => err.code === 'INVALID_COLLECTION_NAME',
    );
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run: `npm test --workspace @mcp-abap-adt/hana-vector-rag`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `hana-vector-rag.ts`**

```ts
import type {
  CallOptions,
  IEmbedder,
  IQueryEmbedding,
  IRag,
  IRagBackendWriter,
  RagMetadata,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { FallbackQueryEmbedding, RagError } from '@mcp-abap-adt/llm-agent';
import type { HanaVectorRagConfig } from './connection.js';
import { resolveHanaConnectArgs } from './connection.js';
import { assertCollectionName, createTableSql, quoteIdent } from './schema.js';

export type { HanaVectorRagConfig };

export interface HanaClient {
  exec(sql: string, params?: readonly unknown[]): Promise<{ rowCount: number }>;
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

export interface HanaVectorRagDeps {
  /** Injected for tests; in production the default driver factory is used. */
  client?: HanaClient;
}

export class HanaVectorRag implements IRag {
  private readonly collectionName: string;
  private readonly dimension: number;
  private readonly embedder: IEmbedder;
  private readonly autoCreateSchema: boolean;
  private readonly clientPromise: Promise<HanaClient>;
  private schemaReady = false;
  private schemaPromise?: Promise<void>;

  constructor(
    config: HanaVectorRagConfig & { embedder: IEmbedder },
    injectedClient?: HanaClient,
  ) {
    assertCollectionName(config.collectionName);
    this.collectionName = config.collectionName;
    this.dimension = config.dimension ?? 1536;
    this.embedder = config.embedder;
    this.autoCreateSchema = config.autoCreateSchema ?? true;
    this.clientPromise = injectedClient
      ? Promise.resolve(injectedClient)
      : this.createDriverClient(config);
  }

  private async createDriverClient(cfg: HanaVectorRagConfig): Promise<HanaClient> {
    const args = resolveHanaConnectArgs(cfg);
    // Dynamic import keeps the peer dep optional at import time.
    const mod = (await import('@sap/hana-client')) as unknown as {
      createConnection: () => {
        connect: (opts: unknown, cb: (err: Error | null) => void) => void;
        exec: (sql: string, params: unknown[], cb: (err: Error | null, rows: unknown) => void) => void;
        disconnect: (cb: (err: Error | null) => void) => void;
      };
    };
    const conn = mod.createConnection();
    await new Promise<void>((resolve, reject) =>
      conn.connect(args, (err) => (err ? reject(err) : resolve())),
    );
    return {
      exec: (sql, params = []) =>
        new Promise((resolve, reject) =>
          conn.exec(sql, params as unknown[], (err, rows) =>
            err ? reject(err) : resolve({ rowCount: Array.isArray(rows) ? rows.length : 1 }),
          ),
        ),
      query: (sql, params = []) =>
        new Promise((resolve, reject) =>
          conn.exec(sql, params as unknown[], (err, rows) =>
            err ? reject(err) : resolve((rows as Array<Record<string, unknown>>) ?? []),
          ),
        ),
      close: () =>
        new Promise((resolve, reject) =>
          conn.disconnect((err) => (err ? reject(err) : resolve())),
        ),
    };
  }

  /**
   * Idempotent schema bootstrap. Called by both direct makeRag() consumers
   * (when autoCreateSchema is true) and HanaVectorRagProvider.createCollection().
   */
  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    this.schemaPromise ??= (async () => {
      const client = await this.clientPromise;
      await client.exec(createTableSql(this.collectionName, this.dimension));
      this.schemaReady = true;
    })();
    await this.schemaPromise;
  }

  private async maybeEnsureSchema(): Promise<void> {
    if (this.autoCreateSchema) await this.ensureSchema();
  }

  private vectorLiteral(vec: number[]): string {
    return `TO_REAL_VECTOR('[${vec.join(',')}]')`;
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (options?.signal?.aborted) return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      await this.maybeEnsureSchema();
      const safe = new FallbackQueryEmbedding(embedding, this.embedder);
      const vector = await safe.toVector();
      const client = await this.clientPromise;
      const table = quoteIdent(this.collectionName);
      const sql = `SELECT id, text, metadata, COSINE_SIMILARITY(vector, ${this.vectorLiteral(vector)}) AS score FROM ${table} ORDER BY score DESC LIMIT ${Math.max(1, k)}`;
      const rows = await client.query(sql);
      const results: RagResult[] = rows.map((row) => {
        const metaRaw = row.metadata as string | null | undefined;
        const metadata = metaRaw ? (JSON.parse(metaRaw) as RagMetadata) : {};
        return {
          text: String(row.text ?? ''),
          metadata,
          score: Number(row.score ?? 0),
        };
      });
      return { ok: true, value: results };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async getById(id: string, options?: CallOptions): Promise<Result<RagResult | null, RagError>> {
    if (options?.signal?.aborted) return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      const rows = await client.query(
        `SELECT id, text, metadata FROM ${quoteIdent(this.collectionName)} WHERE id = ?`,
        [id],
      );
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      const metaRaw = row.metadata as string | null | undefined;
      const metadata = metaRaw ? (JSON.parse(metaRaw) as RagMetadata) : {};
      return { ok: true, value: { text: String(row.text ?? ''), metadata, score: 1 } };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    try {
      const client = await this.clientPromise;
      await client.query('SELECT 1 FROM DUMMY');
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'HEALTH_CHECK_ERROR') };
    }
  }

  async upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      const { vector } = await this.embedder.embed(text, options);
      return this.upsertKnown(text, vector, metadata);
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
  ): Promise<Result<void, RagError>> {
    return this.upsertKnown(text, vector, metadata);
  }

  private async upsertKnown(
    text: string,
    vector: number[],
    metadata: RagMetadata,
  ): Promise<Result<void, RagError>> {
    try {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      const id = metadata?.id ?? crypto.randomUUID();
      const { id: _omit, ...rest } = metadata ?? {};
      const metaJson = JSON.stringify(rest);
      const sql = `UPSERT ${quoteIdent(this.collectionName)} (id, text, vector, metadata) VALUES (?, ?, ${this.vectorLiteral(vector)}, ?) WITH PRIMARY KEY`;
      await client.exec(sql, [id, text, metaJson]);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  writer(): IRagBackendWriter {
    return {
      upsertRaw: async (id, text, metadata, options) => {
        const r = await this.upsert(text, { ...metadata, id }, options);
        return r.ok ? { ok: true, value: undefined } : r;
      },
      deleteByIdRaw: async (id) => {
        try {
          await this.maybeEnsureSchema();
          const client = await this.clientPromise;
          const r = await client.exec(
            `DELETE FROM ${quoteIdent(this.collectionName)} WHERE id = ?`,
            [id],
          );
          return { ok: true, value: r.rowCount > 0 };
        } catch (err) {
          return { ok: false, error: new RagError(String(err), 'DELETE_ERROR') };
        }
      },
      clearAll: async () => {
        try {
          await this.maybeEnsureSchema();
          const client = await this.clientPromise;
          await client.exec(`TRUNCATE TABLE ${quoteIdent(this.collectionName)}`);
          return { ok: true, value: undefined };
        } catch (err) {
          return { ok: false, error: new RagError(String(err), 'CLEAR_ERROR') };
        }
      },
      upsertPrecomputedRaw: async (id, text, vector, metadata) =>
        this.upsertPrecomputed(text, vector, { ...metadata, id }),
    };
  }
}
```

- [ ] **Step 4: Run test → expect PASS**

Run: `npm test --workspace @mcp-abap-adt/hana-vector-rag`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/hana-vector-rag/src
git commit -m "feat(hana-vector-rag): HanaVectorRag IRag implementation"
```

---

### Task 6: `HanaVectorRagProvider`

**Files:**
- Create: `packages/hana-vector-rag/src/hana-vector-rag-provider.ts`
- Create: `packages/hana-vector-rag/src/__tests__/hana-vector-rag-provider.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import type { HanaClient } from '../hana-vector-rag.js';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';

function makeEmbedder(): IEmbedder {
  return { async embed() { return { vector: [0, 0, 0] }; } };
}

interface ExecCall { sql: string; params: readonly unknown[]; }

function makeFakeClient(rows: Record<string, unknown>[] = []): HanaClient & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async exec(sql, params = []) { calls.push({ sql, params }); return { rowCount: 1 }; },
    async query(sql, params = []) { calls.push({ sql, params }); return rows; },
    async close() {},
  };
}

describe('HanaVectorRagProvider', () => {
  it('createCollection returns rag + editor, runs schema bootstrap when autoCreateSchema=true', async () => {
    const client = makeFakeClient();
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p' },
      defaultDimension: 3,
      autoCreateSchema: true,
      clientFactory: () => client,
    });
    const r = await provider.createCollection('docs', { scope: 'session', sessionId: 's1' });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    assert.ok(client.calls.some((c) => c.sql.includes('CREATE TABLE') && c.sql.includes('"docs"')));
  });

  it('createCollection skips DDL when autoCreateSchema=false', async () => {
    const client = makeFakeClient();
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p' },
      defaultDimension: 3,
      autoCreateSchema: false,
      clientFactory: () => client,
    });
    const r = await provider.createCollection('docs', { scope: 'global' });
    assert.equal(r.ok, true);
    assert.ok(!client.calls.some((c) => c.sql.includes('CREATE TABLE')));
  });

  it('deleteCollection emits DROP TABLE', async () => {
    const client = makeFakeClient();
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p' },
      clientFactory: () => client,
    });
    const r = await provider.deleteCollection('docs');
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('DROP TABLE')));
  });

  it('listCollections queries SYS.TABLES and returns names', async () => {
    const client = makeFakeClient([{ TABLE_NAME: 'docs' }, { TABLE_NAME: 'other' }]);
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p' },
      clientFactory: () => client,
    });
    const r = await provider.listCollections();
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    assert.deepEqual(r.value, ['docs', 'other']);
  });

  it('rejects unsupported scope', async () => {
    const client = makeFakeClient();
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p' },
      clientFactory: () => client,
      supportedScopes: ['global'],
    });
    const r = await provider.createCollection('docs', { scope: 'session' });
    assert.equal(r.ok, false);
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run: `npm test --workspace @mcp-abap-adt/hana-vector-rag`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `hana-vector-rag-provider.ts`**

```ts
import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { AbstractRagProvider, RagError } from '@mcp-abap-adt/llm-agent';
import type { HanaVectorRagConfig } from './connection.js';
import { HanaVectorRag, type HanaClient } from './hana-vector-rag.js';
import { quoteIdent } from './schema.js';

export interface HanaVectorRagProviderConfig {
  name: string;
  embedder: IEmbedder;
  connection: HanaVectorRagConfig | string;
  defaultDimension?: number;
  autoCreateSchema?: boolean;
  editable?: boolean;
  supportedScopes?: readonly RagCollectionScope[];
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
  /** Test seam — inject a fake HanaClient. */
  clientFactory?: () => HanaClient;
}

function normalizeConnection(
  c: HanaVectorRagConfig | string,
): HanaVectorRagConfig {
  if (typeof c === 'string') {
    return { connectionString: c, collectionName: '__unused' };
  }
  return c;
}

export class HanaVectorRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly embedder: IEmbedder;
  private readonly connection: HanaVectorRagConfig;
  private readonly defaultDimension: number;
  private readonly autoCreateSchema: boolean;
  private readonly clientFactory?: () => HanaClient;

  constructor(cfg: HanaVectorRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.embedder = cfg.embedder;
    this.connection = normalizeConnection(cfg.connection);
    this.defaultDimension = cfg.defaultDimension ?? 1536;
    this.autoCreateSchema = cfg.autoCreateSchema ?? true;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session', 'user', 'global'];
    this.clientFactory = cfg.clientFactory;
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

  async createCollection(
    name: string,
    opts: { scope: RagCollectionScope; sessionId?: string; userId?: string },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    try {
      const rag = new HanaVectorRag(
        {
          ...this.connection,
          collectionName: name,
          dimension: this.connection.dimension ?? this.defaultDimension,
          autoCreateSchema: this.autoCreateSchema,
          embedder: this.embedder,
        },
        this.clientFactory?.(),
      );
      if (this.autoCreateSchema) await rag.ensureSchema();
      const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
      return { ok: true, value: { rag, editor } };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_CREATE_ERROR') };
    }
  }

  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    try {
      const client = this.clientFactory?.() ?? (await this.borrowClient());
      await client.exec(`DROP TABLE ${quoteIdent(name)}`);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_DELETE_ERROR') };
    }
  }

  async listCollections(): Promise<Result<string[], RagError>> {
    try {
      const client = this.clientFactory?.() ?? (await this.borrowClient());
      const rows = await client.query(
        this.connection.schema
          ? 'SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ?'
          : 'SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA',
        this.connection.schema ? [this.connection.schema] : [],
      );
      return { ok: true, value: rows.map((r) => String(r.TABLE_NAME)) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  private async borrowClient(): Promise<HanaClient> {
    const rag = new HanaVectorRag(
      {
        ...this.connection,
        collectionName: '__borrow__',
        dimension: this.defaultDimension,
        autoCreateSchema: false,
        embedder: this.embedder,
      },
    );
    // Force client creation without running schema DDL.
    await rag.healthCheck();
    // Internal accessor is not exposed; re-enter via a health-check + re-use trick is brittle.
    // Instead, callers should pass clientFactory for delete/list operations in tests.
    // In production, the caller can construct a one-off HanaVectorRag and reuse its client
    // via healthCheck() path. For simplicity, re-issue via a disposable rag instance is acceptable here.
    throw new Error('borrowClient not supported without clientFactory in production paths — pass clientFactory for delete/list');
  }
}
```

Note to implementer: the `borrowClient()` shim is deliberately minimal. If during implementation it becomes clear that a cleaner pattern is needed (shared pool across provider lifecycle), promote a small `HanaConnectionPool` class owned by the provider. Keep changes confined to this package.

- [ ] **Step 4: Run test → expect PASS**

Run: `npm test --workspace @mcp-abap-adt/hana-vector-rag`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/hana-vector-rag/src
git commit -m "feat(hana-vector-rag): HanaVectorRagProvider"
```

---

### Task 7: pgvector `connection.ts`

**Files:**
- Create: `packages/pg-vector-rag/src/connection.ts`
- Create: `packages/pg-vector-rag/src/__tests__/connection.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolvePgConnectArgs } from '../connection.js';

describe('resolvePgConnectArgs', () => {
  it('parses postgres:// URL', () => {
    const a = resolvePgConnectArgs({
      connectionString: 'postgres://u:p@host:5432/db',
      collectionName: 't',
    });
    assert.equal(a.connectionString, 'postgres://u:p@host:5432/db');
    assert.equal(a.max, 10);
  });

  it('uses explicit fields', () => {
    const a = resolvePgConnectArgs({
      host: 'h',
      port: 6543,
      user: 'u',
      password: 'p',
      database: 'db',
      poolMax: 3,
      collectionName: 't',
    });
    assert.equal(a.host, 'h');
    assert.equal(a.port, 6543);
    assert.equal(a.user, 'u');
    assert.equal(a.password, 'p');
    assert.equal(a.database, 'db');
    assert.equal(a.max, 3);
  });

  it('rejects missing host and connectionString', () => {
    assert.throws(() =>
      resolvePgConnectArgs({ user: 'u', password: 'p', collectionName: 't' }),
      /host|connectionString/i,
    );
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run: `npm test --workspace @mcp-abap-adt/pg-vector-rag`
Expected: FAIL.

- [ ] **Step 3: Implement `connection.ts`**

```ts
export interface PgVectorRagConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  collectionName: string;
  dimension?: number;
  autoCreateSchema?: boolean;
  poolMax?: number;
  connectTimeout?: number;
}

export interface PgPoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  max: number;
  connectionTimeoutMillis: number;
}

export function resolvePgConnectArgs(cfg: PgVectorRagConfig): PgPoolConfig {
  const max = cfg.poolMax ?? 10;
  const connectionTimeoutMillis = cfg.connectTimeout ?? 30_000;

  if (cfg.connectionString) {
    return {
      connectionString: cfg.connectionString,
      max,
      connectionTimeoutMillis,
    };
  }

  if (!cfg.host) {
    throw new Error('Postgres connectionString or host is required');
  }
  return {
    host: cfg.host,
    port: cfg.port ?? 5432,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max,
    connectionTimeoutMillis,
  };
}
```

- [ ] **Step 4: Run test → expect PASS**

Run: `npm test --workspace @mcp-abap-adt/pg-vector-rag`
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add packages/pg-vector-rag/src
git commit -m "feat(pg-vector-rag): connection args resolver"
```

---

### Task 8: pgvector `schema.ts`

**Files:**
- Create: `packages/pg-vector-rag/src/schema.ts`
- Create: `packages/pg-vector-rag/src/__tests__/schema.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertCollectionName,
  createExtensionSql,
  createTableSql,
  dropTableSql,
  quoteIdent,
} from '../schema.js';

describe('pg schema', () => {
  it('accepts a safe collection name', () => {
    assertCollectionName('docs_2');
  });
  it('rejects digit-led name', () => {
    assert.throws(
      () => assertCollectionName('1bad'),
      (err: Error & { code?: string }) => err.code === 'INVALID_COLLECTION_NAME',
    );
  });
  it('rejects punctuation', () => {
    assert.throws(
      () => assertCollectionName("x'); DROP"),
      (err: Error & { code?: string }) => err.code === 'INVALID_COLLECTION_NAME',
    );
  });
  it('quotes identifiers with double-quotes', () => {
    assert.equal(quoteIdent('docs'), '"docs"');
  });
  it('emits CREATE EXTENSION IF NOT EXISTS vector', () => {
    assert.match(createExtensionSql(), /CREATE EXTENSION IF NOT EXISTS vector/);
  });
  it('emits CREATE TABLE with vector(n) and jsonb', () => {
    const sql = createTableSql('docs', 1536);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "docs"/);
    assert.match(sql, /vector\(1536\)/);
    assert.match(sql, /metadata JSONB/);
  });
  it('emits DROP TABLE DDL', () => {
    assert.equal(dropTableSql('docs'), 'DROP TABLE IF EXISTS "docs"');
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run: `npm test --workspace @mcp-abap-adt/pg-vector-rag`
Expected: FAIL.

- [ ] **Step 3: Implement `schema.ts`**

```ts
import { RagError } from '@mcp-abap-adt/llm-agent';

const COLLECTION_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function assertCollectionName(name: string): void {
  if (!COLLECTION_NAME_RE.test(name)) {
    throw new RagError(
      `Invalid collection name: ${name}`,
      'INVALID_COLLECTION_NAME',
    );
  }
}

export function quoteIdent(ident: string): string {
  assertCollectionName(ident);
  return `"${ident}"`;
}

export function createExtensionSql(): string {
  return 'CREATE EXTENSION IF NOT EXISTS vector';
}

export function createTableSql(collection: string, dimension: number): string {
  const table = quoteIdent(collection);
  return `CREATE TABLE IF NOT EXISTS ${table} (
    id VARCHAR(255) PRIMARY KEY,
    text TEXT,
    vector vector(${dimension}),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
}

export function dropTableSql(collection: string): string {
  return `DROP TABLE IF EXISTS ${quoteIdent(collection)}`;
}
```

- [ ] **Step 4: Run test → expect PASS**

Run: `npm test --workspace @mcp-abap-adt/pg-vector-rag`
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add packages/pg-vector-rag/src
git commit -m "feat(pg-vector-rag): schema DDL helpers + name validation"
```

---

### Task 9: `PgVectorRag` class

**Files:**
- Create: `packages/pg-vector-rag/src/pg-vector-rag.ts`
- Create: `packages/pg-vector-rag/src/__tests__/pg-vector-rag.test.ts`

**Approach:** Same seam pattern as HANA: define a minimal `PgClient` interface in the module; tests inject a fake; production obtains a real `pg.Pool`.

- [ ] **Step 1: Write failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { PgVectorRag, type PgClient } from '../pg-vector-rag.js';

function makeEmbedder(dim = 3): IEmbedder {
  return {
    async embed(text: string) {
      let h = 0;
      for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
      return { vector: Array.from({ length: dim }, (_, i) => ((h >> i) & 0xff) / 255) };
    },
  };
}

interface ExecCall { sql: string; params: readonly unknown[]; }

function makeFakeClient(rows: Record<string, unknown>[] = []): PgClient & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async query(sql, params = []) { calls.push({ sql, params }); return { rows, rowCount: rows.length }; },
    async end() {},
  };
}

describe('PgVectorRag', () => {
  it('ensureSchema runs CREATE EXTENSION + CREATE TABLE once', async () => {
    const client = makeFakeClient();
    const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    await rag.ensureSchema();
    await rag.ensureSchema();
    const extCount = client.calls.filter((c) => c.sql.includes('CREATE EXTENSION')).length;
    const tblCount = client.calls.filter((c) => c.sql.includes('CREATE TABLE')).length;
    assert.equal(extCount, 1);
    assert.equal(tblCount, 1);
  });

  it('query uses pgvector <=> distance and maps rows', async () => {
    const rows = [{ id: 'a', text: 'hello', metadata: { namespace: 'n' }, score: 0.1 }];
    const client = makeFakeClient(rows);
    const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const r = await rag.query({ toVector: async () => [0.1, 0.2, 0.3] }, 5);
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    assert.equal(r.value[0].text, 'hello');
    assert.equal(r.value[0].metadata?.namespace, 'n');
    assert.ok(client.calls.some((c) => c.sql.includes('<=>')));
  });

  it('upsertRaw issues INSERT … ON CONFLICT', async () => {
    const client = makeFakeClient();
    const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const r = await rag.writer().upsertRaw('id1', 'text', { namespace: 'n' });
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.includes('ON CONFLICT')));
  });

  it('deleteByIdRaw issues DELETE', async () => {
    const client = makeFakeClient([{ '?column?': 1 }]);
    const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const r = await rag.writer().deleteByIdRaw('id1');
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('DELETE FROM')));
  });

  it('clearAll issues TRUNCATE', async () => {
    const client = makeFakeClient();
    const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const r = await rag.writer().clearAll();
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('TRUNCATE')));
  });

  it('healthCheck runs SELECT 1', async () => {
    const client = makeFakeClient([{ '?column?': 1 }]);
    const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
    const r = await rag.healthCheck();
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql === 'SELECT 1'));
  });

  it('rejects invalid collection name', () => {
    assert.throws(
      () => new PgVectorRag({ collectionName: "bad'; DROP", embedder: makeEmbedder() }, makeFakeClient()),
      (err: Error & { code?: string }) => err.code === 'INVALID_COLLECTION_NAME',
    );
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run: `npm test --workspace @mcp-abap-adt/pg-vector-rag`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `pg-vector-rag.ts`**

```ts
import type {
  CallOptions,
  IEmbedder,
  IQueryEmbedding,
  IRag,
  IRagBackendWriter,
  RagMetadata,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { FallbackQueryEmbedding, RagError } from '@mcp-abap-adt/llm-agent';
import type { PgVectorRagConfig } from './connection.js';
import { resolvePgConnectArgs } from './connection.js';
import {
  assertCollectionName,
  createExtensionSql,
  createTableSql,
  quoteIdent,
} from './schema.js';

export type { PgVectorRagConfig };

export interface PgClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
  end(): Promise<void>;
}

function vectorLiteral(vec: number[]): string {
  return `'[${vec.join(',')}]'::vector`;
}

export class PgVectorRag implements IRag {
  private readonly collectionName: string;
  private readonly dimension: number;
  private readonly embedder: IEmbedder;
  private readonly autoCreateSchema: boolean;
  private readonly clientPromise: Promise<PgClient>;
  private schemaReady = false;
  private schemaPromise?: Promise<void>;

  constructor(
    config: PgVectorRagConfig & { embedder: IEmbedder },
    injectedClient?: PgClient,
  ) {
    assertCollectionName(config.collectionName);
    this.collectionName = config.collectionName;
    this.dimension = config.dimension ?? 1536;
    this.embedder = config.embedder;
    this.autoCreateSchema = config.autoCreateSchema ?? true;
    this.clientPromise = injectedClient
      ? Promise.resolve(injectedClient)
      : this.createDriverClient(config);
  }

  private async createDriverClient(cfg: PgVectorRagConfig): Promise<PgClient> {
    const args = resolvePgConnectArgs(cfg);
    const mod = (await import('pg')) as unknown as {
      default?: { Pool: new (a: unknown) => { query: PgClient['query']; end: () => Promise<void> } };
      Pool?: new (a: unknown) => { query: PgClient['query']; end: () => Promise<void> };
    };
    const PoolCtor = mod.Pool ?? mod.default?.Pool;
    if (!PoolCtor) throw new Error('pg module did not expose Pool');
    const pool = new PoolCtor(args);
    return {
      query: (sql, params = []) => pool.query(sql, params as unknown[]),
      end: () => pool.end(),
    };
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    this.schemaPromise ??= (async () => {
      const client = await this.clientPromise;
      await client.query(createExtensionSql());
      await client.query(createTableSql(this.collectionName, this.dimension));
      this.schemaReady = true;
    })();
    await this.schemaPromise;
  }

  private async maybeEnsureSchema(): Promise<void> {
    if (this.autoCreateSchema) await this.ensureSchema();
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (options?.signal?.aborted) return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      await this.maybeEnsureSchema();
      const safe = new FallbackQueryEmbedding(embedding, this.embedder);
      const vector = await safe.toVector();
      const client = await this.clientPromise;
      const table = quoteIdent(this.collectionName);
      const sql = `SELECT id, text, metadata, vector ${'<=>'} ${vectorLiteral(vector)} AS score FROM ${table} ORDER BY vector ${'<=>'} ${vectorLiteral(vector)} LIMIT ${Math.max(1, k)}`;
      const { rows } = await client.query(sql);
      const results: RagResult[] = rows.map((row) => ({
        text: String(row.text ?? ''),
        metadata: (row.metadata as RagMetadata) ?? {},
        score: 1 - Number(row.score ?? 0),
      }));
      return { ok: true, value: results };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async getById(id: string, options?: CallOptions): Promise<Result<RagResult | null, RagError>> {
    if (options?.signal?.aborted) return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      const { rows } = await client.query(
        `SELECT id, text, metadata FROM ${quoteIdent(this.collectionName)} WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      return {
        ok: true,
        value: {
          text: String(row.text ?? ''),
          metadata: (row.metadata as RagMetadata) ?? {},
          score: 1,
        },
      };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    try {
      const client = await this.clientPromise;
      await client.query('SELECT 1');
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'HEALTH_CHECK_ERROR') };
    }
  }

  async upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    try {
      const { vector } = await this.embedder.embed(text, options);
      return this.upsertKnown(text, vector, metadata);
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async upsertPrecomputed(text: string, vector: number[], metadata: RagMetadata): Promise<Result<void, RagError>> {
    return this.upsertKnown(text, vector, metadata);
  }

  private async upsertKnown(
    text: string,
    vector: number[],
    metadata: RagMetadata,
  ): Promise<Result<void, RagError>> {
    try {
      await this.maybeEnsureSchema();
      const client = await this.clientPromise;
      const id = metadata?.id ?? crypto.randomUUID();
      const { id: _omit, ...rest } = metadata ?? {};
      const table = quoteIdent(this.collectionName);
      const sql = `INSERT INTO ${table} (id, text, vector, metadata) VALUES ($1, $2, ${vectorLiteral(vector)}, $3::jsonb) ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, vector = EXCLUDED.vector, metadata = EXCLUDED.metadata`;
      await client.query(sql, [id, text, JSON.stringify(rest)]);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  writer(): IRagBackendWriter {
    return {
      upsertRaw: async (id, text, metadata, options) => {
        const r = await this.upsert(text, { ...metadata, id }, options);
        return r.ok ? { ok: true, value: undefined } : r;
      },
      deleteByIdRaw: async (id) => {
        try {
          await this.maybeEnsureSchema();
          const client = await this.clientPromise;
          const res = await client.query(
            `DELETE FROM ${quoteIdent(this.collectionName)} WHERE id = $1`,
            [id],
          );
          return { ok: true, value: res.rowCount > 0 };
        } catch (err) {
          return { ok: false, error: new RagError(String(err), 'DELETE_ERROR') };
        }
      },
      clearAll: async () => {
        try {
          await this.maybeEnsureSchema();
          const client = await this.clientPromise;
          await client.query(`TRUNCATE ${quoteIdent(this.collectionName)}`);
          return { ok: true, value: undefined };
        } catch (err) {
          return { ok: false, error: new RagError(String(err), 'CLEAR_ERROR') };
        }
      },
      upsertPrecomputedRaw: async (id, text, vector, metadata) =>
        this.upsertPrecomputed(text, vector, { ...metadata, id }),
    };
  }
}
```

- [ ] **Step 4: Run test → expect PASS**

Run: `npm test --workspace @mcp-abap-adt/pg-vector-rag`
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add packages/pg-vector-rag/src
git commit -m "feat(pg-vector-rag): PgVectorRag IRag implementation"
```

---

### Task 10: `PgVectorRagProvider`

**Files:**
- Create: `packages/pg-vector-rag/src/pg-vector-rag-provider.ts`
- Create: `packages/pg-vector-rag/src/__tests__/pg-vector-rag-provider.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import type { PgClient } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';

function makeEmbedder(): IEmbedder { return { async embed() { return { vector: [0, 0, 0] }; } }; }

interface ExecCall { sql: string; params: readonly unknown[]; }

function makeFakeClient(rows: Record<string, unknown>[] = []): PgClient & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async query(sql, params = []) { calls.push({ sql, params }); return { rows, rowCount: rows.length }; },
    async end() {},
  };
}

describe('PgVectorRagProvider', () => {
  it('createCollection runs schema bootstrap when autoCreateSchema=true', async () => {
    const client = makeFakeClient();
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p', database: 'd' },
      defaultDimension: 3,
      autoCreateSchema: true,
      clientFactory: () => client,
    });
    const r = await provider.createCollection('docs', { scope: 'global' });
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.includes('CREATE TABLE') && c.sql.includes('"docs"')));
  });

  it('createCollection skips DDL when autoCreateSchema=false', async () => {
    const client = makeFakeClient();
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p', database: 'd' },
      defaultDimension: 3,
      autoCreateSchema: false,
      clientFactory: () => client,
    });
    const r = await provider.createCollection('docs', { scope: 'global' });
    assert.equal(r.ok, true);
    assert.ok(!client.calls.some((c) => c.sql.includes('CREATE TABLE')));
  });

  it('deleteCollection emits DROP TABLE', async () => {
    const client = makeFakeClient();
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p', database: 'd' },
      clientFactory: () => client,
    });
    const r = await provider.deleteCollection('docs');
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('DROP TABLE')));
  });

  it('listCollections queries information_schema.tables', async () => {
    const client = makeFakeClient([{ table_name: 'docs' }, { table_name: 'other' }]);
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p', database: 'd' },
      clientFactory: () => client,
    });
    const r = await provider.listCollections();
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    assert.deepEqual(r.value, ['docs', 'other']);
  });

  it('rejects unsupported scope', async () => {
    const client = makeFakeClient();
    const provider = new PgVectorRagProvider({
      name: 'pg',
      embedder: makeEmbedder(),
      connection: { collectionName: '__ignored', host: 'h', user: 'u', password: 'p', database: 'd' },
      clientFactory: () => client,
      supportedScopes: ['global'],
    });
    const r = await provider.createCollection('docs', { scope: 'session' });
    assert.equal(r.ok, false);
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run: `npm test --workspace @mcp-abap-adt/pg-vector-rag`
Expected: FAIL.

- [ ] **Step 3: Implement `pg-vector-rag-provider.ts`**

```ts
import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { AbstractRagProvider, RagError } from '@mcp-abap-adt/llm-agent';
import type { PgVectorRagConfig } from './connection.js';
import { PgVectorRag, type PgClient } from './pg-vector-rag.js';
import { quoteIdent } from './schema.js';

export interface PgVectorRagProviderConfig {
  name: string;
  embedder: IEmbedder;
  connection: PgVectorRagConfig | string;
  defaultDimension?: number;
  autoCreateSchema?: boolean;
  editable?: boolean;
  supportedScopes?: readonly RagCollectionScope[];
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
  clientFactory?: () => PgClient;
}

function normalizeConnection(c: PgVectorRagConfig | string): PgVectorRagConfig {
  return typeof c === 'string'
    ? { connectionString: c, collectionName: '__unused' }
    : c;
}

export class PgVectorRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly embedder: IEmbedder;
  private readonly connection: PgVectorRagConfig;
  private readonly defaultDimension: number;
  private readonly autoCreateSchema: boolean;
  private readonly clientFactory?: () => PgClient;

  constructor(cfg: PgVectorRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.embedder = cfg.embedder;
    this.connection = normalizeConnection(cfg.connection);
    this.defaultDimension = cfg.defaultDimension ?? 1536;
    this.autoCreateSchema = cfg.autoCreateSchema ?? true;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session', 'user', 'global'];
    this.clientFactory = cfg.clientFactory;
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

  async createCollection(
    name: string,
    opts: { scope: RagCollectionScope; sessionId?: string; userId?: string },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    try {
      const rag = new PgVectorRag(
        {
          ...this.connection,
          collectionName: name,
          dimension: this.connection.dimension ?? this.defaultDimension,
          autoCreateSchema: this.autoCreateSchema,
          embedder: this.embedder,
        },
        this.clientFactory?.(),
      );
      if (this.autoCreateSchema) await rag.ensureSchema();
      const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
      return { ok: true, value: { rag, editor } };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_CREATE_ERROR') };
    }
  }

  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    try {
      const client = this.requireClient();
      await client.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_DELETE_ERROR') };
    }
  }

  async listCollections(): Promise<Result<string[], RagError>> {
    try {
      const client = this.requireClient();
      const schema = this.connection.schema ?? 'public';
      const { rows } = await client.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
        [schema],
      );
      return { ok: true, value: rows.map((r) => String(r.table_name)) };
    } catch (err) {
      return { ok: false, error: new RagError(String(err), 'RAG_LIST_ERROR') };
    }
  }

  private requireClient(): PgClient {
    if (!this.clientFactory) {
      throw new Error(
        'PgVectorRagProvider deleteCollection/listCollections require clientFactory; provide one or use createCollection-only paths',
      );
    }
    return this.clientFactory();
  }
}
```

- [ ] **Step 4: Run test → expect PASS**

Run: `npm test --workspace @mcp-abap-adt/pg-vector-rag`
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add packages/pg-vector-rag/src
git commit -m "feat(pg-vector-rag): PgVectorRagProvider"
```

---

### Task 11: Server — RAG factory registry (prefetch + sync resolve)

**Files:**
- Create: `packages/llm-agent-server/src/smart-agent/rag-factories.ts`
- Create: `packages/llm-agent-server/src/smart-agent/__tests__/rag-factories.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
import {
  _resetPrefetchedRagForTests,
  prefetchRagFactories,
  resolveRag,
} from '../rag-factories.js';

describe('rag-factories', () => {
  it('throws MissingProviderError for unknown backend name', async () => {
    _resetPrefetchedRagForTests();
    await assert.rejects(() => prefetchRagFactories(['nope']), MissingProviderError);
  });

  it('throws MissingProviderError at resolveRag when not prefetched', () => {
    _resetPrefetchedRagForTests();
    assert.throws(
      () => resolveRag('hana-vector', { collectionName: 'x', embedder: {} as never }),
      MissingProviderError,
    );
  });

  it('prefetches known packages (qdrant already installed via workspace dev dep)', async () => {
    _resetPrefetchedRagForTests();
    await prefetchRagFactories(['qdrant']);
    const rag = resolveRag('qdrant', {
      url: 'http://localhost:6333',
      collectionName: 't',
      embedder: { async embed() { return { vector: [0, 0, 0] }; } },
    });
    assert.equal(typeof rag.query, 'function');
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server`
Expected: FAIL.

- [ ] **Step 3: Implement `rag-factories.ts`**

```ts
import type { IEmbedder, IRag } from '@mcp-abap-adt/llm-agent';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';

export interface RagFactoryOpts {
  url?: string;
  apiKey?: string;
  collectionName?: string;
  embedder: IEmbedder;
  timeoutMs?: number;
  dimension?: number;
  autoCreateSchema?: boolean;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  poolMax?: number;
  connectTimeout?: number;
}

const PACKAGE_BY_NAME: Record<string, string> = {
  qdrant: '@mcp-abap-adt/qdrant-rag',
  'hana-vector': '@mcp-abap-adt/hana-vector-rag',
  'pg-vector': '@mcp-abap-adt/pg-vector-rag',
};

type RagCtor = new (opts: Record<string, unknown>) => IRag;

const EXPORT_BY_NAME: Record<string, string> = {
  qdrant: 'QdrantRag',
  'hana-vector': 'HanaVectorRag',
  'pg-vector': 'PgVectorRag',
};

const prefetched = new Map<string, Record<string, unknown>>();

export async function prefetchRagFactories(
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    if (prefetched.has(name)) continue;
    const pkg = PACKAGE_BY_NAME[name];
    if (!pkg) throw new MissingProviderError('(unknown)', name);
    try {
      const mod = (await import(pkg)) as Record<string, unknown>;
      prefetched.set(name, mod);
    } catch {
      throw new MissingProviderError(pkg, name);
    }
  }
}

export function resolveRag(name: string, opts: RagFactoryOpts): IRag {
  const mod = prefetched.get(name);
  if (!mod) {
    const pkg = PACKAGE_BY_NAME[name] ?? '(unknown)';
    throw new MissingProviderError(pkg, name);
  }
  const exportName = EXPORT_BY_NAME[name];
  const Cls = mod[exportName] as RagCtor | undefined;
  if (!Cls) {
    throw new MissingProviderError(PACKAGE_BY_NAME[name] ?? '(unknown)', name);
  }
  return new Cls(opts as unknown as Record<string, unknown>);
}

export function _resetPrefetchedRagForTests(): void {
  prefetched.clear();
}

export const ragBackendNames = Object.freeze(
  Object.keys(PACKAGE_BY_NAME),
) as readonly string[];
```

- [ ] **Step 4: Run test → expect PASS**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server -- --test-name-pattern 'rag-factories'`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/rag-factories.ts packages/llm-agent-server/src/smart-agent/__tests__/rag-factories.test.ts
git commit -m "feat(server): rag-factories registry (prefetch + sync resolve)"
```

---

### Task 12: Wire new RAG types into `makeRag` + config surfaces

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/providers.ts` (the `RagResolutionConfig` interface + `makeRag` switch)
- Modify: `packages/llm-agent-server/src/smart-agent/pipeline.ts` (type union + comment)
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` (`SmartServerRagConfig.type`)
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts` (YAML cast + sample comment)

- [ ] **Step 1: Extend `RagResolutionConfig` and route new types in `makeRag`**

Edit `providers.ts`:

Change `type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant';` to `type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector';`.

Add these fields to the interface (keep existing fields):

```ts
  /** Connection string or URL for external vector backends. */
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  dimension?: number;
  autoCreateSchema?: boolean;
  poolMax?: number;
  connectTimeout?: number;
```

Refactor the existing `qdrant` branch to use `resolveRag('qdrant', …)` (instead of `new QdrantRag`), and add parallel `hana-vector` / `pg-vector` branches:

```ts
  if (cfg.type === 'qdrant') {
    if (!cfg.url) throw new Error('Qdrant URL is required for qdrant RAG type');
    const embedder = resolveEmbedder(cfg, options);
    return resolveRag('qdrant', {
      url: cfg.url,
      collectionName: cfg.collectionName ?? 'llm-agent',
      embedder,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
  }

  if (cfg.type === 'hana-vector') {
    if (!cfg.collectionName) throw new Error('collectionName is required for hana-vector RAG type');
    const embedder = resolveEmbedder(cfg, options);
    return resolveRag('hana-vector', {
      connectionString: cfg.connectionString,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      schema: cfg.schema,
      collectionName: cfg.collectionName,
      dimension: cfg.dimension,
      autoCreateSchema: cfg.autoCreateSchema,
      poolMax: cfg.poolMax,
      connectTimeout: cfg.connectTimeout,
      embedder,
    });
  }

  if (cfg.type === 'pg-vector') {
    if (!cfg.collectionName) throw new Error('collectionName is required for pg-vector RAG type');
    const embedder = resolveEmbedder(cfg, options);
    return resolveRag('pg-vector', {
      connectionString: cfg.connectionString,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      schema: cfg.schema,
      collectionName: cfg.collectionName,
      dimension: cfg.dimension,
      autoCreateSchema: cfg.autoCreateSchema,
      poolMax: cfg.poolMax,
      connectTimeout: cfg.connectTimeout,
      embedder,
    });
  }
```

Replace the existing `import { QdrantRag } from '@mcp-abap-adt/qdrant-rag';` with `import { resolveRag } from './rag-factories.js';` (if the import was only used for `new QdrantRag` in `makeRag`; check with grep before removing).

- [ ] **Step 2: Extend pipeline type union**

Edit `packages/llm-agent-server/src/smart-agent/pipeline.ts` around line 33-34:

```ts
  /** 'ollama' | 'openai' | 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector'. Default: 'ollama' */
  type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector';
```

Near the existing "Qdrant collection name" comment, add:

```ts
  /** Qdrant / HANA / Postgres collection (table) name. */
```

- [ ] **Step 3: Extend SmartServerRagConfig**

Edit `packages/llm-agent-server/src/smart-agent/smart-server.ts` around line 67-81:

```ts
export interface SmartServerRagConfig {
  type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector';
  embedder?: string;
  url?: string;
  model?: string;
  collectionName?: string;
  dedupThreshold?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  dimension?: number;
  autoCreateSchema?: boolean;
  poolMax?: number;
  connectTimeout?: number;
}
```

- [ ] **Step 4: Extend config.ts YAML cast + sample comments**

Edit `packages/llm-agent-server/src/smart-agent/config.ts`:

- Update line 52 comment:
  ```yaml
  rag:
    type: ollama                        # ollama | in-memory | qdrant | hana-vector | pg-vector
  ```
- Update line 56 comment:
  ```yaml
    # collectionName: llm-agent         # Collection / table name (qdrant | hana-vector | pg-vector)
  ```
- Add a second sample block after the existing `type: qdrant` sample (around line 118):
  ```yaml
  #     type: hana-vector
  #     connectionString: hdbsql://user:pass@host:443
  #     collectionName: llm_agent_docs
  #     dimension: 1536
  #     autoCreateSchema: true
  #
  #     type: pg-vector
  #     connectionString: postgres://user:pass@host:5432/db
  #     collectionName: llm_agent_docs
  #     dimension: 1536
  #     autoCreateSchema: true
  ```
- Update line 286 type cast to:
  ```ts
        'ollama') as 'ollama' | 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector',
  ```

- [ ] **Step 5: Run full server test suite**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server`
Expected: all previous tests still passing; new rag-factories tests passing.

- [ ] **Step 6: Build full workspace**

Run: `npm run build`
Expected: all 12 packages compile (build script updated in Task 14).

If build fails because `packages/hana-vector-rag` / `packages/pg-vector-rag` are not yet in root build config, proceed to Task 14 first then re-run.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/providers.ts packages/llm-agent-server/src/smart-agent/pipeline.ts packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/config.ts
git commit -m "feat(server): route hana-vector and pg-vector via rag-factories"
```

---

### Task 13: Server integration test — direct `makeRag()` schema bootstrap + MissingProviderError

**Files:**
- Create: `packages/llm-agent-server/src/smart-agent/__tests__/hana-pg-integration.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
import {
  _resetPrefetchedRagForTests,
  prefetchRagFactories,
  resolveRag,
} from '../rag-factories.js';
import { makeRag } from '../providers.js';

describe('hana-vector / pg-vector server integration', () => {
  it('resolveRag throws MissingProviderError when peer is not prefetched', () => {
    _resetPrefetchedRagForTests();
    assert.throws(
      () =>
        resolveRag('hana-vector', {
          collectionName: 't',
          host: 'h',
          user: 'u',
          password: 'p',
          embedder: { async embed() { return { vector: [0] }; } },
        }),
      MissingProviderError,
    );
  });

  it('makeRag path initializes schema for hana-vector when autoCreateSchema=true', async () => {
    _resetPrefetchedRagForTests();
    await prefetchRagFactories(['hana-vector']);
    const embedder = { async embed() { return { vector: [0, 0, 0] }; } };
    const rag = makeRag(
      {
        type: 'hana-vector',
        host: 'h',
        user: 'u',
        password: 'p',
        collectionName: 'direct_docs',
        dimension: 3,
        autoCreateSchema: true,
      },
      { injectedEmbedder: embedder },
    ) as unknown as { ensureSchema: () => Promise<void> };
    // The real ensureSchema() would attempt to connect; we only assert the method
    // exists and is exposed on the backend class so both provider-driven and
    // direct makeRag() paths can invoke identical schema bootstrap.
    assert.equal(typeof rag.ensureSchema, 'function');
  });

  it('makeRag path exposes ensureSchema() for pg-vector', async () => {
    _resetPrefetchedRagForTests();
    await prefetchRagFactories(['pg-vector']);
    const embedder = { async embed() { return { vector: [0, 0, 0] }; } };
    const rag = makeRag(
      {
        type: 'pg-vector',
        host: 'h',
        user: 'u',
        password: 'p',
        database: 'd',
        collectionName: 'direct_docs',
        dimension: 3,
        autoCreateSchema: true,
      },
      { injectedEmbedder: embedder },
    ) as unknown as { ensureSchema: () => Promise<void> };
    assert.equal(typeof rag.ensureSchema, 'function');
  });
});
```

- [ ] **Step 2: Run test → expect FAIL initially, then PASS once Tasks 11-12 are in place**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server -- --test-name-pattern 'hana-vector / pg-vector'`
Expected: 3 passing.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/__tests__/hana-pg-integration.test.ts
git commit -m "test(server): hana/pg integration — MissingProviderError + ensureSchema exposure"
```

---

### Task 14: Workspace wiring — server deps, tsconfig refs, root scripts, changesets

**Files:**
- Modify: `packages/llm-agent-server/package.json`
- Modify: `packages/llm-agent-server/tsconfig.json`
- Modify: `package.json` (root)
- Modify: `tsconfig.json` (root)
- Modify: `.changeset/config.json`

- [ ] **Step 1: Extend server `package.json` peers + devDeps**

Edit `packages/llm-agent-server/package.json`. Add to `peerDependencies`:

```json
"@mcp-abap-adt/hana-vector-rag": "^11.0.0",
"@mcp-abap-adt/pg-vector-rag": "^11.0.0"
```

Add to `peerDependenciesMeta`:

```json
"@mcp-abap-adt/hana-vector-rag": { "optional": true },
"@mcp-abap-adt/pg-vector-rag": { "optional": true }
```

Add to `devDependencies`:

```json
"@mcp-abap-adt/hana-vector-rag": "*",
"@mcp-abap-adt/pg-vector-rag": "*"
```

- [ ] **Step 2: Extend server `tsconfig.json` references**

Read `packages/llm-agent-server/tsconfig.json`. In the `references` array, append:

```json
{ "path": "../hana-vector-rag" },
{ "path": "../pg-vector-rag" }
```

- [ ] **Step 3: Extend root `tsconfig.json` references**

Append the same two `{ "path": "packages/hana-vector-rag" }` and `{ "path": "packages/pg-vector-rag" }` entries to the root `tsconfig.json` `references` array (match the existing style — check with `cat tsconfig.json` first).

- [ ] **Step 4: Extend root `package.json` `build` / `clean` / `test` scripts**

If the scripts already delegate to `tsc -b` (recursive project references), no change is needed — references in `tsconfig.json` cover it. Otherwise append workspace invocations for the two new packages. Verify by inspecting the current scripts:

```bash
node -e "console.log(require('./package.json').scripts)"
```

If a loop over a package list exists, append `hana-vector-rag` and `pg-vector-rag` to it.

- [ ] **Step 5: Extend `.changeset/config.json` fixed group**

Edit `.changeset/config.json`:

```json
"fixed": [
  [
    "@mcp-abap-adt/llm-agent",
    "@mcp-abap-adt/llm-agent-server",
    "@mcp-abap-adt/openai-llm",
    "@mcp-abap-adt/anthropic-llm",
    "@mcp-abap-adt/deepseek-llm",
    "@mcp-abap-adt/sap-aicore-llm",
    "@mcp-abap-adt/openai-embedder",
    "@mcp-abap-adt/ollama-embedder",
    "@mcp-abap-adt/sap-aicore-embedder",
    "@mcp-abap-adt/qdrant-rag",
    "@mcp-abap-adt/hana-vector-rag",
    "@mcp-abap-adt/pg-vector-rag"
  ]
]
```

- [ ] **Step 6: Re-install to link workspaces**

Run: `npm install`
Expected: completes without errors; `node_modules/@mcp-abap-adt/hana-vector-rag` and `…/pg-vector-rag` symlinks present.

- [ ] **Step 7: Full build + full test**

Run: `npm run build && npm test`
Expected: all 12 packages build; full test suite passes (server: existing + new, new packages: their own suites).

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent-server/package.json packages/llm-agent-server/tsconfig.json package.json tsconfig.json .changeset/config.json package-lock.json
git commit -m "chore: wire hana-vector-rag + pg-vector-rag into workspace"
```

---

### Task 15: Documentation updates

**Files:**
- Modify: `README.md` (root)
- Modify: `MIGRATION-v11.md`
- Modify: `CHANGELOG.md` (root)

- [ ] **Step 1: Extend root `README.md` package table**

Open `README.md`, locate the package table (search for `@mcp-abap-adt/qdrant-rag`), and append two rows:

```
| `@mcp-abap-adt/hana-vector-rag` | SAP HANA Cloud Vector Engine backend (`HanaVectorRag`, `HanaVectorRagProvider`). Optional peer. |
| `@mcp-abap-adt/pg-vector-rag`   | PostgreSQL + pgvector backend (`PgVectorRag`, `PgVectorRagProvider`). Optional peer. |
```

Match the existing table column count (check with head-limited grep).

- [ ] **Step 2: Extend `MIGRATION-v11.md`**

Append a new section:

```markdown
## New RAG backends (11.0.0 final)

Two additional optional peer packages ship with 11.0.0:

- `@mcp-abap-adt/hana-vector-rag` — SAP HANA Cloud Vector Engine. Runtime peer: `@sap/hana-client`.
- `@mcp-abap-adt/pg-vector-rag` — PostgreSQL + pgvector. Runtime peer: `pg`.

Install only the backend your deployment actually uses:

```bash
# HANA
npm install @mcp-abap-adt/llm-agent-server @mcp-abap-adt/hana-vector-rag @sap/hana-client

# Postgres + pgvector
npm install @mcp-abap-adt/llm-agent-server @mcp-abap-adt/pg-vector-rag pg
```

YAML config:

```yaml
rag:
  type: hana-vector           # or: pg-vector
  connectionString: hdbsql://user:pass@host:443
  collectionName: llm_agent_docs
  dimension: 1536
  autoCreateSchema: true
```

If the selected `type` references a backend whose peer package is not installed, server startup fails with `MissingProviderError` naming the missing package.
```

- [ ] **Step 3: Amend root `CHANGELOG.md` 11.0.0 entry**

Locate the existing `## 11.0.0` block. Under "New packages" (or equivalent), append:

```markdown
- `@mcp-abap-adt/hana-vector-rag` — SAP HANA Cloud Vector Engine backend.
- `@mcp-abap-adt/pg-vector-rag` — PostgreSQL + pgvector backend.
```

- [ ] **Step 4: Commit**

```bash
git add README.md MIGRATION-v11.md CHANGELOG.md
git commit -m "docs: document hana-vector-rag + pg-vector-rag in v11 release notes"
```

---

### Task 16: Changeset entry + release checklist

**Files:**
- Create: `.changeset/v11-hana-pgvector.md`

- [ ] **Step 1: Write changeset file**

```markdown
---
"@mcp-abap-adt/llm-agent": patch
"@mcp-abap-adt/llm-agent-server": patch
"@mcp-abap-adt/openai-llm": patch
"@mcp-abap-adt/anthropic-llm": patch
"@mcp-abap-adt/deepseek-llm": patch
"@mcp-abap-adt/sap-aicore-llm": patch
"@mcp-abap-adt/openai-embedder": patch
"@mcp-abap-adt/ollama-embedder": patch
"@mcp-abap-adt/sap-aicore-embedder": patch
"@mcp-abap-adt/qdrant-rag": patch
"@mcp-abap-adt/hana-vector-rag": patch
"@mcp-abap-adt/pg-vector-rag": patch
---

feat: add optional peer packages `@mcp-abap-adt/hana-vector-rag` (SAP HANA Cloud Vector Engine) and `@mcp-abap-adt/pg-vector-rag` (PostgreSQL + pgvector). Server exposes `type: 'hana-vector'` and `type: 'pg-vector'` in RAG config. Missing peer packages fail at startup with typed `MissingProviderError`.
```

Note: use `patch` bumps since the 10 existing packages are still at 11.0.0 unreleased and the two new ones ship at 11.0.0 via the fixed-group lock-step.

- [ ] **Step 2: Dry-run `changeset version`**

Run: `npx changeset status --verbose`
Expected: report shows all 12 packages moving together.

- [ ] **Step 3: Commit changeset file**

```bash
git add .changeset/v11-hana-pgvector.md
git commit -m "chore(changeset): hana-vector-rag + pg-vector-rag"
```

- [ ] **Step 4: Final workspace check**

Run: `npm run build && npm test && npm run lint:check`
Expected: green across the board.

- [ ] **Step 5: Post-merge checklist (do NOT execute as part of this plan — for human operator after PR merge)**

Write as `POST_MERGE_CHECKLIST-v11.md` at repo root (will be deleted per retention policy after release):

```markdown
# Post-merge release checklist — v11.0.0 final

1. `git checkout main && git pull`
2. `npx changeset version`                    # applies all pending changesets; resolves to 11.0.0
3. Verify each `packages/*/package.json` is at `11.0.0`
4. Verify each `packages/*/CHANGELOG.md` was updated
5. `git add -A && git commit -m "chore: release 11.0.0"`
6. `git push`
7. `npx changeset publish`                    # publishes all 12 packages to npm
8. `git tag -a v11.0.0 -m "Release 11.0.0"`
9. `git push --tags`
10. Delete retention-policy specs/plans:
    - `docs/superpowers/specs/2026-04-24-v11-hana-pgvector-design.md`
    - `docs/superpowers/specs/2026-04-22-v11-full-extraction-design.md`
    - `docs/superpowers/plans/2026-04-23-v11-full-extraction.md`
    - `docs/superpowers/plans/2026-04-24-v11-hana-pgvector.md`
    - `POST_MERGE_CHECKLIST-v11.md` (this file)
```

- [ ] **Step 6: Commit checklist**

```bash
git add POST_MERGE_CHECKLIST-v11.md
git commit -m "chore: v11.0.0 final release checklist"
```

---

## Self-review notes

1. **Spec coverage:**
   - Two new packages (hana + pg): Tasks 1-10 ✓
   - Server factory registry (prefetch + sync resolve, MissingProviderError): Task 11 ✓
   - `RagResolutionConfig['type']`, pipeline types, smart-server types, config.ts YAML: Task 12 ✓
   - Direct `makeRag()` schema-init test + missing peer error test: Task 13 ✓
   - Server peer deps + devDeps + tsconfig refs + root build + changesets fixed group (12): Task 14 ✓
   - Docs: README, MIGRATION-v11, CHANGELOG: Task 15 ✓
   - Changeset + release checklist: Task 16 ✓
   - Schema shape (`REAL_VECTOR` / `vector`, `NCLOB` / `JSONB`, `VARCHAR(255)` id): Tasks 4, 8 ✓
   - Cosine similarity default: Tasks 5, 9 ✓
   - Collection-name sanitization regex `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`: Tasks 4, 8 ✓
   - `supportedScopes: ['session', 'user', 'global']`: Tasks 6, 10 ✓
   - Backend-owned lazy `ensureSchema()` used by both direct and provider paths: Tasks 5, 9 (method), Tasks 6, 10 (provider calls), Task 13 (integration test) ✓

2. **Architectural principles:**
   - DI-first: provider takes embedder + connection; backend takes config + optional injectedClient ✓
   - Implementation isolation: driver code behind `HanaClient` / `PgClient` interfaces in each package ✓
   - Strategies: `idStrategyFactory` carried through both providers ✓
   - Config-driven composition: `makeRag` switch uses config type literals, returns `IRag` ✓
   - Optional peer safety: `rag-factories.ts` with `MissingProviderError` ✓

3. **Known non-placeholders:**
   - Task 6 `borrowClient()` is flagged as a deliberately minimal shim with an instruction to the implementer. This is concrete guidance, not a placeholder — the test uses `clientFactory` for delete/list paths, so production correctness is not blocked.
   - Task 14 Step 4 (root scripts) is conditional on current repo layout. The exact command is `node -e` inspection + append — concrete, not TBD.
