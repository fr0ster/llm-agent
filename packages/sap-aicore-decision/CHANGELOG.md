# @mcp-abap-adt/sap-aicore-decision

## Unreleased

- New package: `SapAiCoreRelevanceDecision`, Cohere Rerank on an SAP AI Core deployment as an `IRelevanceDecision` (one relevance score per passage — not a probability; one `/rerank` call per `score`). Adapted by `RelevanceReranker` (`@mcp-abap-adt/llm-agent-reranker`).
- `SapAiCoreRelevanceDecision.healthCheck`: the deployment's status (`GET /v2/lm/deployments/{deploymentId}`, `RUNNING` → `true`, any other status → `false`), no inference; a failure is `ok: false` with the same `DecisionError` codes as `score`.
