---
"@mcp-abap-adt/qdrant-rag": patch
---

Recover interrupted multivector migrations before processing any selected collection, even when the original collection and its catalog entry are absent. Dry runs report pending recoveries, and temporary collections with unreadable recovery markers are retained with an explicit error.
