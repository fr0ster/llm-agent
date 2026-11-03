---
'@mcp-abap-adt/llm-agent-mcp': patch
'@mcp-abap-adt/llm-agent-server': patch
'@mcp-abap-adt/typesafe-decision': patch
'@mcp-abap-adt/llm-agent': patch
---

Upgrade the MCP SDK to ^1.32.2 to address GHSA-46jr-4wx8-v453. Upgrade the TypeSafe AI SDK to ^0.7.0 and allow optional decision token counts, mapping nullable usage to undefined while preserving numeric counts, including zero.
