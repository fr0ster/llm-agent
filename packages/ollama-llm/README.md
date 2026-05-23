# @mcp-abap-adt/ollama-llm

Ollama LLM provider for `@mcp-abap-adt/llm-agent`. Thin wrapper over
`@mcp-abap-adt/openai-llm` targeting Ollama's OpenAI-compatible `/v1` endpoint
(default `http://localhost:11434/v1`). No API key required.

```yaml
llm:
  provider: ollama
  model: qwen2.5:14b
  # url: http://localhost:11434/v1   # optional; this is the default
```
