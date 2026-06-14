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
  docker-compose.yml          # postgres + qdrant + ollama services, healthchecked
  ollama.Dockerfile           # FROM ollama/ollama; bakes the embedding model into the image
  run.mjs                     # lifecycle wrapper (compose up --wait → run test → down -v in finally)
  skill-host.integration.test.ts
  fixtures/
    synthetic-source.ts       # an in-test ISkillSource emitting MIT-clean collections/records
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
`docker compose up --wait` blocks until all are ready.

| Service | Image | Port | Healthcheck | Notes |
|---------|-------|------|-------------|-------|
| `postgres` | `postgres:16-alpine` | 5432 | `pg_isready -U test` | Empty DB; `makePgPool` runs `CREATE TABLE` itself. `POSTGRES_USER=test`, `POSTGRES_PASSWORD=test`, `POSTGRES_DB=skills`. |
| `qdrant` | `qdrant/qdrant:v1.12.4` (pinned) | 6333 | HTTP `GET /readyz` | REST API. No auth. |
| `ollama` | built from `ollama.Dockerfile` | 11434 | HTTP `GET /api/tags` | Embedding model baked in (see below). |

Ports are published to the host so the test (running on the host via tsx) can
reach them. Defaults are overridable via env in `run.mjs`.

### ollama.Dockerfile

```dockerfile
FROM ollama/ollama
# Bake the embedding model INTO the image so each run is deterministic and does
# not re-pull at container start (avoids network flakiness + cold-start latency).
RUN ollama serve & \
    until ollama list >/dev/null 2>&1; do sleep 1; done; \
    ollama pull nomic-embed-text; \
    pkill ollama
```

Model: `nomic-embed-text` (768-dim). The healthcheck confirms the server is up;
the test confirms the model is present by issuing an embed call.

### run.mjs (lifecycle wrapper)

Plain Node ESM, no test logic. Responsibilities, in order:

1. Resolve the compose project dir; pick free-or-default ports; assemble
   `PG_TEST_URL`, `QDRANT_TEST_URL`, `OLLAMA_TEST_URL` env values.
2. `docker compose up -d --wait --build` (build picks up `ollama.Dockerfile`).
3. Run the test: `npx tsx --test test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts`,
   inheriting stdio, with the `*_TEST_URL` env vars set.
4. In a `finally`, always `docker compose down -v` (drop the volume so each run
   starts from a clean DB + clean Qdrant storage).
5. Propagate the test's exit code as the process exit code.
6. If `docker` / `docker compose` is unavailable, fail LOUD with a clear message
   (this is an explicit, opt-in run — never a silent skip).

### fixtures/synthetic-source.ts

An `ISkillSource` returning a small, fixed `SkillIngestResult`: two collections
(e.g. `alpha`, `beta`) with a handful of `SkillRecord`s each. All text is
original MIT-clean content authored for the test. Deterministic ids/sourceIds so
assertions are stable.

### skill-host.integration.test.ts

Uses `node:test` + `node:assert/strict`, run via tsx. Builds the host through
the real composition path (the same `makePgPool` / `makePgCatalogStore` /
`makeQdrantStoreProvider` / Ollama-embedder wiring production uses), reading the
`*_TEST_URL` env vars. The embedder is the real `@mcp-abap-adt/ollama-embedder`
pointed at `OLLAMA_TEST_URL` with `nomic-embed-text`.

## Test Cases (assertions)

1. **Ingest + commit.** `host.load()` with the synthetic source returns
   `ok: true` and `committed` listing both collections. Direct PG query confirms
   the catalog row exists with a non-empty `revision`; direct Qdrant query
   confirms vectors were upserted for the expected point count.
2. **Recall.** `host.rag('alpha').query(text, { k })` returns non-empty hits in
   descending score order, all from the `alpha` collection.
3. **Fenced CAS.** Calling `publishCatalog(staleRevision, …)` after the revision
   has advanced throws `CatalogCasError` (real conditional `UPDATE … WHERE
   revision = $expected` matching 0 rows). The committed catalog is unchanged.
4. **Retirement + sweeper.**
   - A second `load()` (changed records) publishes a new generation and retires
     the prior one (durable `retired[]` queue row).
   - `sweep(now + retiredGraceMs + 1)` removes the retired generation's vectors
     from Qdrant (post-grace reclaim).
   - **Age protection:** `sweep(now)` BEFORE the grace elapses leaves the retired
     vectors in place (asserted by a Qdrant count before/after).
5. **Recall-only read path.** `makePgCatalogReader` + `makeQdrantReader` (the
   read-only, no-DDL path used by a recall-only process) read the same committed
   catalog and return the same vectors — proving the read path needs no write/DDL
   privileges.

## Data Flow

```
run.mjs
  └─ docker compose up --wait  →  postgres | qdrant | ollama (healthy)
  └─ set PG_TEST_URL / QDRANT_TEST_URL / OLLAMA_TEST_URL
  └─ tsx --test skill-host.integration.test.ts
        └─ build host (real makePgPool + makePgCatalogStore + makeQdrantStoreProvider + ollama-embedder)
        └─ host.load(synthetic source)  →  PG catalog row + Qdrant vectors
        └─ assertions 1–5
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

## Testing Strategy

The integration test IS the test. It is verified by running
`npm run test:integration:skill-host` locally and observing all five cases pass
against live engines. The wrapper's own correctness (lifecycle, env, teardown)
is validated by that same run — a failure in setup surfaces as a loud
non-zero exit, not a false pass.

## Open Risks / Notes

- First run builds the Ollama image (model bake) — slow once, cached after.
- Qdrant version is pinned; bump deliberately.
- Reusability: the compose + wrapper are generic enough that a future
  integration test can drop a sibling `*.integration.test.ts` and reuse the same
  `run.mjs` pattern (or a parametrized variant).
