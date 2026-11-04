---
"@mcp-abap-adt/llm-agent-libs": minor
---

Let plan authors specify report or verdict results without assigning workers. The coordinator selects a matching profile at delegation, while legacy assignments remain supported.

Store selected profiles on task attempts only, allowing compatible profile changes on retries. Strip worker fields from author output and coordinator plan updates. Preserve stored legacy assignments until a result kind change clears them.
