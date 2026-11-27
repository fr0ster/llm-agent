---
"@mcp-abap-adt/hana-vector-rag": patch
---

Fix vector queries on SAP HANA Cloud by extracting TTL metadata as a supported decimal type. Preserve signed fractional expiration times and keep records with missing or non-numeric TTLs eligible for search.

Use plain table DDL for SAP HANA Cloud schema creation and collection deletion. Handle duplicate objects from concurrent schema setup and allow retries when a collection table is already gone.
