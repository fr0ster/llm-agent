---
"@mcp-abap-adt/openai-llm": patch
"@mcp-abap-adt/sap-aicore-llm": patch
"@mcp-abap-adt/llm-agent-libs": patch
"@mcp-abap-adt/llm-agent-server-libs": patch
---

Send caller-supplied Responses sampling options for all model names. SAP AI Core Foundation learns unsupported sampling parameters per deployment for Responses and Chat Completions and repeats the request once without the rejected parameter.

Redact provider-owned output from session and controller diagnostics while preserving it in live LLM tool rounds.
