---
"@mcp-abap-adt/ollama-llm": minor
---

No prompt-cache request setting is added. Ollama's native `keep_alive` controls model residency and is not sent to the OpenAI-compatible endpoint. Compatible cached-token reports remain visible when supplied; OpenAI-only cache keys and retention are omitted.
