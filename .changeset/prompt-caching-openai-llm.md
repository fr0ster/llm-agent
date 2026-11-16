---
"@mcp-abap-adt/openai-llm": minor
---

Eligible prefixes are cached automatically. Optional `promptCacheKey` and `promptCacheRetention: 'in_memory' | '24h'` use call-over-config precedence and map to OpenAI's wire parameters on chat and streams. Retention support is model dependent; both are omitted by default. Cache read and reported write tokens are preserved in responses and usage records.
