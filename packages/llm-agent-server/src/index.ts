/**
 * Server package entry — runnable distribution of SmartAgent.
 *
 * This package ships the binary (CLI + HTTP server) plus its build-time
 * dependencies: SmartAgentBuilder, providers/factories, plugins, skills,
 * sessions, metrics, tracer, validator, reranker, history, pipeline,
 * health, config watcher, MCP client wrapper, and server-specific types.
 *
 * Library helpers (CircuitBreaker family, FallbackRag, LLM call strategies,
 * ToolCache, ClineClientAdapter, AnthropicApiAdapter / OpenAiApiAdapter and
 * their interface types, external-tools-normalizer, tool-call-deltas, ILogger)
 * live in @mcp-abap-adt/llm-agent — import them from there directly when
 * embedding SmartAgent in your own server.
 *
 * Provider implementations live in their canonical packages:
 * @mcp-abap-adt/openai-llm, @mcp-abap-adt/anthropic-llm, @mcp-abap-adt/deepseek-llm,
 * @mcp-abap-adt/sap-aicore-llm, @mcp-abap-adt/openai-embedder,
 * @mcp-abap-adt/ollama-embedder, @mcp-abap-adt/sap-aicore-embedder,
 * @mcp-abap-adt/qdrant-rag, @mcp-abap-adt/hana-vector-rag, @mcp-abap-adt/pg-vector-rag.
 */

export { BaseLLMProvider, type LLMProvider } from '@mcp-abap-adt/llm-agent';
// Legacy Agent (kept for backward compatibility, but deprecated)
export { Agent, type AgentConfig } from './agent.js';
// MCP Client
export {
  type MCPClientConfig,
  MCPClientWrapper,
  type TransportType,
} from '@mcp-abap-adt/llm-agent-mcp';
export {
  type AgentCallOptions,
  type BaseAgentLlmBridge,
  LlmAdapter,
  type LlmAdapterProviderInfo,
} from './smart-agent/adapters/llm-adapter.js';
export { LlmProviderBridge } from './smart-agent/adapters/llm-provider-bridge.js';
export { McpClientAdapter } from '@mcp-abap-adt/llm-agent-mcp';
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
// Embedder factory registry — re-exported from @mcp-abap-adt/llm-agent-rag
export {
  builtInEmbedderFactories,
  type EmbedderFactoryOpts,
  prefetchEmbedderFactories,
} from '@mcp-abap-adt/llm-agent-rag';
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
export { createDefaultMcpClient } from '@mcp-abap-adt/llm-agent-mcp';
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
  type LlmProviderConfig,
  makeDefaultLlm,
  makeLlm,
} from './smart-agent/providers.js';
// RAG/embedder resolution — re-exported from @mcp-abap-adt/llm-agent-rag
export {
  type EmbedderResolutionConfig,
  type EmbedderResolutionOptions,
  makeRag,
  type RagResolutionConfig,
  type RagResolutionOptions,
  resolveEmbedder,
} from '@mcp-abap-adt/llm-agent-rag';
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
} from '@mcp-abap-adt/llm-agent-mcp';
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
