# Audit notes — Task 1 output (scratch, delete in Task 15)

Internal consumers in `packages/llm-agent-server/src/` that import moved symbols via relative paths. After the moves complete, every line below must either be (a) rewritten to import from `@mcp-abap-adt/llm-agent` (Task 12), or (b) become unreachable because the importing file is itself a moved file.

## Files to rewrite in Task 12 (16 files)

| File | Imports to rewrite |
|---|---|
| `smart-agent/agent.ts` | `./cache/noop-tool-cache.js` (NoopToolCache), `./cache/types.js` (IToolCache), `./interfaces/client-adapter.js` (IClientAdapter), `./policy/streaming-llm-call-strategy.js` (StreamingLlmCallStrategy), `./utils/external-tools-normalizer.js` (normalizeExternalTools), `./utils/tool-call-deltas.js` (getStreamToolCallName, toToolCallDelta) |
| `smart-agent/builder.ts` | `./cache/types.js` (IToolCache), `./interfaces/api-adapter.js` (ILlmApiAdapter), `./interfaces/client-adapter.js` (IClientAdapter), `./resilience/circuit-breaker.js` (CircuitBreaker, CircuitBreakerConfig, CircuitState), `./resilience/circuit-breaker-llm.js` (CircuitBreakerLlm), `./resilience/fallback-rag.js` (FallbackRag) |
| `smart-agent/server.ts` | `./utils/tool-call-deltas.js` (toToolCallDelta) |
| `smart-agent/smart-server.ts` | `./interfaces/api-adapter.js` (NormalizedRequest, ApiRequestContext, ApiSseEvent, ILlmApiAdapter, AdapterValidationError), `./interfaces/client-adapter.js` (IClientAdapter), `./utils/external-tools-normalizer.js` (normalizeAndValidateExternalTools etc), `./utils/tool-call-deltas.js` (toToolCallDelta) |
| `smart-agent/cache/index.ts` | barrel re-exporting moved files — replace with re-export from `@mcp-abap-adt/llm-agent`, then delete in Task 13 |
| `smart-agent/resilience/index.ts` | barrel — same treatment |
| `smart-agent/policy/mixed-tool-call-handler.ts` | `../cache/types.js` (IToolCache) |
| `smart-agent/pipeline/context.ts` | `../cache/types.js` (IToolCache) |
| `smart-agent/pipeline/default-pipeline.ts` | `../cache/noop-tool-cache.js` (NoopToolCache), `../policy/streaming-llm-call-strategy.js` (StreamingLlmCallStrategy) |
| `smart-agent/pipeline/handlers/tool-loop.ts` | `../../utils/tool-call-deltas.js` |
| `smart-agent/interfaces/pipeline.ts` | `../cache/types.js` (IToolCache) |
| `smart-agent/plugins/types.ts` | `../interfaces/api-adapter.js` (ILlmApiAdapter), `../interfaces/client-adapter.js` (IClientAdapter) |
| `smart-agent/testing/index.ts` | `../cache/noop-tool-cache.js`, `../cache/tool-cache.js`, `../cache/types.js`, `../resilience/circuit-breaker.js` |
| `smart-agent/health/types.ts` | `../resilience/circuit-breaker.js` (CircuitState) |
| `smart-agent/health/health-checker.ts` | `../resilience/circuit-breaker.js` (CircuitBreaker) |
| `smart-agent/adapters/cline-client-adapter.ts` | `../interfaces/client-adapter.js` (IClientAdapter) — but this file ITSELF is moved in Task 10, so it leaves the server entirely |

## Self-references inside moved files (resolve identically in new location)

These DON'T need rewriting — `from './circuit-breaker.js'` etc. work the same in `llm-agent/src/resilience/`:
- `resilience/circuit-breaker-llm.ts` → `./circuit-breaker.js`
- `resilience/circuit-breaker-embedder.ts` → `./circuit-breaker.js`
- `resilience/fallback-rag.ts` → `./circuit-breaker.js`
- `policy/fallback-llm-call-strategy.ts` → `./non-streaming-llm-call-strategy.js`, `./streaming-llm-call-strategy.js`, `../logger/types.js`
- `adapters/cline-client-adapter.ts` → `../interfaces/client-adapter.js`

## Self-references that DO need rewriting in moved files

- `api-adapters/anthropic-adapter.ts`: `'../utils/tool-call-deltas.js'` → `'../tool-call-deltas.js'` (utils dir doesn't exist in llm-agent)
- `api-adapters/openai-adapter.ts`: same `'../utils/tool-call-deltas.js'` → `'../tool-call-deltas.js'`; check for `'../utils/external-tools-normalizer.js'` too
