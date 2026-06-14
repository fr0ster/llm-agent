# Skill-Host PG + Qdrant Integration Test — Design Spec

**Date:** 2026-06-14
**Status:** APPROVED (ready for implementation plan)
**Branch:** `feat/skill-plugin-host` (PR #184)

## Goal

Add a real-infrastructure integration test for the skill plugin-host's durable
persistence path (Postgres catalog + Qdrant vectors), driven by a real Ollama
embedder, run **on-demand / locally** via a single wrapper script. This closes
the residual risk flagged in PR #184 review round 7: every persistence path was
proven only against in-process fakes / a `createPool` seam, never against a live
PostgreSQL + Qdrant. The infrastructure is built to be **reusable** for future
integration tests, not single-shot.

## Non-Goals

- **No CI wiring.** This is a local/on-demand tool. The main CI (build / lint /
  unit) stays fast and infra-free. A CI job may be added trivially later but is
  out of scope here.
- **No GPL content.** No `sap-skills` (GPL-3.0) text is bundled or committed.
  The test uses synthetic, MIT-clean fixtures only (consistent with the
  gnostification licensing rule).
- **Not an embedding-quality test.** We test the catalog/vector/sweeper/CAS
  plumbing against real engines. Ollama provides real vectors so the Qdrant path
  is genuinely exercised, but assertions are about persistence semantics, not
  retrieval quality.

## Architecture

A self-contained directory under `test/integration/` holds the docker assets,
the wrapper, the test, and synthetic fixtures. A single npm script runs the
wrapper, which owns the full container lifecycle (up → ensure model → run test →
tear down). The test connects to the live engines via env-provided URLs and
exercises the host end-to-end through its public composition entry points.

```
test/integration/skill-host-pg-qdrant/
  docker-compose.yml          # postgres + qdrant + ollama services, healthchecked, DIGEST-pinned
  ollama.Dockerfile           # FROM digest-pinned ollama/ollama; bakes the embedding model into the image
  pg-init/
    01-readonly-role.sql      # creates a SELECT-only login for the recall-only read path
  run.mjs                     # lifecycle wrapper (up → bootstrap collection → run test → down -v in finally)
  skill-host.integration.test.ts
  helpers.ts                  # bounded-polling + pool-lifecycle helpers used by the test
  fixtures/
    revisioned-source.ts      # a mutable ISkillSource (v1/v2) emitting MIT-clean collections/records
  README.md                   # how to run it manually + prerequisites
```

**npm script** (root `package.json`):

```json
"test:integration:skill-host": "node test/integration/skill-host-pg-qdrant/run.mjs"
```

It is NOT referenced by `npm test`, `build`, `lint`, or any CI workflow.

## Components

### docker-compose.yml

Three services on a private compose network, each with a healthcheck so
`docker compose up --wait` blocks until all are ready. **All images are pinned
by digest** (`image: name@sha256:…`) so the stack is byte-reproducible — an
unpinned tag (or a mutable model) would undermine the fixed-dimension and
deterministic-vector guarantees the test relies on.

| Service | Image (digest-pinned) | Port | Healthcheck | Notes |
|---------|-----------------------|------|-------------|-------|
| `postgres` | `postgres:16-alpine@sha256:…` | 5432 | `pg_isready -U test` | `makePgPool` runs `CREATE TABLE` itself. `POSTGRES_USER=test` (superuser, write path), `POSTGRES_PASSWORD=test`, `POSTGRES_DB=skills`. Mounts `./pg-init` into `/docker-entrypoint-initdb.d` to create the read-only role at first boot. |
| `qdrant` | `qdrant/qdrant:v1.12.4@sha256:…` | 6333 | HTTP `GET /readyz` | REST API, no auth. The collection is NOT auto-created by the client — `run.mjs` bootstraps it (see below). |
| `ollama` | built from `ollama.Dockerfile` (its `FROM` is digest-pinned) | 11434 | HTTP `GET /api/tags` | Embedding model baked in by digest (see below). |

Ports are published to the host so the test (running on the host via tsx) can
reach them, using the env-var port contract: the compose `ports:` mappings are
`"${PG_TEST_PORT:-5432}:5432"`, `"${QDRANT_TEST_PORT:-6333}:6333"`,
`"${OLLAMA_TEST_PORT:-11434}:11434"` — the SAME variables and defaults `run.mjs`
uses to build the URLs, so host port and URL never disagree. The exact image
digests are captured at implementation time (`docker buildx imagetools inspect` /
`docker inspect`) and written into the compose file with a comment recording the
human-readable tag they resolved from.

### pg-init/01-readonly-role.sql (read-only role)

Postgres runs any `*.sql` in `/docker-entrypoint-initdb.d` exactly once at first
boot. This file creates a **SELECT-only** login so the recall-only read path is
tested against genuinely restricted credentials — not the same superuser with
"we just didn't call DDL" (which would prove nothing about least-privilege).

```sql
CREATE ROLE readonly LOGIN PASSWORD 'readonly';
GRANT CONNECT ON DATABASE skills TO readonly;
GRANT USAGE ON SCHEMA public TO readonly;
-- Grant SELECT on current AND future tables (the catalog table is created later
-- by makePgPool's CREATE TABLE, after this init runs).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;
-- Explicitly DENY write/DDL: no INSERT/UPDATE/DELETE/CREATE granted → attempts fail.
```

`run.mjs` exposes this as `PG_READ_TEST_URL` (`postgres://readonly:readonly@…/skills`),
distinct from the superuser `PG_TEST_URL`.

### Qdrant collection bootstrap

`makeQdrantClient` only does `upsertPoints` / search / scroll / delete against
`/collections/<name>/points`; it never creates the collection. A first upsert
into a fresh Qdrant therefore 404s. So `run.mjs` (after `up --wait`, before the
test) issues `PUT /collections/<name>` with the embedder's exact geometry and
verifies it back:

```
PUT /collections/skills_test  { "vectors": { "size": 768, "distance": "Cosine" } }
GET /collections/skills_test  → assert config.params.vectors.size === 768
```

The collection name and size are passed to the test via env
(`QDRANT_TEST_COLLECTION`, `EMBED_DIM=768`) so the test and the bootstrap agree.

### ollama.Dockerfile

Ollama has no verified `pull model@sha256:…` syntax across versions, so we DO
NOT rely on a digest-addressed pull. The Dockerfile pulls by TAG to bake the
bytes into the image; the **digest verification is done by `run.mjs`** against
the authoritative, documented source — the Ollama REST API `GET /api/tags`, whose
`models[].digest` field is the model's **manifest digest** (a full `sha256:…`).
This is unambiguous and version-stable (a documented API contract), unlike
scraping `ollama show --modelfile`, which can surface a per-blob digest rather
than the manifest digest.

```dockerfile
# Base image pinned by digest (resolved at implementation time from ollama/ollama:<tag>).
FROM ollama/ollama@sha256:<resolved-at-impl-time>
# Bake the embedding model INTO the image (deterministic; no re-pull at container
# start → no network flakiness, no cold start). Pulled by TAG; the exact bytes are
# verified by run.mjs via /api/tags (see below), not here.
# set -eu: a failed `ollama pull` MUST abort the build — otherwise the trailing
# `pkill ... || true` returns 0 and the image ships WITHOUT the model baked in.
RUN set -eu; \
    ollama serve & \
    until ollama list >/dev/null 2>&1; do sleep 1; done; \
    ollama pull nomic-embed-text; \
    pkill ollama || true
```

**Digest gate in `run.mjs` (exact, authoritative):** after `up --wait`, before
the collection bootstrap, `run.mjs` does:

```
GET {OLLAMA_TEST_URL}/api/tags
→ models = body.models
→ entry = models.find(m => m.name === 'nomic-embed-text:latest')   // exact tag match
→ assert entry && entry.digest === EXPECTED_MODEL_DIGEST            // full sha256: manifest digest
   else fail-loud (exit 1) — the baked model is not the pinned one
```

`EXPECTED_MODEL_DIGEST` is a constant in `run.mjs`, resolved once at
implementation time by reading the SAME field:

```
docker run --rm -d --name ollama_probe ollama/ollama && \
docker exec ollama_probe sh -c 'until ollama list >/dev/null 2>&1; do sleep 1; done; ollama pull nomic-embed-text >/dev/null' && \
curl -s localhost:11434/api/tags  # ← but the probe port is internal; instead curl from inside:
docker exec ollama_probe sh -c 'wget -qO- 127.0.0.1:11434/api/tags' | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).models.find(x=>x.name==="nomic-embed-text:latest");console.log(m.digest)})'
# then: docker rm -f ollama_probe
```

Model: `nomic-embed-text` (768-dim). The base image is digest-pinned; the model
is tag-pulled and then its manifest digest is fail-loud verified against the
pinned constant via the documented `/api/tags` `digest` field. The integration
test additionally confirms the model returns a 768-length vector by issuing one
embed call before ingest.

### run.mjs (lifecycle wrapper)

Plain Node ESM, no test logic. **Scope: POSIX only (Linux / macOS).** It uses
detached process groups and a negative-PID group kill, which Windows does not
support; the script declares this and exits with a clear message on `win32`.
(The whole stack is Docker-based and the project's dev targets are Linux/macOS,
so POSIX-only is acceptable; a Windows port would swap the group-kill for a
`taskkill /T` tree-kill but is out of scope.)

Responsibilities, in order:

1. Resolve the compose project dir. **Port contract:** ports are FIXED defaults,
   each overridable by one env var, wired IDENTICALLY into compose and the URLs:
   `PG_TEST_PORT` (5432), `QDRANT_TEST_PORT` (6333), `OLLAMA_TEST_PORT` (11434).
   `run.mjs` reads these (with the same defaults), publishes them to `docker
   compose` via the environment, and assembles the URLs from the SAME values, so
   compose's `"${PG_TEST_PORT:-5432}:5432"` mappings and the test's `PG_TEST_URL`
   never disagree. It does NOT auto-detect free ports (that promise is dropped —
   a fixed, overridable contract is simpler and deterministic). It then assembles
   `PG_TEST_URL` (superuser), `PG_READ_TEST_URL` (read-only role),
   `QDRANT_TEST_URL`, `QDRANT_TEST_COLLECTION`, `EMBED_DIM=768`, `OLLAMA_TEST_URL`.
2. `docker compose up -d --wait --build` (build picks up `ollama.Dockerfile`;
   `--wait` blocks on the healthchecks).
3. **Verify the baked model digest** — `GET /api/tags`, find the
   `nomic-embed-text:latest` entry, assert its `digest` equals
   `EXPECTED_MODEL_DIGEST`; fail-loud (exit 1) on mismatch or absence.
4. **Bootstrap the Qdrant collection** — `PUT /collections/<name>` with
   `{ vectors: { size: 768, distance: "Cosine" } }`, then `GET` it and assert
   `size === 768`. (The client never creates collections; without this the first
   upsert 404s.)
5. Run the test under a **hard timeout** with its own process group (POSIX — see
   scope above): spawn `npx tsx --test …` async with `detached: true`, inherit
   stdio, all env set. Arm a wall-clock timer (e.g. 5 min). On expiry, escalate:
   (a) `process.kill(-child.pid, 'SIGKILL')` to take the WHOLE group (so a hung
   `tsx`/`node`/Ollama-waiting grandchild dies too); (b) if that throws, fall back
   to `child.kill('SIGKILL')` on the parent alone — both wrapped so a kill failure
   never throws out of the timer. The promise resolves only on the child's
   `exit`/`close` event OR a bounded post-kill grace (e.g. 5 s): if `close` still
   has not fired after the grace, resolve anyway with exit code 124 and log an
   EXPLICIT warning that an orphan child/group may survive — the wrapper does NOT
   block forever waiting to confirm death. `spawnSync` is NOT used here: it blocks
   the event loop, so the timer could never fire and a hung child would wedge the
   wrapper, never reaching teardown.
6. In a `finally`, always `docker compose down -v` (drop the volume so each run
   starts from a clean DB + clean Qdrant storage). The `finally` runs because
   step 5 ALWAYS resolves — on normal exit, on a confirmed post-kill `close`, or
   on the bounded-grace timeout (with the orphan warning). `down -v` is the
   authoritative cleanup of the containers/volume regardless of any lingering
   host-side orphan process. **Critically: once the stack is UP, every in-lifecycle
   failure (digest gate, collection bootstrap, `up` failure) `throw`s rather than
   `process.exit`s** — `process.exit` inside the try would skip the `finally` and
   LEAK the containers/volume. A `catch` records the failure (testStatus = 1) and
   falls through to the teardown `finally`. The preflight `fail()` (win32, missing
   docker) may still `process.exit` because no container exists yet.
7. Propagate the test's exit code as the process exit code.
8. If `docker` / `docker compose` is unavailable, fail LOUD with a clear message
   (this is an explicit, opt-in run — never a silent skip). On `up --wait`
   timeout, dump `docker compose logs` before tearing down.

### helpers.ts (test-side helpers)

Shared by the test to keep it readable and to remove two classes of flakiness:

- **`pollUntil(fn, { predicate, timeoutMs, intervalMs })`** — bounded polling.
  Qdrant's `PUT /points` is issued WITHOUT `wait=true` by the production client,
  so writes/deletes are not synchronously visible. Every "expect N points" /
  "expect generation gone" assertion goes through `pollUntil` (e.g. 5 s timeout,
  100 ms interval) rather than reading once immediately after `load()`/`sweep()`.
- **`assertHoldsFor(fn, { predicate, windowMs, intervalMs })`** — the inverse of
  `pollUntil`: re-samples `fn` for the whole window and FAILS if the predicate
  ever breaks. Used for the age-protection check: after `sweep(now)` (pre-grace),
  a retired generation's count must stay at its full value for a sustained window
  — a one-shot `count > 0` would pass instantly (the delete simply hadn't
  propagated yet) and prove nothing. `assertHoldsFor(count === fullCount, 1.5 s)`
  proves the sweep genuinely did NOT delete.
- **`withPools(pools, body)`** — registers every `makePgPool`/`makePgReadPool`
  instance and `await`s `end()` on ALL of them in a `finally`, even when `body`
  throws. Open pg sockets keep the tsx subprocess alive; if it never exits,
  `run.mjs` never reaches `down -v`. The test creates pools ONLY through this
  guard.

### fixtures/revisioned-source.ts

A **mutable** `ISkillSource` whose `acquire()` output is switchable between two
fixed revisions, so the reload/retirement case (test 4) has a well-defined
"changed records" input rather than re-ingesting an identical fixture:

- **v1:** two collections — `alpha` (3 records), `beta` (2 records). 5 points.
- **v2:** same two collections; `alpha` gains 1 record and edits 1 record's
  `retrievalText` (now 4 records), `beta` unchanged. 6 points.

All text is original MIT-clean content authored for the test. Ids/sourceIds are
deterministic and stable across v1→v2 (stable `sourceId`, logical `id` carries
the chunk index) so carry-forward vs refresh is observable. The fixture exposes
`setRevision('v1'|'v2')` and the EXPECTED point counts per revision as exported
constants (`V1_POINTS = 5`, `V2_POINTS = 6`) the test asserts against — generation
ids are server-assigned, so the test reads them back from the catalog snapshot
rather than hard-coding them, and asserts v2's generation differs from v1's.

### skill-host.integration.test.ts

Uses `node:test` + `node:assert/strict`, run via tsx. Builds the host through
the real composition path (the same `makePgPool` / `makePgCatalogStore` /
`makeQdrantStoreProvider` / Ollama-embedder wiring production uses), reading the
env vars. The embedder is the real `@mcp-abap-adt/ollama-embedder` pointed at
`OLLAMA_TEST_URL` with `nomic-embed-text`. Every pool is created through
`withPools`, and every "expect N points / generation gone" check goes through
`pollUntil` (writes are async — see helpers).

**Counting is ALWAYS generation-scoped.** After a reload, active AND retired
generations coexist in the SAME collection, so a collection-level count is
meaningless (it would read 11, not 6). Every count uses Qdrant's exact,
generation-filtered count endpoint:

```
POST {QDRANT_TEST_URL}/collections/{collection}/points/count
  { "filter": { "must": [ { "key": "generation", "match": { "value": "<gen>" } } ] }, "exact": true }
→ body.result.count
```

A `countGeneration(gen)` helper wraps this; assertions sum the counts of the
specific generations under test, never the whole collection.

**Single ordered scenario (not independent cases).** The five cases share one
Postgres catalog row and one Qdrant collection, and each depends on the state the
previous one committed (CAS advances the revision; the reload retires the v1
generations; recall-only reads the post-reload catalog). They are therefore
written as ONE top-level `test()` containing ordered, **awaited** `t.test(...)`
subtests — `await` between subtests forbids concurrency and fixes execution
order. A single `withPools` wraps the whole scenario; one host + clock are shared.
Running an individual case in isolation, or with test concurrency enabled, is NOT
supported and would assert against the wrong shared state — this is by design for
an expensive-to-provision integration scenario, and is stated in the README.

## Test Cases (ordered subtests of one scenario)

1. **Ingest + commit.** `host.load()` (fixture at v1) returns `ok: true` and
   `committed` listing both collections. A direct `PG_TEST_URL` query confirms
   the catalog row exists with a non-empty `revision`; `pollUntil` confirms
   Qdrant holds `V1_POINTS` (5) points for the committed generation.
2. **Recall.** `host.rag('alpha').query(text, { k })` returns non-empty hits in
   descending score order, all from the `alpha` collection.
3. **Fenced CAS.** Capture the current catalog revision `R0`. Advance the
   revision with a BENIGN republish — `casPublish(R0, sameEntries, now)` — which
   bumps the revision to `R1` WITHOUT changing the active generation set (no
   `beginGeneration`/`upsert`, so Case 4's counts stay clean). Then attempt a
   second `casPublish(R0, …)` with the now-stale `R0`: it throws `CatalogCasError`
   (real conditional `UPDATE … WHERE revision = $expected` matching 0 rows). A
   follow-up read confirms the committed revision is `R1`, unchanged by the
   rejected attempt.
4. **Retirement + sweeper.** NOTE: `load()` rebuilds EVERY desired collection,
   so a reload produces a NEW generation for **both** `alpha` and `beta` and
   retires **both** prior generations — not one. The test captures the v1
   generation map `{alpha: g1a, beta: g1b}` and the v2 map `{alpha: g2a, beta: g2b}`
   and asserts `g2a ≠ g1a` AND `g2b ≠ g1b`.
   - Switch the fixture to v2 (`setRevision('v2')`) and `load()` again. `pollUntil`
     confirms Qdrant holds `V2_POINTS` (6) total across the two new generations.
     The durable `retired[]` contains BOTH g1a and g1b.
   - **Age protection (sustained):** `sweep(now)` BEFORE the grace elapses must
     delete nothing — `assertHoldsFor` confirms the combined retired count
     (g1a + g1b) stays at its full value (5) for a sustained window, not merely
     "> 0 once".
   - **Post-grace reclaim (both):** `sweep(now + retiredGraceMs + 1)` removes the
     vectors of BOTH retired generations — `pollUntil` confirms g1a's count AND
     g1b's count each reach 0.
5. **Recall-only read path (restricted creds).** Build the read-only path with
   `makePgReadPool` + `makePgCatalogReader` over `PG_READ_TEST_URL` (the
   SELECT-only role) and `makeQdrantReader`. Assert it (a) reads the same
   committed catalog and returns the same vectors, AND (b) write/DDL through the
   read-only login is REJECTED by Postgres. The negative check runs UNAMBIGUOUSLY
   forbidden statements directly through the restricted pool — `INSERT INTO
   skills_catalog …` AND `CREATE TABLE readonly_probe (i int)` (a NEW table name,
   so it is never short-circuited the way `CREATE TABLE IF NOT EXISTS
   skills_catalog` would be on the already-existing catalog table). Both must
   throw a permission error — proving the read path genuinely runs without write
   privileges, not merely that our code declined to call DDL.

## Data Flow

```
run.mjs
  └─ docker compose up --wait --build  →  postgres (+readonly role) | qdrant | ollama (healthy)
  └─ bootstrap Qdrant collection (PUT size:768 Cosine; GET verify)
  └─ set PG_TEST_URL / PG_READ_TEST_URL / QDRANT_TEST_URL / QDRANT_TEST_COLLECTION / EMBED_DIM / OLLAMA_TEST_URL
  └─ tsx --test skill-host.integration.test.ts
        └─ withPools(…)  (every pool end()ed in finally)
        └─ build host (real makePgPool + makePgCatalogStore + makeQdrantStoreProvider + ollama-embedder)
        └─ host.load(revisioned source @v1)  →  PG catalog row + Qdrant vectors
        └─ assertions 1–5 (Qdrant counts via pollUntil; read path via PG_READ_TEST_URL)
  └─ finally: docker compose down -v   (clean volume)
```

## Error Handling

- **Docker missing / compose fails:** `run.mjs` exits non-zero with an explicit
  message naming the missing prerequisite. No silent skip — the run is opt-in.
- **Teardown always runs:** `down -v` is in a `finally`, so a failed/throwing
  test never leaves containers or a dirty volume behind. Volume removal
  guarantees the next run starts clean.
- **Healthcheck timeouts:** `up --wait` has a bounded wait; on timeout `run.mjs`
  dumps `docker compose logs` and tears down.
- **Pool sockets must not outlive the test:** open `pg.Pool` sockets keep the
  tsx subprocess alive, so a leaked pool would hang the run and prevent
  `run.mjs` from reaching `down -v`. The test creates EVERY pool through
  `withPools`, which `end()`s all of them in a `finally` — even on assertion
  failure — so the subprocess always exits and the wrapper always tears down.
- **Async Qdrant visibility:** because the production client does not pass
  `wait=true`, point counts after `upsert`/`delete`/`sweep` are eventually
  consistent. All such assertions use `pollUntil` with a bounded timeout, so a
  not-yet-visible write retries rather than failing spuriously, and a genuinely
  wrong count still fails at the timeout.

## Testing Strategy

The integration test IS the test. It is verified by running
`npm run test:integration:skill-host` locally and observing all five cases pass
against live engines. The wrapper's own correctness (lifecycle, env, teardown)
is validated by that same run — a failure in setup surfaces as a loud
non-zero exit, not a false pass.

## Open Risks / Notes

- First run builds the Ollama image (model bake) — slow once, cached after.
- All images AND the embedding model are digest-pinned; bump deliberately and
  re-resolve the digests when doing so.
- The read-only role's `GRANT SELECT ON ALL TABLES` runs at init BEFORE the
  catalog table exists, which is why `ALTER DEFAULT PRIVILEGES … GRANT SELECT`
  is also issued — it covers the table `makePgPool` creates later. Verified by
  test 5(a) (read path actually returns rows).
- Reusability: the compose + wrapper are generic enough that a future
  integration test can drop a sibling `*.integration.test.ts` and reuse the same
  `run.mjs` pattern (or a parametrized variant).
