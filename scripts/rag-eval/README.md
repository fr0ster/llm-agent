# RAG tool-retrieval eval

## TL;DR

```bash
RAG_EMBEDDER_SERVICE_KEY='<SAP AI Core service key JSON>' \
  npm run eval:rag -- --only in-memory-ollama,qdrant-ollama
```

- Puts the MCP tool catalog into a store, then asks English questions.
- Checks whether tool selection returns the tool a question needs.
- No LLM. Only the embedder and the store are measured.
- Not part of `npm test`.

## What it measures

One pass per config in the matrix:

1. **Vectorize.** The 63-tool snapshot goes through `vectorizeMcpTools`,
   the same function the server calls at startup. The run fails unless it
   reports 63/63.
2. **Query.** Each case in `queries.en.json` is embedded (`QueryEmbedding`)
   and sent to `store.query(embedding, K)`.
3. **Select.** Results go through `DEFAULT_TOOL_SELECTION` and
   `toolNameFromRecord`, exactly as `ToolSelectHandler` does.

A case **hits** when any of its `expect` tools is selected.

The embedder and store are built the way `SmartServer.start` builds them:
`resolveAgentEmbedder` → the composition root's `resolveEmbedder`, then
`toMakeRagInput` → the composition root's `makeRag`.

## Files

| File | What |
|---|---|
| `rag-eval.ts` | the harness |
| `tools.mcp-abap-adt-readonly.json` | 63 tools from `@mcp-abap-adt/core` 8.13.0, readonly |
| `queries.en.json` | 30 English cases `{query, expect[]}` |
| `matrix.example.json` | named configs: `{name, store, embedder?}` |

`store` and `embedder` use the server's YAML shape (`rag.store`,
`rag.embedder`), written as JSON. Leave out `embedder` on an in-memory store
to get the keyword-only store.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--matrix` | `matrix.example.json` | configs to run |
| `--only a,b` | all | run only these config names |
| `--k` | `5` | K for the selection path (recall@10/@15 are always shown) |
| `--queries` | `queries.en.json` | cases |
| `--tools` | the snapshot | tool catalog |
| `--json out.json` | none | also write raw results |

Exit code: `0` all configs ran; `1` a config failed (e.g. not 63/63
vectorized); `2` the harness crashed.

## Credentials (env)

Same rule as the server. A section without `credentialRef` reads the default
ref: `RAG_STORE` for the store, `RAG_EMBEDDER` for the embedder.

| Target | Env |
|---|---|
| Ollama embedder | none (refuses a named ref) |
| SAP AI Core embedder | `RAG_EMBEDDER_SERVICE_KEY` = the service key JSON |
| OpenAI embedder | `RAG_EMBEDDER_API_KEY` |
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

Then the missed cases, each with the expected tools, the rank and the top 5
returned.

## The single-language rule

Tool descriptions are English, so the queries are English.

A non-multilingual embedder (e.g. `nomic-embed-text`) only matches text in
the same language. Descriptions in one language and questions in another
measure the language gap, not retrieval. To test another language, translate
the descriptions and the queries together, or use a multilingual embedder.
