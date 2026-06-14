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
embedding model), starts Postgres + Qdrant + Ollama, waits for health, verifies
the baked model digest, bootstraps the Qdrant collection, runs the test, and
ALWAYS tears the stack down (`docker compose down -v`) — even on failure.

## What it covers
1. Ingest + commit (PG catalog row + Qdrant vectors)
2. Recall via `host.rag(group).query`
3. Fenced catalog CAS (`CatalogCasError` on a stale revision)
4. Retirement + age-protected sweeper (pre-grace keep, post-grace reclaim)
5. Recall-only read path under SELECT-only Postgres credentials (write/DDL rejected)

The five cases are ONE ordered scenario (awaited subtests sharing one catalog
row, collection, host and clock) — not independently runnable, by design.

No GPL `sap-skills` content — synthetic MIT-clean fixtures only.
