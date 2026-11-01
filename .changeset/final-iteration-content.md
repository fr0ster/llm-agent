---
'@mcp-abap-adt/llm-agent': minor
'@mcp-abap-adt/llm-agent-libs': minor
---

Add typed iteration-end stream boundaries to distinguish tool-round progress from final answers. SmartAgent.process, worker task results, and dialogue coordinator replies exclude pre-tool text when a final iteration completes, while retaining accumulated text as a fallback when a call ends before that iteration. DefaultPipeline now honours streamMode: 'final'; full-mode content delivery remains immediate.
