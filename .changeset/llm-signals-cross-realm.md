---
"@mcp-abap-adt/llm-signals": patch
---

Accept plain-data payloads created in another realm (a vm context or a test runner sandbox, for example objects from `structuredClone` under Jest); the check reads data descriptors only (no payload accessor runs), and class instances from any realm, including null-base classes, are still rejected.
