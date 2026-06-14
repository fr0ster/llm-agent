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
- **POSIX host (Linux / macOS, or WSL).** The wrapper uses a detached process
  group + group kill for its hard timeout; Windows is not supported (it exits
  with a clear message).
- Docker + Docker Compose v2
- The monorepo built: `npm run build` (workspace imports resolve to `dist/`)
- Ports 5432 / 6333 / 11434 free, or override via `PG_TEST_PORT` /
  `QDRANT_TEST_PORT` / `OLLAMA_TEST_PORT` (same vars feed compose AND the URLs).

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

The five cases are ONE ordered scenario (awaited subtests sharing one catalog
row, collection, host and clock) — not independently runnable, by design.

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

For the MODEL digest, use the AUTHORITATIVE, documented source — the `/api/tags` `models[].digest` field (the model's manifest digest), NOT `ollama show --modelfile` (which can surface a per-blob digest). Resolve it once and paste it into `run.mjs` as `EXPECTED_MODEL_DIGEST` (Task 4); the Dockerfile only bakes by tag:

```bash
docker run -d --name ollama_probe ollama/ollama
docker exec ollama_probe sh -c 'until ollama list >/dev/null 2>&1; do sleep 1; done; ollama pull nomic-embed-text >/dev/null'
docker exec ollama_probe sh -c 'wget -qO- 127.0.0.1:11434/api/tags' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).models.find(x=>x.name==="nomic-embed-text:latest");console.log(m?m.digest:"NOT FOUND")})'
docker rm -f ollama_probe
```

Record the printed `sha256:…` value — it is `EXPECTED_MODEL_DIGEST` in `run.mjs`. The same `/api/tags` `digest` field is what `run.mjs` re-reads at runtime to fail-loud verify, so the resolution and the gate use the identical, unambiguous source.

- [ ] **Step 2: Write `ollama.Dockerfile`**

Paste the resolved `ollama/ollama` digest into `FROM`:

```dockerfile
# Base pinned by digest (resolved from ollama/ollama:latest at authoring time — see compose comment).
FROM ollama/ollama@sha256:PASTE_OLLAMA_DIGEST_HERE
# Bake the embedding model INTO the image (deterministic; no re-pull at container
# start → no network flakiness, no cold start). Pulled by TAG; the exact bytes are
# verified at runtime by run.mjs via /api/tags (the documented manifest-digest
# field) — there is no verified pull-by-digest syntax across Ollama versions.
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
      - "${PG_TEST_PORT:-5432}:5432"
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
      - "${QDRANT_TEST_PORT:-6333}:6333"
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
      - "${OLLAMA_TEST_PORT:-11434}:11434"
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

/**
 * The inverse of pollUntil: re-sample `fn` for the WHOLE window and throw if
 * `predicate` ever breaks. Proves a condition is SUSTAINED — e.g. a retired
 * generation's point count stays at its full value after a pre-grace sweep
 * (a one-shot `count > 0` would pass instantly because the delete simply hadn't
 * propagated yet, proving nothing).
 */
export async function assertHoldsFor<T>(
  fn: () => Promise<T>,
  opts: { predicate: (v: T) => boolean; windowMs?: number; intervalMs?: number; label?: string },
): Promise<void> {
  const windowMs = opts.windowMs ?? 1500;
  const intervalMs = opts.intervalMs ?? 150;
  const deadline = Date.now() + windowMs;
  do {
    const v = await fn();
    if (!opts.predicate(v)) {
      throw new Error(
        `assertHoldsFor: predicate broke${opts.label ? ` for ${opts.label}` : ''}; value: ${JSON.stringify(v)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() < deadline);
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
// up --wait --build → bootstrap Qdrant collection → run the test via tsx under a
// HARD TIMEOUT in its own process group → ALWAYS `docker compose down -v` in a
// finally. No test logic lives here.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TEST_TIMEOUT_MS = 5 * 60_000; // hard cap: a hung test/Ollama must not wedge teardown
// Authoritative manifest digest of the baked model (resolved in Task 2 Step 1 via
// /api/tags). run.mjs re-reads the SAME field at runtime and fails loud on drift.
const EXPECTED_MODEL_DIGEST = 'sha256:PASTE_NOMIC_MODEL_DIGEST_HERE';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

function fail(msg) {
  console.error(`\n[run.mjs] ${msg}`);
  process.exit(1);
}

// POSIX-only: this wrapper uses a detached process group + negative-PID group
// kill, unsupported on Windows. Declare the scope and bail clearly rather than
// half-work. (A Windows port would use `taskkill /T` — out of scope.)
if (process.platform === 'win32') {
  fail('this integration test is POSIX-only (uses process-group kill); run on Linux/macOS or in WSL.');
}

// Port contract: fixed defaults, each overridable by ONE env var, wired
// IDENTICALLY into compose (`${PG_TEST_PORT:-5432}:5432`) and the URLs below, so
// the published host port and the URL the test dials never disagree.
const PG_PORT = process.env.PG_TEST_PORT ?? '5432';
const QDRANT_PORT = process.env.QDRANT_TEST_PORT ?? '6333';
const OLLAMA_PORT = process.env.OLLAMA_TEST_PORT ?? '11434';

const env = {
  ...process.env,
  // re-export the ports so `docker compose` interpolates the SAME values
  PG_TEST_PORT: PG_PORT,
  QDRANT_TEST_PORT: QDRANT_PORT,
  OLLAMA_TEST_PORT: OLLAMA_PORT,
  PG_TEST_URL: `postgres://test:test@localhost:${PG_PORT}/skills`,
  PG_READ_TEST_URL: `postgres://readonly:readonly@localhost:${PG_PORT}/skills`,
  QDRANT_TEST_URL: `http://localhost:${QDRANT_PORT}`,
  QDRANT_TEST_COLLECTION: 'skills_test',
  EMBED_DIM: '768',
  OLLAMA_TEST_URL: `http://localhost:${OLLAMA_PORT}`,
  OLLAMA_TEST_MODEL: 'nomic-embed-text',
};

function compose(args, opts = {}) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: here,
    stdio: 'inherit',
    env, // pass the port contract through to compose interpolation
    ...opts,
  });
}

// Preflight: docker compose must exist.
const probe = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
if (probe.status !== 0) {
  fail('docker compose is not available — this is an explicit, opt-in integration run.');
}

// Run the test async, detached into its OWN process group, under a hard timeout.
// spawnSync is unusable here: it blocks the event loop, so a timer could never
// fire and a hung child would wedge the wrapper forever. On timeout we escalate:
// SIGKILL the whole group (negative pid) so a stuck tsx/node/Ollama-waiting
// grandchild dies too; if that throws, fall back to killing the parent. We do NOT
// claim the child is guaranteed dead — we wait a BOUNDED grace for `close`, then
// resolve regardless (warning about a possible orphan) so the finally always
// reaches `down -v`, the authoritative container/volume cleanup.
const POST_KILL_GRACE_MS = 5_000;
function runTestWithTimeout() {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['tsx', '--test', 'test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts'],
      { cwd: repoRoot, stdio: 'inherit', env, detached: true },
    );
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[run.mjs] test exceeded ${TEST_TIMEOUT_MS}ms — killing process group`);
      // (a) whole-group kill; (b) fallback to the parent. Neither may throw out.
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      // Bounded wait for `close`; if it never comes, proceed anyway (orphan warning).
      setTimeout(() => {
        if (!settled) {
          console.error('[run.mjs] WARNING: test did not exit after SIGKILL — a host-side orphan child/group may survive; continuing to teardown (down -v still cleans containers/volume).');
          done(124);
        }
      }, POST_KILL_GRACE_MS);
    }, TEST_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return done(124); // conventional timeout exit code
      done(signal ? 1 : (code ?? 1));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[run.mjs] failed to spawn test: ${err.message}`);
      done(1);
    });
  });
}

let testStatus = 1;
try {
  console.log('[run.mjs] starting stack (first run builds the Ollama image)…');
  if (compose(['up', '-d', '--wait', '--build']).status !== 0) {
    compose(['logs']);
    fail('docker compose up --wait failed (see logs above).');
  }

  console.log('[run.mjs] verifying baked Ollama model digest via /api/tags…');
  const tags = await (await fetch(`${env.OLLAMA_TEST_URL}/api/tags`)).json();
  const model = (tags?.models ?? []).find((m) => m.name === `${env.OLLAMA_TEST_MODEL}:latest`);
  if (!model) fail(`model ${env.OLLAMA_TEST_MODEL}:latest not present in /api/tags`);
  if (model.digest !== EXPECTED_MODEL_DIGEST) {
    fail(`model digest drift: got ${model.digest}, expected ${EXPECTED_MODEL_DIGEST}`);
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

  console.log('[run.mjs] running the integration test (hard timeout)…');
  testStatus = await runTestWithTimeout();
} finally {
  console.log('[run.mjs] tearing down (down -v)…');
  compose(['down', '-v']);
}

process.exit(testStatus);
```

- [ ] **Step 2: Verify the wrapper fails loud without docker (sanity)**

This is a structural check — confirm the preflight path exists. Read the file and confirm: `win32` guard exits early; preflight `docker compose version` guard present; the `/api/tags` model-digest gate (`EXPECTED_MODEL_DIGEST`) runs after `up --wait` and fails loud on drift/absence; the test runs via async `spawn` with `detached: true` under `TEST_TIMEOUT_MS`; on timeout it group-kills, falls back to `child.kill`, waits a bounded `POST_KILL_GRACE_MS` for `close`, then resolves 124 with an orphan warning (never blocks forever); `down -v` is inside `finally` (so it runs whether the test passed, failed, was killed, or timed out); collection bootstrap asserts `size === 768`; exit code propagates `testStatus`. (A real end-to-end run happens in Task 11 once the test exists.)

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

### Task 6: Ordered-scenario harness + Case 1 (ingest + commit)

**Files:**
- Create: `test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`

The five cases share ONE Postgres catalog row, ONE Qdrant collection, and ONE host+clock, and each depends on the state the previous committed. They are therefore a SINGLE top-level `test()` with ordered, **awaited** `t.test(...)` subtests (the `await` forbids concurrency and pins order). Tasks 7–10 each append one awaited subtest at the marker comment. The test is NOT independently runnable per case — by design (see README).

- [ ] **Step 1: Write the scenario harness + Case 1**

The store provider needs `embed: (text) => Promise<number[]>` — wrap the embedder's `{ vector }`. Counting is generation-scoped via Qdrant's exact `/points/count` (a collection-level count is meaningless once active+retired generations coexist).

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogCasError } from '@mcp-abap-adt/llm-agent';
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
import { assertHoldsFor, pollUntil, withPools } from './helpers.js';
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

// EXACT, generation-scoped count via /points/count. Active AND retired generations
// share the collection after a reload, so a collection-level count is wrong.
async function countGeneration(generation: string): Promise<number> {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/count`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filter: { must: [{ key: 'generation', match: { value: generation } }] },
      exact: true,
    }),
  });
  if (!res.ok) throw new Error(`qdrant points/count failed: ${res.status}`);
  const json = (await res.json()) as { result?: { count?: number } };
  return json.result?.count ?? 0;
}

// Active generation for a group from the committed catalog snapshot.
async function activeGeneration(
  catalogStore: { read(): Promise<{ entries: { collection: { group: string }; generation: string }[] }> },
  group: string,
): Promise<string> {
  const snap = await catalogStore.read();
  const entry = snap.entries.find((e) => e.collection.group === group);
  assert.ok(entry, `no committed entry for group '${group}'`);
  return entry.generation;
}

test('skill-host PG+Qdrant durable persistence (ordered scenario)', async (t) => {
  await withPools(async (register) => {
    // Shared state for the whole scenario. Injected clock so Case 4's sweep
    // grace windows are deterministic.
    let clock = 1_000_000;
    const now = () => clock;
    const source = makeRevisionedSource();
    source.setRevision('v1');

    const pgPool = register(makePgPool(PG_URL, TABLE)) as ReturnType<typeof makePgPool>;
    const catalogStore = makePgCatalogStore({ pool: pgPool, table: TABLE });
    const client = makeQdrantClient({ url: QDRANT_URL, collection: COLLECTION });
    const embedder = new OllamaEmbedder({ ollamaUrl: OLLAMA_URL, model: MODEL });
    const storeProvider = makeQdrantStoreProvider({
      client,
      collection: COLLECTION,
      catalogStore,
      embed: async (tx, o) => (await embedder.embed(tx, o)).vector,
      retiredGraceMs: RETIRED_GRACE_MS,
      orphanGraceMs: ORPHAN_GRACE_MS,
      now,
    });
    const host = makeSkillPluginHost({
      sources: [{ id: SOURCE_ID, source }],
      storeProvider,
      embedder,
      embeddingSpaceId: 'itest-ollama-nomic-embed-text',
      retrievalSchemaVersion: 1,
      dimension: EMBED_DIM,
      now,
    });

    // Per-group v1 generations captured in Case 1, consumed by Case 4.
    let g1a = '';
    let g1b = '';

    await t.test('embedder returns a 768-dim vector (model present)', async () => {
      const v = (await embedder.embed('hello')).vector;
      assert.equal(v.length, EMBED_DIM);
    });

    await t.test('Case 1: ingest + commit (v1) → PG row + Qdrant vectors', async () => {
      const result = await host.load();
      assert.equal(result.ok, true, `load not ok: ${JSON.stringify(result)}`);
      assert.deepEqual([...result.committed].sort(), ['alpha', 'beta']);

      const snap = await catalogStore.read();
      assert.ok(snap.catalogRevision && snap.catalogRevision !== 'c0', 'revision advanced');
      assert.equal(snap.entries.length, 2);

      g1a = await activeGeneration(catalogStore, 'alpha');
      g1b = await activeGeneration(catalogStore, 'beta');
      await pollUntil(
        async () => (await countGeneration(g1a)) + (await countGeneration(g1b)),
        { predicate: (n) => n === V1_POINTS, label: `v1 committed points == ${V1_POINTS}` },
      );
    });

    // >>> APPEND-POINT: Cases 2–5 (Tasks 7–10) go here, each an awaited t.test
    //     using the shared host / catalogStore / storeProvider / clock / g1a / g1b.
  });
});
```

- [ ] **Step 2: Run the scenario (Case 1) against a running stack**

Bring the stack up per the development-loop note (and bootstrap the collection), then run with the env vars set:
Run (env vars as in the dev-loop note): `npx tsx --test test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`
Expected: the embedder subtest + Case 1 PASS. If the count never reaches 5, check the upsert reached Qdrant (`docker compose logs qdrant`) and that the collection exists.

- [ ] **Step 3: Commit**

```bash
git add test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts
git commit -m "test(skills): integration scenario harness + Case 1 (ingest + commit)"
```

---

### Task 7: Case 2 (recall)

**Files:**
- Modify: `test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`

- [ ] **Step 1: Append Case 2 at the APPEND-POINT** (inside the scenario, replacing the marker comment with this subtest followed by the marker again)

Recall reads the v1 state Case 1 committed — no new load. `host.rag(group).query(text, { k, threshold? })` returns `SkillHit[]` (`{ record, score }`) in descending score.

```ts
    await t.test('Case 2: recall returns ranked hits from the queried collection', async () => {
      const hits = await host.rag('alpha').query('reading a file from disk', { k: 3 });
      assert.ok(hits.length > 0, 'expected at least one hit');
      for (const h of hits) assert.equal(h.record.group, 'alpha'); // only alpha
      for (let i = 1; i < hits.length; i++) {
        assert.ok(hits[i - 1].score >= hits[i].score, 'scores not descending');
      }
      // the file-reading skill should rank at/near the top for this query
      assert.match(hits[0].record.name, /open-file/);
    });
```

- [ ] **Step 2: Run the scenario (Cases 1–2)**

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

- [ ] **Step 1: Append Case 3 at the APPEND-POINT** (must run BEFORE Case 4 — it advances the revision but leaves the v1 generation set intact, keeping Case 4's counts clean)

Advance the revision with a BENIGN republish of the SAME entries (no `beginGeneration`/`upsert`, so the active generation set is untouched), then attempt a second `casPublish` against the now-stale revision → `CatalogCasError`.

```ts
    await t.test('Case 3: fenced catalog CAS rejects a stale revision', async () => {
      const r0 = await catalogStore.read();
      const R0 = r0.catalogRevision;

      // Benign republish: same entries, bumps the revision to R1, no generation churn.
      const r1 = await catalogStore.casPublish(R0, r0.entries, now());
      const R1 = r1.catalogRevision;
      assert.notEqual(R1, R0, 'benign republish advanced the revision');

      // A second publish against the now-stale R0 must be rejected.
      await assert.rejects(
        () => catalogStore.casPublish(R0, r0.entries, now()),
        (err) => err instanceof CatalogCasError,
        'expected CatalogCasError on stale revision',
      );

      // The committed revision is R1, unchanged by the rejected attempt.
      const after = await catalogStore.read();
      assert.equal(after.catalogRevision, R1);
    });
```

Confirmed against `qdrant-store.ts`: `ICatalogStore.casPublish(expectedCatalogRevision, entries, now)` is the atomic CAS primitive `makePgCatalogStore` returns; it throws `CatalogCasError` when the active revision ≠ expected (real `UPDATE … WHERE revision=$expected` matching 0 rows). Republishing the snapshot's own active entries advances the revision without creating or retiring any generation.

- [ ] **Step 2: Run the scenario (Cases 1–3)**

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

`load()` rebuilds EVERY desired collection, so a reload makes a NEW generation for BOTH `alpha` and `beta` and retires BOTH prior ones. Uses the SHARED host/storeProvider/clock (the injected `now` makes grace windows deterministic) and the `g1a`/`g1b` captured in Case 1. (`assertHoldsFor` is already imported in Task 6.)

- [ ] **Step 1: Append Case 4 at the APPEND-POINT**

```ts
    await t.test('Case 4: reload retires BOTH prior generations; sweeper is age-protected', async () => {
      // Reload v2 → NEW generation for BOTH groups; BOTH prior generations retired.
      source.setRevision('v2');
      await host.load();
      const g2a = await activeGeneration(catalogStore, 'alpha');
      const g2b = await activeGeneration(catalogStore, 'beta');
      assert.notEqual(g2a, g1a, 'alpha generation must change on reload');
      assert.notEqual(g2b, g1b, 'beta generation must change on reload');

      // v2 active points visible across the two NEW generations.
      await pollUntil(
        async () => (await countGeneration(g2a)) + (await countGeneration(g2b)),
        { predicate: (n) => n === V2_POINTS, label: `v2 committed points == ${V2_POINTS}` },
      );

      // Durable retired[] holds BOTH prior generations.
      const snap = await catalogStore.read();
      const retired = new Set((snap.retired ?? []).map((r) => r.generation));
      assert.ok(retired.has(g1a), 'v1 alpha generation retired');
      assert.ok(retired.has(g1b), 'v1 beta generation retired');

      // AGE PROTECTION (sustained): sweep BEFORE grace must delete NOTHING. The
      // combined retired count must stay at its full value (V1_POINTS) over a
      // window — a one-shot "> 0" would pass instantly (delete not yet propagated).
      await storeProvider.sweep(clock); // tick == now, retiredAt + grace > now
      await assertHoldsFor(
        async () => (await countGeneration(g1a)) + (await countGeneration(g1b)),
        { predicate: (n) => n === V1_POINTS, windowMs: 1500, label: 'retired count stays full pre-grace' },
      );

      // POST-GRACE: advance past the grace, sweep → BOTH retired generations reclaimed.
      clock += RETIRED_GRACE_MS + 1;
      await storeProvider.sweep(clock);
      await pollUntil(
        async () => (await countGeneration(g1a)) + (await countGeneration(g1b)),
        { predicate: (n) => n === 0, label: 'both retired generations reclaimed to 0' },
      );
    });
```

- [ ] **Step 2: Run the scenario (Cases 1–4)**

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

The read path uses `makePgReadPool` (no DDL) + `makePgCatalogReader` + `makeQdrantReader`. By now (post–Case 4) the committed catalog is the v2 state; this case reads THAT via restricted credentials and asserts write/DDL is rejected.

- [ ] **Step 1: Append Case 5 at the APPEND-POINT** (runs LAST — reads the post-reload committed catalog)

```ts
    await t.test('Case 5: recall-only read path under SELECT-only credentials', async () => {
      const expected = await catalogStore.read(); // v2 committed state from Case 4

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

      // (b) The read-only login must REJECT write AND DDL. Run UNAMBIGUOUSLY
      // forbidden statements directly through the restricted pool — NOT
      // `CREATE TABLE IF NOT EXISTS skills_catalog`, which Postgres may short-circuit
      // on the already-existing table. makePgReadPool.query runs raw SQL (no DDL
      // wrapper), so it is the clean vehicle for the negative probes.
      //   INSERT into the existing catalog table → denied (no INSERT grant).
      await assert.rejects(
        () => readPool.query(`INSERT INTO ${TABLE} (id, revision, snapshot) VALUES ('x','x','{}')`),
        /permission denied/i,
        'read-only role must be denied INSERT',
      );
      //   CREATE a brand-new table (never short-circuited) → denied (no CREATE grant).
      await assert.rejects(
        () => readPool.query('CREATE TABLE readonly_probe (i int)'),
        /permission denied/i,
        'read-only role must be denied CREATE TABLE',
      );
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

**Second review round (5 findings) — addressed:**
- P1 wrapper hard timeout → Task 4: async `spawn` with `detached` process group, `TEST_TIMEOUT_MS`, `process.kill(-pid,'SIGKILL')` on expiry, `down -v` always reached. ✓
- P1 reload makes a generation PER GROUP (both alpha+beta rebuild/retire, not one) → Task 9: per-group generation map, assert both changed, reclaim BOTH old generations. ✓ (confirmed against `skill-plugin-host.ts` load loop over `desiredSet`).
- P2 age-protection one-shot proves nothing → Task 3 `assertHoldsFor` + Task 9: combined retired count must stay at `V1_POINTS` for a sustained window after pre-grace sweep. ✓
- P2 ambiguous read-only negative → Task 10: direct forbidden `INSERT` + `CREATE TABLE readonly_probe` through the restricted pool (no `IF NOT EXISTS` short-circuit). ✓
- P2 model digest pin mechanism → Task 2: pull by tag, then fail-loud verify the manifest digest against a pinned `ARG NOMIC_DIGEST` (no reliance on unverified pull-by-digest). ✓

**Third review round (3 findings) — addressed:**
- P1 model-digest mechanism undefined → Task 2 + Task 4: verify via the documented `/api/tags` `models[].digest` (manifest digest) in `run.mjs`, not `ollama show` grep; resolution and gate use the identical field. No "implementer adjusts grep". ✓
- P2 count not generation-specific → Task 6 `countGeneration` uses exact `/points/count` with a `generation` filter; all assertions sum specific generations, never the collection. ✓
- P2 cases depend on execution order → restructured into ONE top-level `test()` with ordered, awaited `t.test(...)` subtests sharing one host/catalog/collection/clock; concurrency impossible; NOT independently runnable (stated in README + spec). Case 3 advances the revision via a benign republish (no generation churn) so Case 4 counts stay clean. ✓

**Fourth review round (2 carry-over findings) — addressed:**
- Port contract: dynamic-port promise dropped; FIXED defaults overridable by `PG_TEST_PORT`/`QDRANT_TEST_PORT`/`OLLAMA_TEST_PORT`, wired identically into compose `${VAR:-default}:container` mappings (Task 2) AND the URLs `run.mjs` builds (Task 4) — they share the variables, so host port and URL never disagree. ✓
- POSIX scope declared: `run.mjs` exits with a clear message on `win32`; the process-group kill is POSIX-only and wrapped in try/catch; README lists "POSIX host (Linux/macOS/WSL)" as a prerequisite. ✓

**Fifth review round (1 finding) — addressed:**
- Timeout contract no longer self-contradictory → Task 4: on timeout, escalate (group-kill → fallback `child.kill`), wait a bounded `POST_KILL_GRACE_MS` for `close`, then resolve 124 with an EXPLICIT orphan warning. The wrapper never claims the child is guaranteed dead and never blocks forever; `down -v` (authoritative container/volume cleanup) always follows. ✓

**Placeholder scan:** The only intentional placeholders are the image/model `sha256:` digests, which the engineer resolves in Task 2 Step 1 (`/api/tags` for the model, `docker inspect` for the postgres/qdrant images) and pastes in — concrete values, not vague work.

**Type/name consistency:** `makeSkillPluginHost`/`IngestHostDeps`, `makeQdrantStoreProvider` (`embed:(t,o)=>Promise<number[]>`, `retiredGraceMs`, `orphanGraceMs`, `now`, `.sweep(at?)`), `makePgCatalogStore`/`makePgCatalogReader` (`{pool,table?}`), `makeQdrantClient`/`makeQdrantReader` (`{url,collection}`), `OllamaEmbedder({ollamaUrl,model})` with `embed→{vector}`, `CatalogCasError`, `V1_POINTS`/`V2_POINTS`/`SOURCE_ID` from the fixture — all match the symbols verified in the codebase. Both previously-uncertain methods are now confirmed against `qdrant-store.ts`: `ICatalogStore.casPublish(expectedCatalogRevision, entries, now)` (Case 3) and `IQdrantReader.scroll(filter, cursor?) → {points, next?}` (Case 5).
