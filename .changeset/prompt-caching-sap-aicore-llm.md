---
"@mcp-abap-adt/sap-aicore-llm": minor
---

Existing `SapCoreAIConfig.promptCaching` modes (`off`, `system`, `system+tools`) use documented explicit Anthropic breakpoints. SAP does not document forwarding the direct Anthropic automatic-cache/TTL contract in this integration, so it remains separate. Cache read/creation reports are preserved through orchestration and shared agent aggregation.
