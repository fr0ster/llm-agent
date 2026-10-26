---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-usage": minor
"@mcp-abap-adt/openai-llm": minor
"@mcp-abap-adt/anthropic-llm": minor
"@mcp-abap-adt/sap-aicore-llm": minor
"@mcp-abap-adt/deepseek-llm": patch
"@mcp-abap-adt/ollama-llm": patch
---

Record the size of messages and tool definitions actually sent on every LLM request, and export request shape in usage CSV. DeepSeek and Ollama inherit the OpenAI provider change through internal dependency patch releases.
