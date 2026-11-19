---
"@mcp-abap-adt/pg-vector-rag": patch
---

Enforce request owner, session, user, and namespace scope in `getById`, including when an unscoped record cache entry exists. Out-of-scope reads now return `null`.
