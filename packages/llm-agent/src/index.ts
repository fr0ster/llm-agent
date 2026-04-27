// Re-export everything from core subtrees.
export * from './errors/index.js';
export * from './interfaces/index.js';
export { BaseLLMProvider, type LLMProvider } from './llm/base-llm-provider.js';
export * from './rag/index.js';
export * from './types.js';

// --- Library helpers (moved from @mcp-abap-adt/llm-agent-server) ---

// Logger
export type { ILogger, LogEvent } from './logger/types.js';

// Cache
export type { IToolCache } from './cache/types.js';
export { ToolCache } from './cache/tool-cache.js';
export { NoopToolCache } from './cache/noop-tool-cache.js';

// Resilience
export {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitState,
} from './resilience/circuit-breaker.js';
export { CircuitBreakerLlm } from './resilience/circuit-breaker-llm.js';
export { CircuitBreakerEmbedder } from './resilience/circuit-breaker-embedder.js';
export { FallbackRag } from './resilience/fallback-rag.js';

// LLM call policies
export { NonStreamingLlmCallStrategy } from './policy/non-streaming-llm-call-strategy.js';
export { StreamingLlmCallStrategy } from './policy/streaming-llm-call-strategy.js';
export { FallbackLlmCallStrategy } from './policy/fallback-llm-call-strategy.js';

// API adapter interfaces
export {
  AdapterValidationError,
  type ApiRequestContext,
  type ApiSseEvent,
  type ILlmApiAdapter,
  type NormalizedRequest,
} from './interfaces/api-adapter.js';

// API adapters
export { AnthropicApiAdapter } from './api-adapters/anthropic-adapter.js';
export { OpenAiApiAdapter } from './api-adapters/openai-adapter.js';

// Client adapters
export type { IClientAdapter } from './interfaces/client-adapter.js';
export { ClineClientAdapter } from './adapters/cline-client-adapter.js';

// Tool utilities
export {
  CLIENT_PROVIDED_PREFIX,
  type ExternalToolValidationCode,
  type ExternalToolValidationError,
  normalizeAndValidateExternalTools,
  normalizeExternalTools,
} from './external-tools-normalizer.js';
export {
  getStreamToolCallName,
  toToolCallDelta,
} from './tool-call-deltas.js';
