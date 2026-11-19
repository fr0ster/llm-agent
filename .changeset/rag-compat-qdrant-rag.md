---
"@mcp-abap-adt/qdrant-rag": patch
---

Enforce request owner, session, user, and namespace scope in `getById`. Out-of-scope reads now return `null`.
