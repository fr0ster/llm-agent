# Shared table layout - live checks

Runs `sharedTableConformanceCases` (`@mcp-abap-adt/llm-agent/testing/shared-table-conformance`)
against real databases. Both runners print `CONFORMANCE PASS n/n` on success.

Run `npm run build` at the repo root first; the commands below run from this directory.

## Postgres (pgvector)

See `pg/`. With `PG_TEST_URL` set, `node pg/run.mjs`; `pg/with-pglite.mjs` runs
it against PGlite (Postgres in WASM) when no server is at hand.

## SAP HANA Cloud (HDI container `hdi-llm`)

Two throwaway Cloud Foundry apps (org `cloud-llm-hub-dev`, space `llm-agent`),
both without a route, both bound to the service instance `hdi-llm`.
Every runner line starts with `SST `.

```bash
cf target                       # confirm org/space first

# 1. Pack the two workspaces and copy the shipped DDL
node hana/runner/pack.mjs       # -> hana/runner/vendor/*.tgz
node hana/deployer/prepare.mjs  # -> hana/deployer/src/ (never edit by hand)

# 2. Deploy the tables (HDI deployer uses the binding's hdi_user)
(cd hana/deployer && cf push -f manifest.yml)
cf logs sst-hdi-deployer --recent   # wait for: Deployment to container ... done

# 3. Run the check (runtime user only, DML)
(cd hana/runner && cf push -f manifest.yml)
cf logs sst-hana-runner --recent | grep SST
```

Expected: `SST CONFORMANCE PASS n/n`, and the dimension line reporting 1536.
The shipped hdbtable fixes `REAL_VECTOR(1536)` while the conformance embedder
has 64 dimensions, so the runner zero-pads every vector to 1536 (cosine
similarity is unchanged). The tables stay deployed; the runner deletes the
rows and catalog records of its own prefixed collections.

### Cleanup

```bash
cf delete sst-hana-runner -f
cf delete sst-hdi-deployer -f   # retry while an unbind is in progress
cf apps                         # must list no apps
cf service hdi-llm              # must show no bound apps
```
