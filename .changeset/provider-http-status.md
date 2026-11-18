---
"@mcp-abap-adt/openai-llm": patch
"@mcp-abap-adt/deepseek-llm": patch
"@mcp-abap-adt/ollama-llm": patch
"@mcp-abap-adt/sap-aicore-llm": patch
"@mcp-abap-adt/sap-aicore-auth": patch
---

Preserve structured HTTP statuses and Retry-After metadata across provider error wrappers so retry policies can distinguish permanent and transient failures. Keep OAuth error bodies out of token request errors and omit raw transport diagnostics from SAP AI Core error logs.
