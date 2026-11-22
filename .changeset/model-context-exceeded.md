---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/openai-llm": minor
"@mcp-abap-adt/anthropic-llm": minor
"@mcp-abap-adt/sap-aicore-llm": patch
"@mcp-abap-adt/llm-agent-libs": patch
---

Report provider prompt context overflow as a terminal `MODEL_CONTEXT_EXCEEDED` LLM error with HTTP status 400. Skip streaming fallback, retries, and startup model validation retries for this error. Populate model context length from Anthropic Models API metadata and OpenAI-compatible model endpoints when the response includes it.
