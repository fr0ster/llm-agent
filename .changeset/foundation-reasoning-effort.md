---
"@mcp-abap-adt/llm-agent": minor
"@mcp-abap-adt/llm-agent-libs": minor
"@mcp-abap-adt/llm-agent-server-libs": minor
"@mcp-abap-adt/llm-agent-server": minor
"@mcp-abap-adt/openai-llm": minor
"@mcp-abap-adt/sap-aicore-llm": minor
"@mcp-abap-adt/copilot-llm": minor
---

Add the optional `reasoningEffort` setting to LLM calls and model configuration. SAP AI Core OpenAI foundation deployments use the Responses API for requests with function tools and preserve encrypted reasoning across tool rounds. HTTP 400 and 422 inference errors include the provider explanation.
