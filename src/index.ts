/**
 * Main exports for LLM Proxy
 */

// Legacy Agent (kept for backward compatibility, but deprecated)
export { Agent, type AgentConfig } from './agent.js';
export {
  AnthropicAgent,
  type AnthropicAgentConfig,
} from './agents/anthropic-agent.js';
// New Agent implementations (recommended)
export { BaseAgent, type BaseAgentConfig } from './agents/base.js';
export {
  DeepSeekAgent,
  type DeepSeekAgentConfig,
} from './agents/deepseek-agent.js';
// Legacy exports (deprecated - use SapCoreAIProvider instead)
// These are kept for backward compatibility but will be removed in future versions
export { OpenAIAgent, type OpenAIAgentConfig } from './agents/openai-agent.js';
export {
  PromptBasedAgent,
  type PromptBasedAgentConfig,
} from './agents/prompt-based-agent.js';
export {
  SapCoreAIAgent,
  type SapCoreAIAgentConfig,
} from './agents/sap-core-ai-agent.js';
export {
  type AnthropicConfig,
  AnthropicProvider,
} from './llm-providers/anthropic.js';
export { BaseLLMProvider, type LLMProvider } from './llm-providers/base.js';
export {
  type DeepSeekConfig,
  DeepSeekProvider,
} from './llm-providers/deepseek.js';
export { type OpenAIConfig, OpenAIProvider } from './llm-providers/openai.js';
// LLM Providers
// NOTE: All LLM providers are accessed through SAP AI Core
export {
  type SapAICoreCredentials,
  type SapCoreAIConfig,
  SapCoreAIProvider,
} from './llm-providers/sap-core-ai.js';

// MCP Client
export {
  type MCPClientConfig,
  MCPClientWrapper,
  type TransportType,
} from './mcp/client.js';
// Adapters
export { ClineClientAdapter } from './smart-agent/adapters/cline-client-adapter.js';
export {
  LlmAdapter,
  type LlmAdapterProviderInfo,
} from './smart-agent/adapters/llm-adapter.js';
export { McpClientAdapter } from './smart-agent/adapters/mcp-client-adapter.js';
// Builder & Providers
export type {
  SmartAgentRagStores,
  SmartAgentReconfigureOptions,
} from './smart-agent/agent.js';
// API adapters
export {
  AnthropicApiAdapter,
  OpenAiApiAdapter,
} from './smart-agent/api-adapters/index.js';
export {
  type BuilderMcpConfig,
  type BuilderPromptsConfig,
  SmartAgentBuilder,
  type SmartAgentBuilderConfig,
  type SmartAgentHandle,
} from './smart-agent/builder.js';
export { NoopToolCache } from './smart-agent/cache/noop-tool-cache.js';
export { ToolCache } from './smart-agent/cache/tool-cache.js';
// Tool Cache
export type { IToolCache } from './smart-agent/cache/types.js';
// Config
export {
  ConfigWatcher,
  type ConfigWatcherOptions,
  type HotReloadableConfig,
} from './smart-agent/config/config-watcher.js';
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
// Smart Agent interfaces
export type { AgentCallOptions } from './smart-agent/interfaces/agent-contracts.js';
export {
  AdapterValidationError,
  type ApiRequestContext,
  type ApiSseEvent,
  type ILlmApiAdapter,
  type NormalizedRequest,
} from './smart-agent/interfaces/api-adapter.js';
export type { IClientAdapter } from './smart-agent/interfaces/client-adapter.js';
export type { IHistoryMemory } from './smart-agent/interfaces/history-memory.js';
export type {
  HistoryTurn,
  IHistorySummarizer,
} from './smart-agent/interfaces/history-summarizer.js';
export type { ILlm } from './smart-agent/interfaces/llm.js';
export type { ILlmCallStrategy } from './smart-agent/interfaces/llm-call-strategy.js';
export type { IMcpClient } from './smart-agent/interfaces/mcp-client.js';
export type {
  ConnectionStrategyOptions,
  IMcpConnectionStrategy,
  McpClientFactory,
  McpClientFactoryResult,
  McpConnectionConfig,
  McpConnectionResult,
} from './smart-agent/interfaces/mcp-connection-strategy.js';
export type {
  IModelFilter,
  IModelInfo,
  IModelProvider,
} from './smart-agent/interfaces/model-provider.js';
export type { IModelResolver } from './smart-agent/interfaces/model-resolver.js';
export type {
  IPipeline,
  PipelineDeps,
  PipelineResult,
} from './smart-agent/interfaces/pipeline.js';
export type {
  IRagStoreConfig,
  ISmartAgentPlugin,
  RagScope,
} from './smart-agent/interfaces/plugin.js';
// Query Embedding
export type { IQueryEmbedding } from './smart-agent/interfaces/query-embedding.js';
// Embedder & RAG
export type {
  EmbedderFactory,
  EmbedderFactoryConfig,
  IEmbedder,
  IEmbedderBatch,
  IEmbedResult,
  IPrecomputedVectorRag,
  IRag,
} from './smart-agent/interfaces/rag.js';
export {
  isBatchEmbedder,
  supportsPrecomputed,
} from './smart-agent/interfaces/rag.js';
export type { ILlmRateLimiter } from './smart-agent/interfaces/rate-limiter.js';
// Request Logger
export type {
  IRequestLogger,
  LlmCallEntry,
  LlmComponent,
  RagQueryEntry,
  RequestSummary,
  TokenBucket,
  TokenCategory,
  ToolCallEntry,
} from './smart-agent/interfaces/request-logger.js';
// Skills
export type {
  ISkill,
  ISkillManager,
  ISkillMeta,
  ISkillResource,
} from './smart-agent/interfaces/skill.js';
// Smart Agent shared types (needed by plugin authors)
export type {
  CallOptions,
  LlmTool,
  RagError,
  RagResult,
  Result,
  StreamHookContext,
} from './smart-agent/interfaces/types.js';
export { SkillError } from './smart-agent/interfaces/types.js';
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
export { FallbackLlmCallStrategy } from './smart-agent/policy/fallback-llm-call-strategy.js';
export { NonStreamingLlmCallStrategy } from './smart-agent/policy/non-streaming-llm-call-strategy.js';
export { StreamingLlmCallStrategy } from './smart-agent/policy/streaming-llm-call-strategy.js';
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
export { builtInEmbedderFactories } from './smart-agent/rag/embedder-factories.js';
export { InMemoryRag } from './smart-agent/rag/in-memory-rag.js';
export {
  OllamaEmbedder,
  type OllamaEmbedderConfig,
  OllamaRag,
} from './smart-agent/rag/ollama-rag.js';
export {
  OpenAiEmbedder,
  type OpenAiEmbedderConfig,
} from './smart-agent/rag/openai-embedder.js';
// Qdrant RAG
export {
  QdrantRag,
  type QdrantRagConfig,
} from './smart-agent/rag/qdrant-rag.js';
export {
  FallbackQueryEmbedding,
  QueryEmbedding,
  TextOnlyEmbedding,
} from './smart-agent/rag/query-embedding.js';
// Query Expander
export {
  type IQueryExpander,
  LlmQueryExpander,
  NoopQueryExpander,
} from './smart-agent/rag/query-expander.js';
export {
  SapAiCoreEmbedder,
  type SapAiCoreEmbedderConfig,
} from './smart-agent/rag/sap-ai-core-embedder.js';
// Search Strategies
export type {
  IScoredResult,
  ISearchCandidate,
  ISearchContext,
  ISearchQuery,
  ISearchStrategy,
} from './smart-agent/rag/search-strategy.js';
export {
  Bm25OnlyStrategy,
  RrfStrategy,
  VectorOnlyStrategy,
  WeightedFusionStrategy,
} from './smart-agent/rag/search-strategy.js';
export {
  VectorRag,
  type VectorRagConfig,
} from './smart-agent/rag/vector-rag.js';
// Reranker
export { LlmReranker } from './smart-agent/reranker/llm-reranker.js';
export { NoopReranker } from './smart-agent/reranker/noop-reranker.js';
export type { IReranker } from './smart-agent/reranker/types.js';
// Resilience
export {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitState,
} from './smart-agent/resilience/circuit-breaker.js';
export { CircuitBreakerEmbedder } from './smart-agent/resilience/circuit-breaker-embedder.js';
export { CircuitBreakerLlm } from './smart-agent/resilience/circuit-breaker-llm.js';
export { FallbackRag } from './smart-agent/resilience/fallback-rag.js';
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
// Utils
export {
  type ExternalToolValidationCode,
  type ExternalToolValidationError,
  normalizeAndValidateExternalTools,
  normalizeExternalTools,
} from './smart-agent/utils/external-tools-normalizer.js';
// Lazy initialization
export {
  LazyInitError,
  type LazyOptions,
  lazy,
} from './smart-agent/utils/lazy.js';
export {
  getStreamToolCallName,
  toToolCallDelta,
} from './smart-agent/utils/tool-call-deltas.js';
export { NoopValidator } from './smart-agent/validator/noop-validator.js';
// Output Validator
export type {
  IOutputValidator,
  ValidationResult,
} from './smart-agent/validator/types.js';

export type {
  AgentResponse,
  LLMProviderConfig,
  LLMResponse,
  Message,
  ToolCall,
  ToolResult,
} from './types.js';
