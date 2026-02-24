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
- [x] Implement `streamChat()` in `LlmAdapter` (delegates to `agent.streamLLMWithTools()`)
- [x] Implement `streamChat()` in `TokenCountingLlm` (wraps inner, accumulates usage from usage chunk)

### Orchestration
- [x] Add `SmartAgent.processStream()` — yields chunks from each LLM call + tool-call events
- [x] Update `SmartServer._handleChat()` to pipe `processStream()` into live SSE connection

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

- [x] Define `IEmbedder` interface: `embed(text: string) → Promise<number[]>`
- [x] Implement `OpenAIEmbedder` (text-embedding-3-small / text-embedding-ada-002)
- [x] Implement `OllamaEmbedder` (extract from `OllamaRag`, reuse in new architecture)
- [x] Refactor `OllamaRag` → `VectorRag(embedder: IEmbedder)` — embedder-agnostic store
- [x] Update `RagStoreConfig` to add `provider` + `apiKey` fields (keep `type` for `in-memory`)
- [x] Update `makeRagFromStoreConfig()` in `pipeline.ts` to wire embedder from config
- [x] Update `SmartServerRagConfig` flat config: `provider` replaces implicit `type: ollama`
- [x] Update YAML template in `config.ts` to show provider examples
- [x] Add `ollamaTimeoutMs` config option and retry with backoff on embed API failures
- [x] Health-check on startup: warn if embedder endpoint is unreachable

## Phase 14 — LLM Reasoning Debug Mode

When debug mode is enabled, the agent injects an instruction into the system prompt
requiring the LLM to explain its reasoning before every action or tool call.
Reasoning appears in the stream as a typed chunk so it can be displayed separately
in the UI or suppressed in production.

```yaml
debug:
  llmReasoning: true   # inject reasoning instruction into system prompt
```

- [ ] Add `debug.llmReasoning` flag to `SmartServerConfig` and YAML schema
- [ ] In `ContextAssembler` (or `SmartAgent`): when flag is set, append reasoning instruction to system message
- [ ] Add `{ type: 'reasoning', text: string }` chunk variant to `LlmStreamChunk` / `AgentStreamChunk`
- [ ] Parse `<reasoning>` or `<thinking>` blocks from streamed text and re-emit as reasoning chunks
- [ ] `SmartServer`: include reasoning chunks in SSE stream (or filter them based on a separate `includeReasoning` flag)

## Phase 15 — Beta Testing

Run after Phase 12–14. Scenarios in `docs/BETA_TESTING_PLAN.md`.

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
