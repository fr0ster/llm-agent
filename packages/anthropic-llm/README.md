# @mcp-abap-adt/anthropic-llm

Anthropic (Claude) LLM provider for @mcp-abap-adt/llm-agent / @mcp-abap-adt/llm-agent-server.

Exports:
- `AnthropicProvider` — implements ILlm, calls Anthropic /v1/messages.
- `AnthropicConfig` — configuration type.

Optional peer dependency of @mcp-abap-adt/llm-agent-server. Install when your smart-server.yaml names `anthropic` as the LLM provider, or when constructing AnthropicProvider programmatically.
