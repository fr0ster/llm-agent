---
"@mcp-abap-adt/anthropic-llm": patch
"@mcp-abap-adt/deepseek-llm": patch
"@mcp-abap-adt/openai-llm": patch
"@mcp-abap-adt/sap-aicore-llm": patch
---

Complete streamed tool calls with valid JSON arguments when the provider sends only empty argument fragments. Anthropic uses the tool block's initial input. OpenAI, DeepSeek, and SAP AI Core supply an empty JSON object when the tool-call stream finishes.
