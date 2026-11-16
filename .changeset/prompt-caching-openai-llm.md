---
"@mcp-abap-adt/openai-llm": minor
---

Eligible prefixes are cached automatically by OpenAI. The shared `promptCaching?: boolean` switch has no request effect: the client cannot turn off provider caching. No cache parameters are sent. Cache read and reported write tokens are preserved in responses and usage records.
