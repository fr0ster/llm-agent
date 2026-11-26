---
"@mcp-abap-adt/anthropic-llm": patch
"@mcp-abap-adt/sap-aicore-llm": patch
---

Keep Anthropic cumulative token counts when later events report lower totals or omit counters. Fill missing SAP AI Core Bedrock input and output counts from invocation metrics in streams and JSON responses so returned usage agrees with per-request records.
