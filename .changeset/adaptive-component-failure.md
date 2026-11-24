---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": minor
"@mcp-abap-adt/ollama-embedder": minor
"@mcp-abap-adt/openai-embedder": minor
"@mcp-abap-adt/sap-aicore-embedder": minor
"@mcp-abap-adt/voyage-embedder": minor
"@mcp-abap-adt/hana-vector-rag": patch
"@mcp-abap-adt/pg-vector-rag": patch
"@mcp-abap-adt/qdrant-rag": patch
"@mcp-abap-adt/anthropic-llm": patch
"@mcp-abap-adt/llm-agent-mcp": patch
"@mcp-abap-adt/llm-agent-server": patch
"@mcp-abap-adt/llm-agent-server-libs": patch
"@mcp-abap-adt/openai-llm": patch
"@mcp-abap-adt/sap-aicore-llm": patch
"@mcp-abap-adt/copilot-llm": patch
---

A component failure ends an adaptive run with one typed error. A failed work step no longer goes to a check, a check that throws is no longer turned into a `fail` verdict, and `onFail` branches follow only a real verdict, so a failing step can no longer loop through fix and recheck. The error keeps its code, HTTP status, cause and step id. Planner failure no longer starts a fallback plan, a query embedding failure is no longer retried with the same text, and every failed pipeline stage leaves a typed error. Embedders report an input that exceeds the model's context as `EMBEDDING_CONTEXT_EXCEEDED`, which ends the run.

Both context overflow codes propagate through retrieval, tool calls, and streaming. Error normalization recognizes cancellation before inspecting overflow and preserves token totals and call records.
