# @mcp-abap-adt/ollama-llm

## 18.2.0

Client-provided external tools under the DAG coordinator (#171). External (client) tools are now mode-independent (always offered; `hard` governs only internal MCP execution), consumer-executed (the worker surfaces a standard tool_call via the normal OpenAI/Anthropic round-trip — no custom transport), and carry deterministic content-addressed `ext:` ids for stateless re-run correlation. Parallel DAG workers' external calls are collected into one terminal assistant turn; incoming external results are adjacency-validated and the consumed turns stripped from internal LLM message lists.

## 18.1.2

### Patch Changes

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.2
  - @mcp-abap-adt/openai-llm@18.1.2

## 18.1.1

### Patch Changes

- Version alignment — unify ALL workspace packages to a single version.

  18.1.0 bumped only the six core packages (the changeset `fixed` group at the time), leaving the eleven provider / embedder / RAG-backend packages at 18.0.2. The `fixed` group now contains all 17 packages so every release moves them together. This release carries no functional change — it only realigns the provider/embedder/backend packages (18.0.2 → 18.1.1) and the core packages (18.1.0 → 18.1.1) to one version.

- Updated dependencies
  - @mcp-abap-adt/llm-agent@18.1.1
  - @mcp-abap-adt/openai-llm@18.1.1

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
