---
"@mcp-abap-adt/llm-usage": minor
---

Physical `llm.call` records and JSONL/CSV exports preserve optional `cachedInputTokens` and `cacheCreationInputTokens`. The SQL sinks store these in their existing JSON record, so no SQL column or schema migration is required. Older records without cache fields remain valid.
