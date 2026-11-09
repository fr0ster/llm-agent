---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/sap-aicore-llm": minor
---

Expose optional provider scenario identifiers on model info. Preserve SAP AI Core catalog allowed scenarios, add a fresh getModelCatalog method that propagates original failures without changing the best-effort getModels cache, and export isOrchestrationChatModel for chat allowlists.
