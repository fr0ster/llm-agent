---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/qdrant-rag": minor
"@mcp-abap-adt/hana-vector-rag": patch
"@mcp-abap-adt/pg-vector-rag": patch
---

Add an optional collection vector dimension so Qdrant can create stores without an embedding probe. Reject invalid Qdrant dimensions and dimensions that differ from the configured HANA or PostgreSQL vector size.
