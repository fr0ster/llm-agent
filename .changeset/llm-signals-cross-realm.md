---
"@mcp-abap-adt/llm-signals": patch
---

Accept plain-data payloads created in another realm (a vm context or a test runner sandbox, for example objects from `structuredClone` under Jest); class instances from any realm are still rejected.
