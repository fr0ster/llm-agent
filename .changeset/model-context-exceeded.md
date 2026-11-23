---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/openai-llm": minor
"@mcp-abap-adt/anthropic-llm": minor
"@mcp-abap-adt/sap-aicore-llm": patch
"@mcp-abap-adt/llm-agent-libs": patch
"@mcp-abap-adt/llm-agent-server-libs": patch
"@mcp-abap-adt/llm-agent-server": patch
---

Report provider prompt context overflow as a terminal `MODEL_CONTEXT_EXCEEDED` LLM error with HTTP status 400. Skip streaming fallback, retries, and startup model validation retries for this error. Populate model context length from Anthropic Models API metadata and OpenAI-compatible model endpoints when the response includes it.

Preserve terminal LLM failures through controller subagent calls and RAG reranking so retries and fallback stop immediately.

Preserve terminal failures through RAG query expansion, preprocessing, document enrichment, model probes, and HTTP completion responses. Return context overflow as HTTP 400 for non-streaming requests and as a structured error event for streaming requests.
