/**
 * Server package entry.
 * Re-exports SmartAgent, Builder, pipeline, MCP client, adapters,
 * resilience wrappers, skills, agents, and server-specific types.
 * Core interfaces (BaseLLMProvider, LLMProvider, MissingProviderError) and
 * provider/embedder/RAG implementations are available via their canonical packages:
 * @mcp-abap-adt/llm-agent, @mcp-abap-adt/openai-llm, @mcp-abap-adt/anthropic-llm,
 * @mcp-abap-adt/deepseek-llm, @mcp-abap-adt/sap-aicore-llm, @mcp-abap-adt/openai-embedder,
 * @mcp-abap-adt/ollama-embedder, @mcp-abap-adt/sap-aicore-embedder, @mcp-abap-adt/qdrant-rag.
 */

// Adapters
// API adapters
// Resilience
// Utils
export {
  AdapterValidationError,
  AnthropicApiAdapter,
  type ApiRequestContext,
  type ApiSseEvent,
  BaseLLMProvider,
  CircuitBreaker,
  type CircuitBreakerConfig,
  CircuitBreakerEmbedder,
  CircuitBreakerLlm,
  type CircuitState,
  ClineClientAdapter,
  type ExternalToolValidationCode,
  type ExternalToolValidationError,
  FallbackLlmCallStrategy,
  FallbackRag,
  getStreamToolCallName,
  type IClientAdapter,
  type ILlmApiAdapter,
  type IToolCache,
  type LLMProvider,
  NonStreamingLlmCallStrategy,
  NoopToolCache,
  type NormalizedRequest,
  normalizeAndValidateExternalTools,
  normalizeExternalTools,
  OpenAiApiAdapter,
  StreamingLlmCallStrategy,
  ToolCache,
  toToolCallDelta,
} from '@mcp-abap-adt/llm-agent';
// Legacy Agent (kept for backward compatibility, but deprecated)
export { Agent, type AgentConfig } from './agent.js';
// MCP Client
export {
  type MCPClientConfig,
  MCPClientWrapper,
  type TransportType,
} from './mcp/client.js';
export {
  type AgentCallOptions,
  type BaseAgentLlmBridge,
  LlmAdapter,
  type LlmAdapterProviderInfo,
} from './smart-agent/adapters/llm-adapter.js';
export { LlmProviderBridge } from './smart-agent/adapters/llm-provider-bridge.js';
export { McpClientAdapter } from './smart-agent/adapters/mcp-client-adapter.js';
// Builder & Providers
export type {
  SmartAgentRagStores,
  SmartAgentReconfigureOptions,
} from './smart-agent/agent.js';
export {
  type BuilderMcpConfig,
  type BuilderPromptsConfig,
  SmartAgentBuilder,
  type SmartAgentBuilderConfig,
  type SmartAgentHandle,
} from './smart-agent/builder.js';
// Config
export {
  ConfigWatcher,
  type ConfigWatcherOptions,
  type HotReloadableConfig,
} from './smart-agent/config/config-watcher.js';
// Embedder factory registry
export {
  builtInEmbedderFactories,
  type EmbedderFactoryOpts,
  prefetchEmbedderFactories,
} from './smart-agent/embedder-factories.js';
export {
  HealthChecker,
  type HealthCheckerDeps,
} from './smart-agent/health/health-checker.js';
// Health
export type {
  CircuitBreakerStatus,
  HealthComponentStatus,
  HealthStatus,
} from './smart-agent/health/types.js';
// History
export { HistoryMemory } from './smart-agent/history/history-memory.js';
export { HistorySummarizer } from './smart-agent/history/history-summarizer.js';
export type {
  ConnectionStrategyOptions,
  IMcpConnectionStrategy,
  McpClientFactory,
  McpClientFactoryResult,
  McpConnectionConfig,
  McpConnectionResult,
} from './smart-agent/interfaces/mcp-connection-strategy.js';
export type { IModelResolver } from './smart-agent/interfaces/model-resolver.js';
export type {
  IPipeline,
  PipelineDeps,
  PipelineResult,
} from './smart-agent/interfaces/pipeline.js';
export { DefaultRequestLogger } from './smart-agent/logger/default-request-logger.js';
export { NoopRequestLogger } from './smart-agent/logger/noop-request-logger.js';
export { createDefaultMcpClient } from './smart-agent/mcp-client-factory.js';
export {
  type CounterSnapshot,
  type HistogramSnapshot,
  InMemoryMetrics,
  type MetricsSnapshot,
} from './smart-agent/metrics/in-memory-metrics.js';
export { NoopMetrics } from './smart-agent/metrics/noop-metrics.js';
// Metrics
export type {
  ICounter,
  IHistogram,
  IMetrics,
} from './smart-agent/metrics/types.js';
// Structured Pipeline
export type {
  BuiltInStageType,
  ControlFlowType,
  IStageHandler,
  PipelineContext,
  StageDefinition,
  StageType,
} from './smart-agent/pipeline/index.js';
export {
  buildDefaultHandlerRegistry,
  DefaultPipeline,
  evaluateCondition,
  PipelineExecutor,
} from './smart-agent/pipeline/index.js';
// Plugins
export type {
  IPluginLoader,
  LoadedPlugins,
  PluginExports,
} from './smart-agent/plugins/index.js';
export {
  emptyLoadedPlugins,
  FileSystemPluginLoader,
  type FileSystemPluginLoaderConfig,
  getDefaultPluginDirs,
  loadPlugins,
  mergePluginExports,
} from './smart-agent/plugins/index.js';
export {
  DefaultModelResolver,
  type EmbedderResolutionConfig,
  type EmbedderResolutionOptions,
  type LlmProviderConfig,
  makeDefaultLlm,
  makeLlm,
  makeRag,
  type RagResolutionConfig,
  type RagResolutionOptions,
  resolveEmbedder,
} from './smart-agent/providers.js';
// Reranker
export { LlmReranker } from './smart-agent/reranker/llm-reranker.js';
export { NoopReranker } from './smart-agent/reranker/noop-reranker.js';
export type { IReranker } from './smart-agent/reranker/types.js';
export { RateLimiterLlm } from './smart-agent/resilience/rate-limiter-llm.js';
export {
  RetryLlm,
  type RetryOptions,
} from './smart-agent/resilience/retry-llm.js';
export {
  type TokenBucketConfig,
  TokenBucketRateLimiter,
} from './smart-agent/resilience/token-bucket-rate-limiter.js';
export { NoopSessionManager } from './smart-agent/session/noop-session-manager.js';
export { SessionManager } from './smart-agent/session/session-manager.js';
// Session Manager
export type { ISessionManager } from './smart-agent/session/types.js';
export {
  ClaudeSkillManager,
  CodexSkillManager,
  FileSystemSkillManager,
} from './smart-agent/skills/index.js';
// Connection strategies
export {
  LazyConnectionStrategy,
  NoopConnectionStrategy,
  PeriodicConnectionStrategy,
} from './smart-agent/strategies/index.js';
// Tracer
export { NoopTracer } from './smart-agent/tracer/noop-tracer.js';
export type {
  ISpan,
  ITracer,
  SpanOptions,
  SpanStatus,
} from './smart-agent/tracer/types.js';
// Lazy initialization
export {
  LazyInitError,
  type LazyOptions,
  lazy,
} from './smart-agent/utils/lazy.js';
export { NoopValidator } from './smart-agent/validator/noop-validator.js';
// Output Validator
export type {
  IOutputValidator,
  ValidationResult,
} from './smart-agent/validator/types.js';
