---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": patch
"@mcp-abap-adt/ollama-embedder": patch
"@mcp-abap-adt/openai-embedder": patch
"@mcp-abap-adt/sap-aicore-embedder": patch
"@mcp-abap-adt/voyage-embedder": patch
---

Stop adaptive runs on a failed work step or check exception. Preserve error details and account for failed calls once. Follow recovery branches only after a semantic check verdict.

Report explicit embedding input-size rejections from Ollama, OpenAI, SAP AI Core, and Voyage as the terminal `EMBEDDING_CONTEXT_EXCEEDED` error.
