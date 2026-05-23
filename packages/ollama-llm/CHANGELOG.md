# @mcp-abap-adt/ollama-llm

## 14.0.0

### Major Changes

- Initial release of the Ollama LLM provider.

  Implements `ILlm` by extending `OpenAIProvider` — Ollama exposes an OpenAI-compatible `/v1` API, so no custom HTTP layer is needed. Key behaviours:

  - Default `baseURL` is `http://localhost:11434/v1`; override via `OllamaConfig.baseURL`.
  - `apiKey` defaults to `'ollama'` (Ollama ignores it, but the underlying OpenAI client requires a non-empty value).
  - `getEmbeddingModels()` always returns `[]` — Ollama embedding models are addressed via separate provider packages.
  - `getTokenLimitParam` always returns `max_tokens` (no model-family branching needed).

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@14.0.0
  - @mcp-abap-adt/openai-llm@14.0.0
