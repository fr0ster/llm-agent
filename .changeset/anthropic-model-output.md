---
"@mcp-abap-adt/anthropic-llm": major
---

Resolve the required `max_tokens` from the cached Models API metadata when no explicit override is set. Compatible endpoints that omit this metadata now require an explicit maxTokens setting. Report model output limits and normalize token-limit finishes in both response modes.
