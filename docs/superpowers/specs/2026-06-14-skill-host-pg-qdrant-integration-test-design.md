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
reach them. Defaults are overridable via env in `run.mjs`. The exact digests are
captured at implementation time (`docker buildx imagetools inspect` / `docker
inspect`) and written into the compose file with a comment recording the
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

```dockerfile
# Base image pinned by digest (resolved at implementation time from ollama/ollama:<tag>).
FROM ollama/ollama@sha256:<resolved-at-impl-time>
# Bake the embedding model INTO the image so each run is deterministic and does
# not re-pull at container start (avoids network flakiness + cold-start latency).
# The model is pinned by DIGEST (nomic-embed-text@sha256:…) so the baked vectors
# and 768-dim geometry are reproducible across rebuilds.
RUN ollama serve & \
    until ollama list >/dev/null 2>&1; do sleep 1; done; \
    ollama pull nomic-embed-text@sha256:<resolved-at-impl-time>; \
    pkill ollama
```

Model: `nomic-embed-text` (768-dim), pinned by digest. Both the base image and
the model digest are resolved during implementation (`docker inspect` /
`ollama show`) and written in verbatim with a comment recording the tag they came
from. The healthcheck confirms the server is up; the test confirms the model is
present and returns a 768-length vector by issuing one embed call before ingest.

### run.mjs (lifecycle wrapper)

Plain Node ESM, no test logic. Responsibilities, in order:

1. Resolve the compose project dir; pick free-or-default ports; assemble
   `PG_TEST_URL` (superuser), `PG_READ_TEST_URL` (read-only role),
   `QDRANT_TEST_URL`, `QDRANT_TEST_COLLECTION`, `EMBED_DIM=768`, `OLLAMA_TEST_URL`.
2. `docker compose up -d --wait --build` (build picks up `ollama.Dockerfile`;
   `--wait` blocks on the healthchecks).
3. **Bootstrap the Qdrant collection** — `PUT /collections/<name>` with
   `{ vectors: { size: 768, distance: "Cosine" } }`, then `GET` it and assert
   `size === 768`. (The client never creates collections; without this the first
   upsert 404s.)
4. Run the test: `npx tsx --test test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`,
   inheriting stdio, with all env vars set.
5. In a `finally`, always `docker compose down -v` (drop the volume so each run
   starts from a clean DB + clean Qdrant storage).
6. Propagate the test's exit code as the process exit code.
7. If `docker` / `docker compose` is unavailable, fail LOUD with a clear message
   (this is an explicit, opt-in run — never a silent skip). On `up --wait`
   timeout, dump `docker compose logs` before tearing down.

### helpers.ts (test-side helpers)

Shared by the test to keep it readable and to remove two classes of flakiness:

- **`pollUntil(fn, { predicate, timeoutMs, intervalMs })`** — bounded polling.
  Qdrant's `PUT /points` is issued WITHOUT `wait=true` by the production client,
  so writes/deletes are not synchronously visible. Every "expect N points" /
  "expect generation gone" assertion goes through `pollUntil` (e.g. 5 s timeout,
  100 ms interval) rather than reading once immediately after `load()`/`sweep()`.
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

## Test Cases (assertions)

1. **Ingest + commit.** `host.load()` (fixture at v1) returns `ok: true` and
   `committed` listing both collections. A direct `PG_TEST_URL` query confirms
   the catalog row exists with a non-empty `revision`; `pollUntil` confirms
   Qdrant holds `V1_POINTS` (5) points for the committed generation.
2. **Recall.** `host.rag('alpha').query(text, { k })` returns non-empty hits in
   descending score order, all from the `alpha` collection.
3. **Fenced CAS.** Build a SECOND store provider on the same `PG_TEST_URL`. Read
   the current catalog revision, then call `publishCatalog(staleRevision, …)`
   with a now-stale expected revision (advance it via the first provider first).
   The stale call throws `CatalogCasError` (real conditional `UPDATE … WHERE
   revision = $expected` matching 0 rows); a follow-up read confirms the catalog
   is unchanged.
4. **Retirement + sweeper.**
   - Switch the fixture to v2 (`setRevision('v2')`) and `load()` again: publishes
     a new generation (read back from the catalog; assert it differs from v1's)
     and retires the prior one (durable `retired[]` row present). `pollUntil`
     confirms Qdrant now holds `V2_POINTS` (6) for the new generation.
   - **Age protection:** `sweep(now)` BEFORE the grace elapses leaves the retired
     generation's vectors in place — `pollUntil` (short timeout) confirms the
     retired-generation count stays > 0.
   - **Post-grace reclaim:** `sweep(now + retiredGraceMs + 1)` removes the
     retired generation's vectors — `pollUntil` confirms that generation's count
     reaches 0.
5. **Recall-only read path (restricted creds).** Build the read-only path with
   `makePgReadPool` + `makePgCatalogReader` over `PG_READ_TEST_URL` (the
   SELECT-only role) and `makeQdrantReader`. Assert it (a) reads the same
   committed catalog and returns the same vectors, AND (b) a write/DDL attempt
   through the read-only login is REJECTED by Postgres (e.g. `makePgPool` over
   `PG_READ_TEST_URL` issuing `CREATE TABLE` throws a permission error) — proving
   the read path genuinely runs without write privileges, not merely that our
   code declined to call DDL.

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
