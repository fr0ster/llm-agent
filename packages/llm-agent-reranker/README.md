# @mcp-abap-adt/llm-agent-reranker

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

**TL;DR** — every reranker of the llm-agent family, with no vendor code. A reranker **adapts a
decision**; the decision comes from a provider package you inject.

| Reranker | Adapts | Provider example | `score` it writes |
|---|---|---|---|
| `ProbabilityReranker` (was `DecisionReranker`) | `IProbabilityDecision` | `TypeSafeDecisionModel` (`@mcp-abap-adt/typesafe-decision`, Jev) | P(relevant), in [0, 1] |
| `RelevanceReranker` | `IRelevanceDecision` | `SapAiCoreRelevanceDecision` (`@mcp-abap-adt/sap-aicore-decision`, Cohere) | relevance score — **not a probability** |
| `LlmReranker` | `ILlm` | any LLM | 0–1 from the model |
| `NoopReranker` | — | — | unchanged |

- Wording presets for the probability reranker: `TOOL_QUESTION`, `PASSAGE_QUESTION`.
- A relevance score is comparable for the same query and model (also across calls — `RelevanceReranker` batches); never a probability; a threshold on it is your calibration.
- **Moved from `@mcp-abap-adt/llm-agent-libs`** — libs no longer exports them, under any name.
  Migrate: `DecisionReranker` → `ProbabilityReranker`, `DecisionRerankerOptions` →
  `ProbabilityRerankerOptions`, `DECISION_RERANK_DEFAULT_*` → `PROBABILITY_RERANK_DEFAULT_*`;
  import every reranker from this package.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`GPL-3.0.txt`](GPL-3.0.txt) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
