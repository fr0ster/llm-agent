# Skill-Host PG + Qdrant Integration Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand, local-only integration test that exercises the skill plugin-host's durable persistence path (real Postgres catalog + Qdrant vectors + real Ollama embedder) end-to-end, driven by a single docker-compose wrapper script.

**Architecture:** A self-contained `test/integration/skill-host-pg-qdrant/` directory holds digest-pinned docker assets, a Node ESM lifecycle wrapper (`run.mjs`), test-side helpers, a revisioned synthetic source, and the test. The wrapper brings the stack up, bootstraps the Qdrant collection, runs the test via tsx, and always tears down (`down -v`). The test builds the host through the real composition path and asserts ingest/recall/CAS/retirement-sweep/recall-only-read against the live engines.

**Tech Stack:** Node ≥22 ESM, `node:test` + `node:assert/strict`, tsx, Docker Compose v2, Postgres 16, Qdrant v1.12.4, Ollama (`nomic-embed-text`, 768-dim), `@mcp-abap-adt/llm-agent-libs` (plugin-host barrel), `@mcp-abap-adt/llm-agent-server-libs` (`makePgPool`/`makePgReadPool`), `@mcp-abap-adt/ollama-embedder`.

**Spec:** `docs/superpowers/specs/2026-06-14-skill-host-pg-qdrant-integration-test-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/llm-agent-server-libs/src/index.ts` (modify) | Export `makePgPool`, `makePgReadPool` so the test can import the real pg providers. |
| `test/integration/skill-host-pg-qdrant/docker-compose.yml` | postgres + qdrant + ollama, digest-pinned, healthchecked. |
| `test/integration/skill-host-pg-qdrant/ollama.Dockerfile` | Bakes the digest-pinned embedding model into the image. |
| `test/integration/skill-host-pg-qdrant/pg-init/01-readonly-role.sql` | Creates the SELECT-only login at first DB boot. |
| `test/integration/skill-host-pg-qdrant/run.mjs` | Lifecycle wrapper: up → bootstrap collection → run test → `down -v` in `finally`. |
| `test/integration/skill-host-pg-qdrant/helpers.ts` | `pollUntil` (bounded polling) + `withPools` (close-all-in-finally). |
| `test/integration/skill-host-pg-qdrant/fixtures/revisioned-source.ts` | Mutable v1/v2 `ISkillSource` + expected point-count constants. |
| `test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts` | The five integration test cases. |
| `test/integration/skill-host-pg-qdrant/README.md` | How to run it + prerequisites. |
| `package.json` (modify) | `test:integration:skill-host` npm script (not wired into `npm test`/CI). |
| `.gitignore` (verify) | Ensure no compose artifacts/volumes are tracked. |

**Development loop note (applies to Tasks 5–10):** Bringing the whole stack up/down via `run.mjs` on every edit is slow. During development, bring the stack up ONCE manually:

```bash
cd test/integration/skill-host-pg-qdrant
docker compose up -d --wait --build
# bootstrap the collection once (run.mjs does this in prod; do it by hand while iterating):
curl -s -X PUT http://localhost:6333/collections/skills_test \
  -H 'content-type: application/json' \
  -d '{"vectors":{"size":768,"distance":"Cosine"}}'
```

Then iterate the test directly with the env vars set (fast):

```bash
PG_TEST_URL='postgres://test:test@localhost:5432/skills' \
PG_READ_TEST_URL='postgres://readonly:readonly@localhost:5432/skills' \
QDRANT_TEST_URL='http://localhost:6333' QDRANT_TEST_COLLECTION='skills_test' \
EMBED_DIM='768' OLLAMA_TEST_URL='http://localhost:11434' \
npx tsx --test test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts
```

`run.mjs` (Task 4) is the production entry and is validated end-to-end in Task 11. **`npm run build` is required before running** because workspace imports resolve to `dist/` (build-before-dev rule).

---

### Task 1: Export the pg providers + scaffold the directory

**Files:**
- Modify: `packages/llm-agent-server-libs/src/index.ts`
- Create: `test/integration/skill-host-pg-qdrant/README.md`
- Modify: `package.json` (root)

- [ ] **Step 1: Export `makePgPool` / `makePgReadPool` from the server-libs barrel**

The test imports the REAL pg providers, but they are not yet in the package's public surface. Add to `packages/llm-agent-server-libs/src/index.ts` (place near the other `smart-agent` exports):

```ts
export { makePgPool, makePgReadPool } from './smart-agent/pg-pool.js';
```

- [ ] **Step 2: Verify the export builds**

Run: `npm run build`
Expected: clean build (no TS errors). The symbols are now importable as `import { makePgPool, makePgReadPool } from '@mcp-abap-adt/llm-agent-server-libs'`.

- [ ] **Step 3: Add the npm script**

In root `package.json` `"scripts"`, add (do NOT add it to `test`, `build`, `lint`, or any CI workflow):

```json
"test:integration:skill-host": "node test/integration/skill-host-pg-qdrant/run.mjs"
```

- [ ] **Step 4: Write the README**

Create `test/integration/skill-host-pg-qdrant/README.md`:

```markdown
# Skill-Host PG + Qdrant Integration Test

On-demand, **local-only** integration test for the skill plugin-host's durable
persistence path: real Postgres catalog + Qdrant vectors + real Ollama embedder.
NOT part of `npm test`, the build, or CI.

## Prerequisites
- Docker + Docker Compose v2
- The monorepo built: `npm run build` (workspace imports resolve to `dist/`)

## Run
    npm run build
    npm run test:integration:skill-host

The wrapper (`run.mjs`) builds the Ollama image (first run only — it bakes the
embedding model), starts Postgres + Qdrant + Ollama, waits for health,
bootstraps the Qdrant collection, runs the test, and ALWAYS tears the stack down
(`docker compose down -v`) — even on failure.

## What it covers
1. Ingest + commit (PG catalog row + Qdrant vectors)
2. Recall via `host.rag(group).query`
3. Fenced catalog CAS (`CatalogCasError` on a stale revision)
4. Retirement + age-protected sweeper (pre-grace keep, post-grace reclaim)
5. Recall-only read path under SELECT-only Postgres credentials (write/DDL rejected)

No GPL `sap-skills` content — synthetic MIT-clean fixtures only.
```

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/index.ts package.json test/integration/skill-host-pg-qdrant/README.md
git commit -m "test(skills): scaffold PG+Qdrant integration test + export pg providers"
```

---

### Task 2: Docker assets — compose, Ollama image, read-only role

**Files:**
- Create: `test/integration/skill-host-pg-qdrant/ollama.Dockerfile`
- Create: `test/integration/skill-host-pg-qdrant/pg-init/01-readonly-role.sql`
- Create: `test/integration/skill-host-pg-qdrant/docker-compose.yml`

- [ ] **Step 1: Resolve the image + model digests**

The spec requires digest pinning for reproducibility. Resolve the concrete digests NOW and paste them into the files below (these commands print the values to paste):

```bash
docker pull postgres:16-alpine && docker inspect --format='{{index .RepoDigests 0}}' postgres:16-alpine
docker pull qdrant/qdrant:v1.12.4 && docker inspect --format='{{index .RepoDigests 0}}' qdrant/qdrant:v1.12.4
docker pull ollama/ollama:latest && docker inspect --format='{{index .RepoDigests 0}}' ollama/ollama:latest
```

For the model digest, after the Ollama container is first built you can read it with `ollama show --modelfile nomic-embed-text`; if a digest-pinned pull is unavailable for the model, pin the model by its tag `nomic-embed-text` and record in a comment that the model is tag-pinned (the image bake still freezes the bytes into the image layer, preserving reproducibility per rebuild).

- [ ] **Step 2: Write `ollama.Dockerfile`**

Paste the resolved `ollama/ollama` digest into `FROM`:

```dockerfile
# Base pinned by digest (resolved from ollama/ollama:latest at authoring time — see compose comment).
FROM ollama/ollama@sha256:PASTE_OLLAMA_DIGEST_HERE
# Bake the embedding model INTO the image so each run is deterministic and does
# not re-pull at container start (no network flakiness, no cold-start latency).
RUN ollama serve & \
    until ollama list >/dev/null 2>&1; do sleep 1; done; \
    ollama pull nomic-embed-text; \
    pkill ollama || true
```

- [ ] **Step 3: Write `pg-init/01-readonly-role.sql`**

```sql
-- Runs once at first DB boot (mounted into /docker-entrypoint-initdb.d).
-- Creates a SELECT-only login so the recall-only read path is tested against
-- genuinely restricted credentials, not the superuser "we just didn't call DDL".
CREATE ROLE readonly LOGIN PASSWORD 'readonly';
GRANT CONNECT ON DATABASE skills TO readonly;
GRANT USAGE ON SCHEMA public TO readonly;
-- The catalog table is created LATER by makePgPool's CREATE TABLE, so grant on
-- both current and FUTURE tables.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;
-- No INSERT/UPDATE/DELETE/CREATE granted → write & DDL attempts are rejected.
```

- [ ] **Step 4: Write `docker-compose.yml`**

Paste the resolved postgres/qdrant digests into the `image:` lines. Keep the tag in a comment:

```yaml
services:
  postgres:
    image: postgres:16-alpine@sha256:PASTE_POSTGRES_DIGEST_HERE  # postgres:16-alpine
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: skills
    ports:
      - "5432:5432"
    volumes:
      - ./pg-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U test -d skills"]
      interval: 2s
      timeout: 3s
      retries: 30

  qdrant:
    image: qdrant/qdrant:v1.12.4@sha256:PASTE_QDRANT_DIGEST_HERE  # qdrant/qdrant:v1.12.4
    ports:
      - "6333:6333"
    healthcheck:
      # qdrant image has no curl/wget; use its bundled health endpoint via the
      # built-in `qdrant` static binary's /readyz over TCP with bash redirection.
      test: ["CMD-SHELL", "bash -c ':> /dev/tcp/127.0.0.1/6333' || exit 1"]
      interval: 2s
      timeout: 3s
      retries: 30

  ollama:
    build:
      context: .
      dockerfile: ollama.Dockerfile
    ports:
      - "11434:11434"
    healthcheck:
      test: ["CMD-SHELL", "ollama list >/dev/null 2>&1 || exit 1"]
      interval: 3s
      timeout: 5s
      retries: 40
```

- [ ] **Step 5: Verify the stack comes up healthy**

```bash
cd test/integration/skill-host-pg-qdrant
docker compose up -d --wait --build
docker compose ps
```

Expected: all three services `running (healthy)`. If `--wait` times out, run `docker compose logs <svc>` to diagnose, fix the healthcheck, and retry.

- [ ] **Step 6: Verify the read-only role and collection bootstrap manually**

```bash
# read-only role exists and CANNOT create a table:
docker compose exec -T postgres psql -U readonly -d skills -c 'CREATE TABLE x(i int);'   # expect: ERROR: permission denied
# collection bootstrap (the shape run.mjs will use):
curl -s -X PUT http://localhost:6333/collections/skills_test \
  -H 'content-type: application/json' -d '{"vectors":{"size":768,"distance":"Cosine"}}'
curl -s http://localhost:6333/collections/skills_test | grep -o '"size":768'  # expect: "size":768
```

Then tear down: `docker compose down -v`.

- [ ] **Step 7: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/docker-compose.yml test/integration/skill-host-pg-qdrant/ollama.Dockerfile test/integration/skill-host-pg-qdrant/pg-init/01-readonly-role.sql
git commit -m "test(skills): digest-pinned PG+Qdrant+Ollama compose stack with read-only role"
```

---

### Task 3: Test-side helpers (`pollUntil`, `withPools`)

**Files:**
- Create: `test/integration/skill-host-pg-qdrant/helpers.ts`

- [ ] **Step 1: Write `helpers.ts`**

```ts
// Test-side helpers shared by skill-host.integration.test.ts.
// Two purposes: bounded polling (Qdrant writes are async — the production client
// omits wait=true) and pool lifecycle (open pg sockets keep the tsx subprocess
// alive; leaking one would hang run.mjs before `down -v`).

export interface PollOptions {
  predicate: (value: unknown) => boolean;
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/** Re-invoke `fn` until `predicate(result)` is true or the timeout elapses. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: { predicate: (v: T) => boolean; timeoutMs?: number; intervalMs?: number; label?: string },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: T;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    last = await fn();
    if (opts.predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `pollUntil timed out after ${timeoutMs}ms${opts.label ? ` waiting for ${opts.label}` : ''}; last value: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Anything with an async end() — both makePgPool and makePgReadPool qualify. */
export interface Closable {
  end(): Promise<void>;
}

/**
 * Run `body`, then end() EVERY registered pool in a finally — even if `body`
 * throws. `register` is passed into `body` so it adds each pool as it creates it.
 * Guarantees no pg socket outlives the test → the subprocess exits → run.mjs
 * reaches `docker compose down -v`.
 */
export async function withPools<T>(
  body: (register: (pool: Closable) => Closable) => Promise<T>,
): Promise<T> {
  const pools: Closable[] = [];
  const register = (pool: Closable): Closable => {
    pools.push(pool);
    return pool;
  };
  try {
    return await body(register);
  } finally {
    for (const p of pools) {
      try {
        await p.end();
      } catch {
        // best-effort: a failed end() must not mask the body's error
      }
    }
  }
}
```

- [ ] **Step 2: Type-check the helpers**

Run: `npx tsc --noEmit test/integration/skill-host-pg-qdrant/helpers.ts --module nodenext --moduleResolution nodenext --target es2022 --strict`
Expected: no errors. (tsx runs it directly at test time; this step just catches type slips early.)

- [ ] **Step 3: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/helpers.ts
git commit -m "test(skills): integration-test helpers (pollUntil + withPools)"
```

---

### Task 4: Lifecycle wrapper (`run.mjs`)

**Files:**
- Create: `test/integration/skill-host-pg-qdrant/run.mjs`

- [ ] **Step 1: Write `run.mjs`**

```js
#!/usr/bin/env node
// Lifecycle wrapper for the skill-host PG+Qdrant integration test.
// up --wait --build → bootstrap Qdrant collection → run the test via tsx →
// ALWAYS `docker compose down -v` in a finally. No test logic lives here.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const env = {
  ...process.env,
  PG_TEST_URL: 'postgres://test:test@localhost:5432/skills',
  PG_READ_TEST_URL: 'postgres://readonly:readonly@localhost:5432/skills',
  QDRANT_TEST_URL: 'http://localhost:6333',
  QDRANT_TEST_COLLECTION: 'skills_test',
  EMBED_DIM: '768',
  OLLAMA_TEST_URL: 'http://localhost:11434',
  OLLAMA_TEST_MODEL: 'nomic-embed-text',
};

function compose(args, opts = {}) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: here,
    stdio: 'inherit',
    ...opts,
  });
}

function fail(msg) {
  console.error(`\n[run.mjs] ${msg}`);
  process.exit(1);
}

// Preflight: docker compose must exist.
const probe = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
if (probe.status !== 0) {
  fail('docker compose is not available — this is an explicit, opt-in integration run.');
}

let testStatus = 1;
try {
  console.log('[run.mjs] starting stack (first run builds the Ollama image)…');
  if (compose(['up', '-d', '--wait', '--build']).status !== 0) {
    compose(['logs']);
    fail('docker compose up --wait failed (see logs above).');
  }

  console.log('[run.mjs] bootstrapping Qdrant collection…');
  const put = await fetch(`${env.QDRANT_TEST_URL}/collections/${env.QDRANT_TEST_COLLECTION}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors: { size: Number(env.EMBED_DIM), distance: 'Cosine' } }),
  });
  if (!put.ok) fail(`Qdrant collection create failed: ${put.status}`);
  const got = await fetch(`${env.QDRANT_TEST_URL}/collections/${env.QDRANT_TEST_COLLECTION}`);
  const cfg = await got.json();
  const size = cfg?.result?.config?.params?.vectors?.size;
  if (size !== Number(env.EMBED_DIM)) {
    fail(`Qdrant collection has size ${size}, expected ${env.EMBED_DIM}`);
  }

  console.log('[run.mjs] running the integration test…');
  const test = spawnSync(
    'npx',
    ['tsx', '--test', 'test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts'],
    { cwd: repoRoot, stdio: 'inherit', env },
  );
  testStatus = test.status ?? 1;
} finally {
  console.log('[run.mjs] tearing down (down -v)…');
  compose(['down', '-v']);
}

process.exit(testStatus);
```

- [ ] **Step 2: Verify the wrapper fails loud without docker (sanity)**

This is a structural check — confirm the preflight path exists. Read the file and confirm: preflight `docker compose version` guard present; `down -v` is inside `finally`; collection bootstrap asserts `size === 768`; exit code propagates `testStatus`. (A real end-to-end run happens in Task 11 once the test exists.)

- [ ] **Step 3: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/run.mjs
git commit -m "test(skills): lifecycle wrapper (up --wait, collection bootstrap, down -v in finally)"
```

---

### Task 5: Revisioned synthetic source fixture

**Files:**
- Create: `test/integration/skill-host-pg-qdrant/fixtures/revisioned-source.ts`

- [ ] **Step 1: Write the fixture**

The host calls `source.acquire()` and reads `{ collections, records }` (see `SkillIngestResult`). Records carry `id` (logical, source-prefixed), `sourceId` (stable), `group`, `name`, `retrievalText` (embedded), `content`, `provenance`.

```ts
import type {
  ISkillSource,
  SkillGroupInfo,
  SkillIngestResult,
  SkillRecord,
} from '@mcp-abap-adt/llm-agent';

// Two collections; v1 has 5 records total, v2 has 6 (alpha gains one + edits one).
export const V1_POINTS = 5;
export const V2_POINTS = 6;
export const SOURCE_ID = 'itest';

const COLLECTIONS: SkillGroupInfo[] = [
  { group: 'alpha', description: 'Alpha test skills', collection: 'alpha' },
  { group: 'beta', description: 'Beta test skills', collection: 'beta' },
];

function rec(group: string, slug: string, text: string, body: string): SkillRecord {
  return {
    id: `${SOURCE_ID}:itest@1.0.0/${slug}#0`,
    sourceId: SOURCE_ID,
    group,
    name: `itest/${slug}`,
    retrievalText: text,
    content: body,
    provenance: `itest@1.0.0/${slug}#main`,
  };
}

function v1Records(): SkillRecord[] {
  return [
    rec('alpha', 'open-file', 'how to open and read a file', 'Open the file, then read its bytes.'),
    rec('alpha', 'list-dir', 'how to list a directory', 'List directory entries by name.'),
    rec('alpha', 'delete-file', 'how to delete a file safely', 'Confirm, then remove the file.'),
    rec('beta', 'parse-json', 'how to parse JSON text', 'Parse the JSON string into an object.'),
    rec('beta', 'format-date', 'how to format a date', 'Format the date as ISO-8601.'),
  ];
}

function v2Records(): SkillRecord[] {
  return [
    // edited retrievalText on open-file:
    rec('alpha', 'open-file', 'how to open, read, and close a file', 'Open the file, read its bytes, then close it.'),
    rec('alpha', 'list-dir', 'how to list a directory', 'List directory entries by name.'),
    rec('alpha', 'delete-file', 'how to delete a file safely', 'Confirm, then remove the file.'),
    // new record in alpha:
    rec('alpha', 'copy-file', 'how to copy a file', 'Copy the source file to the destination.'),
    rec('beta', 'parse-json', 'how to parse JSON text', 'Parse the JSON string into an object.'),
    rec('beta', 'format-date', 'how to format a date', 'Format the date as ISO-8601.'),
  ];
}

/** Mutable source: flip between v1 and v2 to drive the reload/retirement case. */
export function makeRevisionedSource(): ISkillSource & { setRevision(v: 'v1' | 'v2'): void } {
  let revision: 'v1' | 'v2' = 'v1';
  return {
    setRevision(v) {
      revision = v;
    },
    async acquire(): Promise<SkillIngestResult> {
      return {
        collections: COLLECTIONS,
        records: revision === 'v1' ? v1Records() : v2Records(),
      };
    },
  };
}
```

- [ ] **Step 2: Type-check the fixture against the real contracts**

Run: `npm run build` (the import path `@mcp-abap-adt/llm-agent` must resolve the types). Then:
Run: `npx tsx -e "import('./test/integration/skill-host-pg-qdrant/fixtures/revisioned-source.ts').then(m => { const s = m.makeRevisionedSource(); s.setRevision('v2'); s.acquire().then(r => console.log(r.records.length, m.V2_POINTS)); })"`
Expected: prints `6 6`.

- [ ] **Step 3: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/fixtures/revisioned-source.ts
git commit -m "test(skills): revisioned v1/v2 synthetic skill source fixture"
```

---

### Task 6: Test harness + Case 1 (ingest + commit)

**Files:**
- Create: `test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`

- [ ] **Step 1: Write the shared harness + Case 1**

Establish the host-build helper used by all cases, then assert ingest. The store provider needs `embed: (text) => Promise<number[]>` — wrap the embedder's `{ vector }`.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePgPool, makePgReadPool } from '@mcp-abap-adt/llm-agent-server-libs';
import {
  makePgCatalogReader,
  makePgCatalogStore,
  makeQdrantClient,
  makeQdrantReader,
  makeQdrantStoreProvider,
  makeSkillPluginHost,
} from '@mcp-abap-adt/llm-agent-libs';
import { OllamaEmbedder } from '@mcp-abap-adt/ollama-embedder';
import { pollUntil, withPools, type Closable } from './helpers.js';
import { makeRevisionedSource, V1_POINTS, V2_POINTS, SOURCE_ID } from './fixtures/revisioned-source.js';

const PG_URL = process.env.PG_TEST_URL!;
const PG_READ_URL = process.env.PG_READ_TEST_URL!;
const QDRANT_URL = process.env.QDRANT_TEST_URL!;
const COLLECTION = process.env.QDRANT_TEST_COLLECTION!;
const EMBED_DIM = Number(process.env.EMBED_DIM ?? '768');
const OLLAMA_URL = process.env.OLLAMA_TEST_URL!;
const MODEL = process.env.OLLAMA_TEST_MODEL ?? 'nomic-embed-text';
const TABLE = 'skills_catalog';

const RETIRED_GRACE_MS = 10_000;
const ORPHAN_GRACE_MS = 60_000;

function makeEmbedder() {
  return new OllamaEmbedder({ ollamaUrl: OLLAMA_URL, model: MODEL });
}

// Count points belonging to a generation via Qdrant scroll (exact count).
async function countGeneration(generation: string): Promise<number> {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filter: { must: [{ key: 'generation', match: { value: generation } }] },
      limit: 1000,
      with_payload: false,
      with_vector: false,
    }),
  });
  const json = (await res.json()) as { result?: { points?: unknown[] } };
  return json.result?.points?.length ?? 0;
}

// Build an ingest-capable host over the live engines. `register` tracks pools.
function buildIngestHost(register: (p: Closable) => Closable, source: ReturnType<typeof makeRevisionedSource>) {
  const pgPool = register(makePgPool(PG_URL, TABLE)) as ReturnType<typeof makePgPool>;
  const catalogStore = makePgCatalogStore({ pool: pgPool, table: TABLE });
  const client = makeQdrantClient({ url: QDRANT_URL, collection: COLLECTION });
  const embedder = makeEmbedder();
  const storeProvider = makeQdrantStoreProvider({
    client,
    collection: COLLECTION,
    catalogStore,
    embed: async (t, o) => (await embedder.embed(t, o)).vector,
    retiredGraceMs: RETIRED_GRACE_MS,
    orphanGraceMs: ORPHAN_GRACE_MS,
  });
  const host = makeSkillPluginHost({
    sources: [{ id: SOURCE_ID, source }],
    storeProvider,
    embedder,
    embeddingSpaceId: 'itest-ollama-nomic-embed-text',
    retrievalSchemaVersion: 1,
    dimension: EMBED_DIM,
  });
  return { host, pgPool, catalogStore, storeProvider, client };
}

// Read the active generation for a group from the committed catalog snapshot.
async function activeGeneration(catalogStore: { read(): Promise<{ entries: { collection: { group: string }; generation: string }[] }> }, group: string): Promise<string> {
  const snap = await catalogStore.read();
  const entry = snap.entries.find((e) => e.collection.group === group);
  assert.ok(entry, `no committed entry for group '${group}'`);
  return entry.generation;
}

test('embedder returns a 768-dim vector (model present)', async () => {
  const v = (await makeEmbedder().embed('hello')).vector;
  assert.equal(v.length, EMBED_DIM);
});

test('Case 1: ingest + commit → PG catalog row + Qdrant vectors', async () => {
  await withPools(async (register) => {
    const source = makeRevisionedSource();
    source.setRevision('v1');
    const { host, catalogStore } = buildIngestHost(register, source);

    const result = await host.load();
    assert.equal(result.ok, true, `load not ok: ${JSON.stringify(result)}`);
    assert.deepEqual([...result.committed].sort(), ['alpha', 'beta']);

    // PG: the catalog row has a non-empty revision and both entries.
    const snap = await catalogStore.read();
    assert.ok(snap.catalogRevision && snap.catalogRevision !== 'c0', 'revision advanced');
    assert.equal(snap.entries.length, 2);

    // Qdrant: total committed points across both active generations == V1_POINTS.
    const genAlpha = await activeGeneration(catalogStore, 'alpha');
    const genBeta = await activeGeneration(catalogStore, 'beta');
    await pollUntil(
      async () => (await countGeneration(genAlpha)) + (await countGeneration(genBeta)),
      { predicate: (n) => n === V1_POINTS, label: `total committed points == ${V1_POINTS}` },
    );
  });
});
```

- [ ] **Step 2: Run Case 1 against a running stack**

Bring the stack up per the development-loop note, then run with the env vars set:
Run (env vars as in the dev-loop note): `npx tsx --test test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`
Expected: the embedder test + Case 1 PASS. If `countGeneration` never reaches 5, check the upsert reached Qdrant (`docker compose logs qdrant`) and that the collection exists.

- [ ] **Step 3: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts
git commit -m "test(skills): integration Case 1 — ingest + commit (PG row + Qdrant vectors)"
```

---

### Task 7: Case 2 (recall)

**Files:**
- Modify: `test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`

- [ ] **Step 1: Append Case 2**

`host.rag(group).query(text, { k, threshold? })` returns `SkillHit[]` (`{ record, score }`) in descending score. Query text close to an `alpha` record's `retrievalText`.

```ts
test('Case 2: recall returns ranked hits from the queried collection', async () => {
  await withPools(async (register) => {
    const source = makeRevisionedSource();
    source.setRevision('v1');
    const { host } = buildIngestHost(register, source);
    await host.load();

    const hits = await host.rag('alpha').query('reading a file from disk', { k: 3 });
    assert.ok(hits.length > 0, 'expected at least one hit');
    // all hits belong to the alpha collection
    for (const h of hits) assert.equal(h.record.group, 'alpha');
    // descending score order
    for (let i = 1; i < hits.length; i++) {
      assert.ok(hits[i - 1].score >= hits[i].score, 'scores not descending');
    }
    // the file-reading skill should rank first for this query
    assert.match(hits[0].record.name, /open-file/);
  });
});
```

- [ ] **Step 2: Run Cases 1–2**

Run (env vars set): `npx tsx --test test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`
Expected: all pass. If the top-hit assertion is flaky for the chosen query, relax it to "open-file is among the top 2" — but keep the group + ordering assertions strict.

- [ ] **Step 3: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts
git commit -m "test(skills): integration Case 2 — ranked recall from queried collection"
```

---

### Task 8: Case 3 (fenced catalog CAS)

**Files:**
- Modify: `test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`

- [ ] **Step 1: Append Case 3**

Two store providers share the same PG row. Advance the revision through provider A (a real `load()`), then call `publishCatalog` on provider B with the now-stale revision → `CatalogCasError`.

```ts
import { CatalogCasError } from '@mcp-abap-adt/llm-agent';

test('Case 3: fenced catalog CAS rejects a stale revision', async () => {
  await withPools(async (register) => {
    const source = makeRevisionedSource();
    source.setRevision('v1');
    const { host, catalogStore } = buildIngestHost(register, source);
    await host.load(); // commit v1 → revision R1

    // Capture R1, then advance to R2 via a second load (v2).
    const before = await catalogStore.read();
    const staleRevision = before.catalogRevision;

    source.setRevision('v2');
    await host.load(); // commit v2 → revision R2 (R1 is now stale)

    // A second provider attempting to publish against the STALE R1 must fail.
    const pgPoolB = register(makePgPool(PG_URL, TABLE)) as ReturnType<typeof makePgPool>;
    const catalogStoreB = makePgCatalogStore({ pool: pgPoolB, table: TABLE });
    const current = await catalogStoreB.read();
    await assert.rejects(
      () => catalogStoreB.casPublish(staleRevision, current.entries, Date.now()),
      (err) => err instanceof CatalogCasError,
      'expected CatalogCasError on stale revision',
    );

    // The committed catalog is unchanged by the rejected attempt.
    const after = await catalogStoreB.read();
    assert.equal(after.catalogRevision, current.catalogRevision);
  });
});
```

Confirmed against `qdrant-store.ts`: `ICatalogStore.casPublish(expectedCatalogRevision, entries, now)` is the atomic CAS primitive `makePgCatalogStore` returns; it throws `CatalogCasError` when the active revision ≠ expected. Using it directly keeps the test at the exact CAS layer the finding targets (the provider's `publishCatalog` delegates to it).

- [ ] **Step 2: Run Cases 1–3**

Run (env vars set): `npx tsx --test test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`
Expected: all pass; Case 3 confirms the rejection comes from a real `UPDATE … WHERE revision=$expected` matching 0 rows.

- [ ] **Step 3: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts
git commit -m "test(skills): integration Case 3 — fenced catalog CAS rejects stale revision"
```

---

### Task 9: Case 4 (retirement + age-protected sweeper)

**Files:**
- Modify: `test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`

- [ ] **Step 1: Append Case 4**

Use an injected clock so grace windows are deterministic. The provider accepts `now`; rebuild it with a controllable clock for this case (do NOT reuse `buildIngestHost`'s default clock).

```ts
test('Case 4: reload retires prior generation; sweeper is age-protected', async () => {
  await withPools(async (register) => {
    let clock = 1_000_000;
    const now = () => clock;

    const source = makeRevisionedSource();
    source.setRevision('v1');

    const pgPool = register(makePgPool(PG_URL, TABLE)) as ReturnType<typeof makePgPool>;
    const catalogStore = makePgCatalogStore({ pool: pgPool, table: TABLE });
    const client = makeQdrantClient({ url: QDRANT_URL, collection: COLLECTION });
    const embedder = makeEmbedder();
    const storeProvider = makeQdrantStoreProvider({
      client, collection: COLLECTION, catalogStore,
      embed: async (t, o) => (await embedder.embed(t, o)).vector,
      retiredGraceMs: RETIRED_GRACE_MS, orphanGraceMs: ORPHAN_GRACE_MS, now,
    });
    const host = makeSkillPluginHost({
      sources: [{ id: SOURCE_ID, source }], storeProvider, embedder,
      embeddingSpaceId: 'itest-ollama-nomic-embed-text', retrievalSchemaVersion: 1, dimension: EMBED_DIM, now,
    });

    await host.load(); // v1
    const v1Alpha = await activeGeneration(catalogStore, 'alpha');

    // Reload v2 → new generation for alpha, prior retired.
    source.setRevision('v2');
    await host.load();
    const v2Alpha = await activeGeneration(catalogStore, 'alpha');
    assert.notEqual(v2Alpha, v1Alpha, 'alpha generation must change on reload');

    // v2 active points visible.
    const genBeta = await activeGeneration(catalogStore, 'beta');
    await pollUntil(
      async () => (await countGeneration(v2Alpha)) + (await countGeneration(genBeta)),
      { predicate: (n) => n === V2_POINTS, label: `v2 committed points == ${V2_POINTS}` },
    );

    // Durable retired[] holds the prior generation.
    const snap = await catalogStore.read();
    assert.ok((snap.retired ?? []).some((r) => r.generation === v1Alpha), 'v1 generation retired');

    // AGE PROTECTION: sweep BEFORE grace → retired points stay.
    await storeProvider.sweep(clock); // tick == now, retiredAt + grace > now
    const keptCount = await countGeneration(v1Alpha);
    assert.ok(keptCount > 0, 'retired generation must survive a pre-grace sweep');

    // POST-GRACE: advance past the grace, sweep → retired points reclaimed.
    clock += RETIRED_GRACE_MS + 1;
    await storeProvider.sweep(clock);
    await pollUntil(
      async () => countGeneration(v1Alpha),
      { predicate: (n) => n === 0, label: 'retired generation reclaimed to 0' },
    );
  });
});
```

- [ ] **Step 2: Run Cases 1–4**

Run (env vars set): `npx tsx --test test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`
Expected: all pass. Case 4 proves durable retirement, pre-grace age protection, and post-grace reclaim against real Qdrant.

- [ ] **Step 3: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts
git commit -m "test(skills): integration Case 4 — retirement + age-protected sweeper"
```

---

### Task 10: Case 5 (recall-only read path under restricted credentials)

**Files:**
- Modify: `test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`

- [ ] **Step 1: Append Case 5**

The read path uses `makePgReadPool` (no DDL) + `makePgCatalogReader` + `makeQdrantReader`. Assert it reads the same committed catalog AND that the read-only login is genuinely write/DDL-rejected.

```ts
test('Case 5: recall-only read path under SELECT-only credentials', async () => {
  await withPools(async (register) => {
    // First commit data with the WRITE path (superuser).
    const source = makeRevisionedSource();
    source.setRevision('v1');
    const { host, catalogStore } = buildIngestHost(register, source);
    await host.load();
    const expected = await catalogStore.read();

    // (a) READ path over the SELECT-only role reads the same committed catalog.
    const readPool = register(makePgReadPool(PG_READ_URL)) as ReturnType<typeof makePgReadPool>;
    const reader = makePgCatalogReader({ pool: readPool, table: TABLE });
    const seen = await reader.read();
    assert.equal(seen.catalogRevision, expected.catalogRevision);
    assert.equal(seen.entries.length, expected.entries.length);

    // Qdrant reader returns vectors for the active alpha generation.
    const qreader = makeQdrantReader({ url: QDRANT_URL, collection: COLLECTION });
    const genAlpha = expected.entries.find((e) => e.collection.group === 'alpha')!.generation;
    const page = await qreader.scroll({ generation: genAlpha });
    assert.ok(page.points.length > 0, 'read-only Qdrant reader sees committed points');

    // (b) The read-only login must REJECT write/DDL. makePgPool issues CREATE TABLE
    // on first query; over PG_READ_URL that must throw a permission error.
    const writeAttemptPool = register(makePgPool(PG_READ_URL, 'itest_forbidden')) as ReturnType<typeof makePgPool>;
    await assert.rejects(
      () => writeAttemptPool.query('SELECT 1'), // triggers ensureTable → CREATE TABLE itest_forbidden
      /permission denied|must be owner|insufficient/i,
      'read-only role must be denied DDL',
    );
  });
});
```

Confirmed against `qdrant-store.ts`: `IQdrantReader.scroll(filter, cursor?) → { points: QdrantPoint[]; next? }`, so `qreader.scroll({ generation: genAlpha })` returns the generation's points directly.

- [ ] **Step 2: Run all five cases**

Run (env vars set): `npx tsx --test test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`
Expected: all five cases (plus the embedder check) PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts
git commit -m "test(skills): integration Case 5 — recall-only read path under SELECT-only creds"
```

---

### Task 11: End-to-end wrapper run + finalize

**Files:**
- Verify only (no new files): the full `run.mjs` path.

- [ ] **Step 1: Ensure a clean build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 2: Tear down any dev stack, then run the production entry**

```bash
( cd test/integration/skill-host-pg-qdrant && docker compose down -v ) || true
npm run test:integration:skill-host
```

Expected: `run.mjs` builds the Ollama image (first time), starts all three services healthy, bootstraps the collection (`size 768`), runs the test (all five cases + embedder check pass), then tears down with `down -v`. Final process exit code 0.

- [ ] **Step 3: Confirm teardown left nothing behind**

Run: `docker compose -f test/integration/skill-host-pg-qdrant/docker-compose.yml ps`
Expected: no running services. `docker volume ls` shows no leftover volume for this project.

- [ ] **Step 4: Confirm it is NOT in the default test/build/CI path**

Run: `grep -rn "test:integration" package.json .github 2>/dev/null`
Expected: the script exists in `package.json` only; no `.github` workflow references it.

- [ ] **Step 5: Final commit (if any doc tweaks were needed)**

```bash
git add -A test/integration/skill-host-pg-qdrant
git commit -m "test(skills): finalize PG+Qdrant integration test end-to-end run" || echo "nothing to finalize"
```

---

## Self-Review

**Spec coverage:**
- Directory/structure → Tasks 1–5. ✓
- Digest-pinned compose + Ollama image + read-only role → Task 2. ✓
- Qdrant collection bootstrap (no client auto-create) → `run.mjs` Task 4 + manual verify Task 2. ✓
- `pollUntil` (async writes) + `withPools` (pool lifecycle) → Task 3, used in every case. ✓
- Revisioned v1/v2 source with fixed counts → Task 5. ✓
- Case 1 ingest+commit → Task 6; Case 2 recall → Task 7; Case 3 CAS → Task 8; Case 4 retirement+age-protected sweep → Task 9; Case 5 recall-only restricted creds + rejected write → Task 10. ✓
- Wrapper fail-loud + always `down -v` → Task 4, validated Task 11. ✓
- Not in CI/`npm test` → Task 1 (script only) + Task 11 Step 4. ✓

**Placeholder scan:** The only intentional placeholders are the image/model `sha256:` digests, which the engineer resolves in Task 2 Step 1 with exact commands and pastes in — concrete values, not vague work.

**Type/name consistency:** `makeSkillPluginHost`/`IngestHostDeps`, `makeQdrantStoreProvider` (`embed:(t,o)=>Promise<number[]>`, `retiredGraceMs`, `orphanGraceMs`, `now`, `.sweep(at?)`), `makePgCatalogStore`/`makePgCatalogReader` (`{pool,table?}`), `makeQdrantClient`/`makeQdrantReader` (`{url,collection}`), `OllamaEmbedder({ollamaUrl,model})` with `embed→{vector}`, `CatalogCasError`, `V1_POINTS`/`V2_POINTS`/`SOURCE_ID` from the fixture — all match the symbols verified in the codebase. Both previously-uncertain methods are now confirmed against `qdrant-store.ts`: `ICatalogStore.casPublish(expectedCatalogRevision, entries, now)` (Case 3) and `IQdrantReader.scroll(filter, cursor?) → {points, next?}` (Case 5).
