# RAG tool-retrieval eval

## TL;DR

```bash
RAG_EMBEDDER_SERVICE_KEY='<SAP AI Core service key JSON>' \
  npm run eval:rag -- --only in-memory-ollama,qdrant-ollama
```

- Puts the MCP tool catalog into a store, then asks English questions.
- Checks whether tool selection returns the tool a question needs.
- No LLM in the default run. The embedder and the store are measured; with
  `--retrieval rerank|rerank-all` the retrieval strategy (and its reranker)
  is measured too.
- Not part of `npm test`.

## What it measures

One pass per config in the matrix:

1. **Vectorize.** The tool snapshot (`--tools`) goes through `vectorizeMcpTools`,
   the same function the server calls at startup. The run fails unless it
   reports every tool vectorized.
2. **Query.** Each case in the queries file (`queries.en.json`, or
   `queries.en.16.json` for the 16.0.0 catalog) is embedded
   (`QueryEmbedding`) once, then every arm sends it through
   `applyRetrievalStrategy(store, strategy).query(embedding, N)`. An arm
   queries twice per case: at the report depth `max(--k, 15)` (recall and
   MRR) and at `--k` (the selection path), so a reranked arm costs two
   reranker calls per case.
3. **Select.** The `--k` results go through `DEFAULT_TOOL_SELECTION` and
   `toolNameFromRecord`, exactly as `ToolSelectHandler` does.

A case **hits** when any of its `expect` tools is selected.

The embedder and store are built the way `SmartServer.start` builds them:
`resolveRetrievalEmbedder` → the composition root's `resolveEmbedder`, then
`toMakeRagInput` → the composition root's `makeRag`.

## Files

| File | What |
|---|---|
| `rag-eval.ts` | the harness |
| `tools.mcp-abap-adt-readonly.json` | 63 tools from `@mcp-abap-adt/core` 8.13.0, readonly (default for `--tools`) |
| `tools.mcp-abap-adt-16.0.0-readonly-high.json` | 218 tools from `@mcp-abap-adt/core` 16.0.0, `--exposition=readonly,high` |
| `queries.en.json` | 30 English cases `{query, expect[]}` for the 8.13.0 catalog |
| `queries.en.16.json` | the same 30 cases with `Read*` names renamed `Get*` for the 16.0.0 catalog (rule in its `note`) |
| `matrix.example.json` | named configs: `{name, store, embedder?}` |

`store` and `embedder` use the server's YAML shape (`rag.store`,
`rag.embedder`), written as JSON. Leave out `embedder` on an in-memory store
to get the keyword-only store.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--matrix` | `matrix.example.json` | configs to run |
| `--only a,b` | all | run only these config names |
| `--k` | `5` | K for the selection path (recall@1/3/5/10/15 are always shown) |
| `--queries` | `queries.en.json` | cases |
| `--tools` | the snapshot | tool catalog |
| `--json out.json` | none | also write raw results, per-case top-3 included |
| `--retrieval a,b` | `embedding` | `embedding` \| `rerank` \| `rerank-all`; `embedding` always runs as the baseline |
| `--reranker a,b` | `decision` | `decision` \| `llm`; every rerank retrieval runs once per reranker |
| `--overfetch N` | `2` | `rerank`: the store returns K x N candidates for the reranker |
| `--max-candidates N` | `30` | `rerank-all`: the store's first N candidates go to the reranker; must be >= max(`--k`, 15), else the run is refused |
| `--config f` + `--llm-key KEY` | none | an `llm:` entry of a `smart-server.yaml` (and its credentials) for the `llm` reranker |

Exit code: `0` all configs ran; `1` a config failed (e.g. not all
vectorized); `2` the harness crashed.

## Retrieval strategies

Each config is written once; every arm then queries the same store through
`applyRetrievalStrategy(store, strategy)`, as the server does:

- `embedding` — the store's own ranking (`EmbeddingRetrieval`), the baseline.
- `rerank` — `RerankedRetrieval`: embedding top K x `--overfetch`, reranked.
- `rerank-all` — `RerankAllRetrieval`: the first `--max-candidates`, reranked.

Rerankers: `decision` is `DecisionReranker` over `TypeSafeDecisionModel` with
`TOOL_QUESTION`; `llm` is `LlmReranker` over the `--llm-key` entry. A reranker
failure falls back to the embedding order, as in the server.

An arm that cannot run is **skipped with a printed reason and the exit code
stays 0**: `decision` needs `DECISION_API_KEY`; `llm` needs `--config`,
`--llm-key` and that entry's credentials.

```bash
node --env-file=.env --import tsx/esm scripts/rag-eval/rag-eval.ts \
  --tools scripts/rag-eval/tools.mcp-abap-adt-16.0.0-readonly-high.json \
  --queries scripts/rag-eval/queries.en.16.json \
  --retrieval embedding,rerank,rerank-all --reranker decision \
  --only in-memory-aicore-ada
```

`in-memory-aicore-ada` is `text-embedding-ada-002` on SAP AI Core
(`credentialRef: AICORE`, so `AICORE_SERVICE_KEY`); `text-embedding-3-small`
in `in-memory-aicore` may not be deployed on a given tenant.

## Regenerating the 218-tool snapshot

Start the server over stdio with the readonly and high exposition and an
authenticated session of your own, call `tools/list` only (no tool call), and
write `{source, capturedAt, tools: [{name, description, inputSchema}]}`:

```bash
mcp-abap-adt --env=<your-session> --exposition=readonly,high
```

Which session you use is not recorded in the repo. The file holds names,
descriptions and input schemas only.

## Credentials (env)

Same rule as the server. A section without `credentialRef` reads the default
ref: `RAG_STORE` for the store, `RAG_EMBEDDER` for the embedder.

| Target | Env |
|---|---|
| Ollama embedder | none (refuses a named ref) |
| SAP AI Core embedder | `RAG_EMBEDDER_SERVICE_KEY` = the service key JSON |
| OpenAI embedder | `RAG_EMBEDDER_API_KEY` |
| `decision` reranker | `DECISION_API_KEY` |
| `llm` reranker | the `--llm-key` entry's `credentialRef` variables |
| in-memory store | none |
| Qdrant store | optional `RAG_STORE_API_KEY` |
| pg-vector store | `RAG_STORE_USER` + `RAG_STORE_PASSWORD` |

**One ref holds one credential.** With `RAG_STORE_USER` set, an anonymous
Qdrant config fails ("must hold a api-key credential"). Either run pg and
Qdrant configs in separate invocations (`--only`), or give the pg section its
own `credentialRef` (e.g. `"credentialRef": "PG"` + `PG_USER`/`PG_PASSWORD`).

Load a JSON service key with dotenv's `parse`, not shell `source` — the shell
mangles the JSON.

## Store setup

- **Qdrant:** any reachable instance; set `store.url`.
- **pg-vector:** `CREATE EXTENSION vector` in the database. Set
  `store.dimension` to the embedder's size (nomic-embed-text 768,
  text-embedding-3-small 1536).

Each run uses a fresh collection `rag_eval_<config>_<runId>` and drops it at
the end (Qdrant `DELETE /collections/…`, pg `DROP TABLE`).

## Reading the output

Per config:

- `recall@N` — share of cases whose first expected tool ranks within N.
- `MRR` — mean of 1/rank (0 when not in the top 15).
- `selected@K` — hits through the selection path at `--k`.
- `better/worse vs embedding` — cases whose rank improved / dropped against
  the `embedding` arm (a miss counts as rank 99).
- `vectorize` — time for the whole catalog write.
- `embed/query`, `store/query` — mean per case.

Warnings to take seriously:

- `counted as vectorized but not retrievable` — the store reported a write
  but no longer returns that tool — the store merged records with different
  ids, which breaks the writer contract (the in-memory stores did this through
  `dedupThreshold` before they stopped merging distinct ids).
- `results carried no tool id` — a store returned records without a
  `tool:*` `metadata.id`; selection cannot name them.
- `score-order inversions` — results not sorted by score.

Measured 2026-10-04, `in-memory-aicore-ada` (`text-embedding-ada-002` on SAP
AI Core), 218-tool 16.0.0 catalog, `queries.en.16.json` (30 cases), K=5,
`decision` reranker (TypeSafe Jev), `--max-candidates 30`, `--overfetch 2`:

| arm | recall@1 | recall@3 | recall@5 | recall@10 | recall@15 | MRR | better/worse |
|---|---|---|---|---|---|---|---|
| embedding | 56.7% | — | 93.3% | 96.7% | 96.7% | 0.691 | - |
| rerank:decision | 90.0% | — | 96.7% | 96.7% | 96.7% | 0.928 | 11/0 |
| rerank-all:decision | 90.0% | — | 96.7% | 96.7% | 96.7% | 0.933 | 12/0 |

recall@3 was added after this run (— = not recorded). The `llm` reranker arms have not been run yet. One sample, 30 cases: read it
as a direction, not a benchmark.

Then the missed cases, each with the expected tools, the rank and the top 5
returned.

## The single-language rule

Tool descriptions are English, so the queries are English.

A non-multilingual embedder (e.g. `nomic-embed-text`) only matches text in
the same language. Descriptions in one language and questions in another
measure the language gap, not retrieval. To test another language, translate
the descriptions and the queries together, or use a multilingual embedder.
