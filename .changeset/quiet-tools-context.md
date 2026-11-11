---
"@mcp-abap-adt/llm-agent-libs": patch
---

Exclude the reserved tools RAG store from context text and its token budget, since tools are already offered as definitions. Preserve other retrieved sections and tool selection.
