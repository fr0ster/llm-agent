# Roadmap

## Phase 12 — Real Incremental Streaming

- [x] Research: OpenAI SSE wire format (tool_calls deltas, finish_reason, stream_options)
- [x] Research: how Cline processes streaming chunks on the client side
- [x] Research: reference implementations (LiteLLM, Ollama, vLLM)

### Types & interfaces
- [x] Add `LlmStreamChunk` union type to `interfaces/types.ts`
- [x] Add optional `streamChat()` to `ILlm` interface

### Provider layer
- [x] Add optional abstract `streamLLMWithTools()` to `BaseAgent`
- [x] Implement `streamLLMWithTools()` in `OpenAIAgent` (fetch + SSE parser + tool call accumulation)
- [x] Implement `streamLLMWithTools()` in `DeepSeekAgent` (same as OpenAI — compatible API)
- [x] Implement `streamLLMWithTools()` in `AnthropicAgent` (Anthropic streaming format)

### Adapter layer
- [ ] Implement `streamChat()` in `LlmAdapter` (delegates to `agent.streamLLMWithTools()`)
- [ ] Implement `streamChat()` in `TokenCountingLlm` (wraps inner, accumulates usage from usage chunk)

### Orchestration
- [ ] Add `SmartAgent.processStream()` — yields chunks from each LLM call + tool-call events
- [ ] Update `SmartServer._handleChat()` to pipe `processStream()` into live SSE connection

## Phase 13 — Pluggable Embedding Providers

Replace the current Ollama-only RAG backend with a multi-provider embedding layer.
YAML config gains `provider` and `apiKey` fields so any supported embedder can be selected.

```yaml
rag:
  provider: openai          # openai | ollama | in-memory
  apiKey: ${OPENAI_API_KEY}
  model: text-embedding-3-small

# or per-store via pipeline:
pipeline:
  rag:
    facts:
      provider: openai
      apiKey: ${OPENAI_API_KEY}
      model: text-embedding-3-small
    feedback:
      provider: in-memory
```

- [ ] Define `IEmbedder` interface: `embed(text: string) → Promise<number[]>`
- [ ] Implement `OpenAIEmbedder` (text-embedding-3-small / text-embedding-ada-002)
- [ ] Implement `OllamaEmbedder` (extract from `OllamaRag`, reuse in new architecture)
- [ ] Refactor `OllamaRag` → `VectorRag(embedder: IEmbedder)` — embedder-agnostic store
- [ ] Update `RagStoreConfig` to add `provider` + `apiKey` fields (keep `type` for `in-memory`)
- [ ] Update `makeRagFromStoreConfig()` in `pipeline.ts` to wire embedder from config
- [ ] Update `SmartServerRagConfig` flat config: `provider` replaces implicit `type: ollama`
- [ ] Update YAML template in `config.ts` to show provider examples
- [ ] Add `ollamaTimeoutMs` config option and retry with backoff on embed API failures
- [ ] Health-check on startup: warn if embedder endpoint is unreachable

## Phase 14 — Beta Testing

Run after Phase 12. Scenarios in `docs/BETA_TESTING_PLAN.md`.

- [ ] T1 — First-run config generation
- [ ] T2 — Minimal startup (in-memory RAG, no MCP)
- [ ] T3 — Hybrid mode routing (Cline passthrough vs SmartAgent)
- [ ] T4 — Multi-MCP array
- [ ] T5 — Different LLM providers for main and classifier
- [ ] T6 — Pipeline-only config (no flat `llm:` block)
- [ ] T7 — Per-store RAG configuration
- [ ] T8 — Token usage endpoint
- [ ] T9 — CLI flag overrides
- [ ] T10 — Streaming response
- [ ] T11 — IDE integration (Cline / Cursor / Continue)
