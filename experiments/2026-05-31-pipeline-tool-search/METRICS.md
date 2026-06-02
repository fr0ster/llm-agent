# Metrics — bare prompt, SAP AI Core, 2026-05-31

Prompt: `Review ABAP program ZDAZ_R_DELAYED_UPDATE, check security, performance, CleanCore, maintainability`
Provider: SAP AI Core only (sap-ai-sdk claude sonnet/haiku + sap-ai-core embedder). MCP :3001 (mcp-abap-adt v6.11.0, SAP live, 0×404).
Program has 6 includes (_TOP _O01 _O02 _I01 _I02 _F01).

| pipeline | config | GetProgram | GetInclude (real) | answer | verdict |
|---|---|--:|--:|--:|---|
| DAG (domain worker prompt) | docs/examples/dag-coordinator/02-hybrid-sonnet-haiku.yaml | 1 | 6 | 42 KB | ✅ full review, all includes |
| DAG (generic worker prompt) | docs/examples/dag-coordinator/02b-hybrid-generic-worker.yaml | 1 | 6 | 47 KB | ✅ full review, all includes |
| cyclic-react | docs/examples/stepper/01-cyclic-react.yaml | 0 | 0 | 4 KB | ❌ fabricated (0 tool calls) |
| planned-react | docs/examples/stepper/02-planned-react.yaml | 0 | 0 | 13 ch | ❌ readOnly gate on CheckProgram → coordinator error |
| deep-stepper (capped 300k) | docs/examples/stepper/03-deep-capped.yaml | 0 | 0 | 109 ch | ❌ 107 spawns, 0 MCP calls, budget-exhausted non-answer |

Key: domain-vs-generic DAG are identical (✅) → the worker's ABAP prompt is NOT the cause.
