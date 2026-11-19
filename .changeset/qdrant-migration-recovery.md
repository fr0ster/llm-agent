---
"@mcp-abap-adt/qdrant-rag": patch
---

Recover interrupted multivector migrations before processing any selected collection, even when the original collection and its catalog entry are absent. Dry runs report pending recoveries, and temporary collections with unreadable recovery markers are retained with an explicit error.

Run the migration offline with one process. Stop on an unconfirmed mutation, except that HTTP 429 can retry an identical upsert to the private temporary collection. Retain temporary collections when a backup upsert was throttled, and finish cleanup on a subsequent run after pending operations settle.
