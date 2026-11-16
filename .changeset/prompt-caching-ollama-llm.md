---
"@mcp-abap-adt/ollama-llm": minor
---

The shared `promptCaching?: boolean` switch has no request effect for Ollama. No cache parameters are sent. Native `keep_alive` controls model residency and is not sent to the OpenAI-compatible endpoint. Compatible cached-token reports remain visible when supplied.
