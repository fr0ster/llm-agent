/**
 * Server package entry — runnable distribution of SmartAgent.
 *
 * This package ships the binary (CLI + HTTP server). The composition library
 * surface has moved to @mcp-abap-adt/llm-agent-libs.
 *
 * Imports below are kept for backward compatibility but consumers should
 * migrate to importing directly from the canonical packages:
 *   - @mcp-abap-adt/llm-agent       (interfaces, types, helpers)
 *   - @mcp-abap-adt/llm-agent-mcp   (MCP client)
 *   - @mcp-abap-adt/llm-agent-rag   (RAG/embedder factories)
 *   - @mcp-abap-adt/llm-agent-libs  (SmartAgentBuilder, composition)
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
} from '@mcp-abap-adt/llm-agent-libs';
export { LlmProviderBridge } from '@mcp-abap-adt/llm-agent-libs';
export { McpClientAdapter } from '@mcp-abap-adt/llm-agent-mcp';
// Builder & Providers
export type {
  SmartAgentRagStores,
  SmartAgentReconfigureOptions,
} from '@mcp-abap-adt/llm-agent-libs';
export {
  type BuilderMcpConfig,
  type BuilderPromptsConfig,
  SmartAgentBuilder,
  type SmartAgentBuilderConfig,
  type SmartAgentHandle,
} from '@mcp-abap-adt/llm-agent-libs';
// Config
export {
  ConfigWatcher,
  type ConfigWatcherOptions,
  type HotReloadableConfig,
} from '@mcp-abap-adt/llm-agent-libs';
// Embedder factory registry — re-exported from @mcp-abap-adt/llm-agent-rag
export {
  builtInEmbedderFactories,
  type EmbedderFactoryOpts,
  prefetchEmbedderFactories,
} from '@mcp-abap-adt/llm-agent-rag';
export {
  HealthChecker,
  type HealthCheckerDeps,
} from '@mcp-abap-adt/llm-agent-libs';
// Health
export type {
  CircuitBreakerStatus,
  HealthComponentStatus,
  HealthStatus,
} from '@mcp-abap-adt/llm-agent';
// History
export { HistoryMemory } from '@mcp-abap-adt/llm-agent-libs';
export { HistorySummarizer } from '@mcp-abap-adt/llm-agent-libs';
export type {
  ConnectionStrategyOptions,
  IMcpConnectionStrategy,
  McpClientFactory,
  McpClientFactoryResult,
  McpConnectionConfig,
  McpConnectionResult,
} from '@mcp-abap-adt/llm-agent';
export type { IModelResolver } from '@mcp-abap-adt/llm-agent';
export type {
  IPipeline,
  PipelineDeps,
  PipelineResult,
} from '@mcp-abap-adt/llm-agent-libs';
export { DefaultRequestLogger } from '@mcp-abap-adt/llm-agent-libs';
export { NoopRequestLogger } from '@mcp-abap-adt/llm-agent-libs';
export { createDefaultMcpClient } from '@mcp-abap-adt/llm-agent-mcp';
export {
  type CounterSnapshot,
  type HistogramSnapshot,
  InMemoryMetrics,
  type MetricsSnapshot,
} from '@mcp-abap-adt/llm-agent-libs';
export { NoopMetrics } from '@mcp-abap-adt/llm-agent-libs';
// Metrics
export type {
  ICounter,
  IHistogram,
  IMetrics,
} from '@mcp-abap-adt/llm-agent';
// Structured Pipeline
export type {
  BuiltInStageType,
  ControlFlowType,
  IStageHandler,
  PipelineContext,
  StageDefinition,
  StageType,
} from '@mcp-abap-adt/llm-agent-libs';
export {
  buildDefaultHandlerRegistry,
  DefaultPipeline,
  evaluateCondition,
  PipelineExecutor,
} from '@mcp-abap-adt/llm-agent-libs';
// Plugins
export type {
  IPluginLoader,
  LoadedPlugins,
  PluginExports,
} from '@mcp-abap-adt/llm-agent-libs';
export {
  emptyLoadedPlugins,
  FileSystemPluginLoader,
  type FileSystemPluginLoaderConfig,
  getDefaultPluginDirs,
  loadPlugins,
  mergePluginExports,
} from '@mcp-abap-adt/llm-agent-libs';
export {
  DefaultModelResolver,
  type MakeLlmConfig,
  makeDefaultLlm,
  makeLlm,
} from '@mcp-abap-adt/llm-agent-libs';
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
export { LlmReranker } from '@mcp-abap-adt/llm-agent-libs';
export { NoopReranker } from '@mcp-abap-adt/llm-agent-libs';
export type { IReranker } from '@mcp-abap-adt/llm-agent';
export { RateLimiterLlm } from '@mcp-abap-adt/llm-agent-libs';
export {
  RetryLlm,
  type RetryOptions,
} from '@mcp-abap-adt/llm-agent-libs';
export {
  type TokenBucketConfig,
  TokenBucketRateLimiter,
} from '@mcp-abap-adt/llm-agent-libs';
export { NoopSessionManager } from '@mcp-abap-adt/llm-agent-libs';
export { SessionManager } from '@mcp-abap-adt/llm-agent-libs';
// Session Manager
export type { ISessionManager } from '@mcp-abap-adt/llm-agent';
export {
  ClaudeSkillManager,
  CodexSkillManager,
  FileSystemSkillManager,
} from '@mcp-abap-adt/llm-agent-libs';
// Connection strategies
export {
  LazyConnectionStrategy,
  NoopConnectionStrategy,
  PeriodicConnectionStrategy,
} from '@mcp-abap-adt/llm-agent-mcp';
// Tracer
export { NoopTracer } from '@mcp-abap-adt/llm-agent-libs';
export type {
  ISpan,
  ITracer,
  SpanOptions,
  SpanStatus,
} from '@mcp-abap-adt/llm-agent';
// Lazy initialization
export {
  LazyInitError,
  type LazyOptions,
  lazy,
} from '@mcp-abap-adt/llm-agent-libs';
export { NoopValidator } from '@mcp-abap-adt/llm-agent-libs';
// Output Validator
export type {
  IOutputValidator,
  ValidationResult,
} from '@mcp-abap-adt/llm-agent';
