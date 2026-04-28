# @mcp-abap-adt/openai-llm

OpenAI LLM provider for `@mcp-abap-adt/llm-agent` / `@mcp-abap-adt/llm-agent-libs`.

Exports:
- `OpenAIProvider` — implements ILlm, calls OpenAI /v1/chat/completions.
- `OpenAIConfig` — configuration type.

Optional peer dependency of `@mcp-abap-adt/llm-agent-libs`. Install when your smart-server.yaml names `openai` as the LLM provider, or when constructing OpenAIProvider programmatically.
