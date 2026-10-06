# @mcp-abap-adt/sap-aicore-decision

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

Cohere Rerank on **SAP AI Core** as a relevance decision (`IRelevanceDecision`) for `@mcp-abap-adt/llm-agent`.

**TL;DR** — `SapAiCoreRelevanceDecision` scores how relevant each passage is to a query. Put it into
`RelevanceReranker` (`@mcp-abap-adt/llm-agent-reranker`) and you have a Cohere reranker: in a
collection profile (`faceted-rerank`), in `rag.retrieval` (`reranker: decision` with
`decision.provider: sap-aicore`) or anywhere an `IReranker` is taken.

> **A relevance score is not a probability.** Scores for the same query from the same model are
> comparable (also across calls — `RelevanceReranker` batches and merges); never across queries or
> models. A threshold on them is your calibration for this provider; no named composition uses one.

```ts
import { RelevanceReranker } from '@mcp-abap-adt/llm-agent-reranker';
import { mcpToolsVariants } from '@mcp-abap-adt/llm-agent-libs';
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';
import { SapAiCoreRelevanceDecision } from '@mcp-abap-adt/sap-aicore-decision';

const { credential, apiBaseUrl } = serviceKeyCredential(process.env.AICORE_SERVICE_KEY ?? '');
const cohere = new SapAiCoreRelevanceDecision({
  deploymentId: 'd1234567890',   // the AI Core deployment serving the rerank model
  model: 'cohere-rerank',        // sent as `model`
  resourceGroup: 'default',      // header AI-Resource-Group (default 'default')
  apiBaseUrl,
  credential,
});

const reranker = new RelevanceReranker(cohere);                       // batched (48000 tokens / call), merged by score
const profile = mcpToolsVariants.facetedRerank({ reranker, poolItems: 30 }); // poolItems: your number, from your measurement
```

## What it does

- **One `/rerank` call per `score`:** `POST {apiBaseUrl}/v2/inference/deployments/{deploymentId}/rerank`,
  body `{ model, query, documents, top_n }`, header `AI-Resource-Group`.
- Returns `scores: [{ index, score }]` — `score` = Cohere's `relevance_score`, one per passage.
- No wording: a cross-encoder reads the query and the passages only.

## Health check — no inference

`healthCheck(options?)` reads the deployment's status:
`GET {apiBaseUrl}/v2/lm/deployments/{deploymentId}` (header `AI-Resource-Group`), never `/rerank`.

- `RUNNING` → `{ ok: true, value: true }`; any other status (`STOPPED`, `PENDING`, …) →
  `{ ok: true, value: false }`.
- A failure → `{ ok: false, error }` with the codes of the table below (a body without a `status`
  is `DECISION_ERROR`). It never rejects.
- `RelevanceReranker.healthCheck` uses it, so a server's `/health` answers 503 while the
  deployment is not running.

## Errors — never a zero-filled score

| Failure | `DecisionError` code |
|---|---|
| empty query, no passages, an empty passage | `DECISION_INVALID_REQUEST` (nothing sent) |
| HTTP 401 / 403, or the credential gives no token | `DECISION_AUTH` |
| HTTP 429 | `DECISION_RATE_LIMITED` |
| HTTP 400 / 404 / 422 | `DECISION_INVALID_REQUEST` |
| HTTP 5xx, network failure | `DECISION_UNAVAILABLE` |
| `options.signal` aborted | `DECISION_ABORTED` |
| a wrong result count; a missing, duplicated, non-integer or out-of-range index; a non-finite score; a body that is not JSON | `DECISION_ERROR` |

Messages carry the HTTP status, never the token or the response body.

## Rules

- **No env, no timeout, no retries:** the credential is injected and asked for a token on every call;
  `options.signal` aborts; a failure is a `DecisionError`, which the reranker turns into `RERANK_ERROR` and the retrieval returns (no fallback).
- **Data sent:** the query and the candidate texts go to your SAP AI Core deployment.
- **Deployment id, not a model name** — resolving a deployment by model name is a follow-up.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`GPL-3.0.txt`](GPL-3.0.txt) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Full detail: [docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
