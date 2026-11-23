---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/openai-llm": minor
"@mcp-abap-adt/anthropic-llm": minor
"@mcp-abap-adt/sap-aicore-llm": patch
"@mcp-abap-adt/llm-agent-libs": patch
"@mcp-abap-adt/llm-agent-server-libs": patch
"@mcp-abap-adt/llm-agent-server": patch
"@mcp-abap-adt/llm-agent-mcp": patch
"@mcp-abap-adt/hana-vector-rag": patch
"@mcp-abap-adt/pg-vector-rag": patch
"@mcp-abap-adt/qdrant-rag": patch
---

Report provider prompt context overflow as a terminal `MODEL_CONTEXT_EXCEEDED` LLM error. Preserve it through model validation, retrieval, controller calls, and completion responses so retries and fallback stop. Return HTTP 400 for non-streaming requests and a structured error event for streaming requests.
