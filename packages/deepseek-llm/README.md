# @mcp-abap-adt/deepseek-llm

DeepSeek LLM provider for @mcp-abap-adt/llm-agent / @mcp-abap-adt/llm-agent-libs.

Extends `OpenAIProvider` from `@mcp-abap-adt/openai-llm`. Calls DeepSeek /v1/chat/completions API (OpenAI-compatible).

Exports:
- `DeepSeekProvider` — extends OpenAIProvider, implements ILlm.
- `DeepSeekConfig` — configuration type.

Optional peer dependency of @mcp-abap-adt/llm-agent-libs. Install when smart-server.yaml names `deepseek` as LLM provider, or when constructing DeepSeekProvider programmatically.
