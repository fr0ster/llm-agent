/**
 * @mcp-abap-adt/llm-agent-libs — core SmartAgent composition surface.
 *
 * Re-exports the runtime composition classes that are needed to build a
 * SmartAgent without depending on @mcp-abap-adt/llm-agent-server.
 */

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------
export {
  type AgentCallOptions,
  type BaseAgentLlmBridge,
  LlmAdapter,
  type LlmAdapterProviderInfo,
} from './adapters/llm-adapter.js';
export { LlmProviderBridge } from './adapters/llm-provider-bridge.js';
export { NonStreamingLlm } from './adapters/non-streaming-llm.js';
export {
  OrchestratorError,
  SmartAgent,
  type SmartAgentConfig,
  type SmartAgentDeps,
  type SmartAgentRagStores,
  type SmartAgentReconfigureOptions,
  type SmartAgentResponse,
  type StopReason,
} from './agent.js';
// ---------------------------------------------------------------------------
// Builder + agent
// ---------------------------------------------------------------------------
export {
  type BuilderMcpConfig,
  type BuilderPromptsConfig,
  SmartAgentBuilder,
  type SmartAgentBuilderConfig,
  type SmartAgentHandle,
} from './builder.js';
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export {
  ConfigWatcher,
  type ConfigWatcherOptions,
  type HotReloadableConfig,
} from './config/config-watcher.js';
// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
export {
  HealthChecker,
  type HealthCheckerDeps,
} from './health/health-checker.js';
// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
export { HistoryMemory } from './history/history-memory.js';
export { HistorySummarizer } from './history/history-summarizer.js';
export type {
  IPipeline,
  PipelineDeps,
  PipelineResult,
} from './interfaces/pipeline.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
export { DefaultRequestLogger } from './logger/default-request-logger.js';
export { NoopRequestLogger } from './logger/noop-request-logger.js';
export { SessionLogger } from './logger/session-logger.js';

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export {
  type CounterSnapshot,
  type HistogramSnapshot,
  InMemoryMetrics,
  type MetricsSnapshot,
} from './metrics/in-memory-metrics.js';
export { NoopMetrics } from './metrics/noop-metrics.js';

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
export {
  type BuiltInStageType,
  buildDefaultHandlerRegistry,
  type ControlFlowType,
  DefaultPipeline,
  evaluateCondition,
  type IStageHandler,
  type PipelineContext,
  PipelineExecutor,
  type StageDefinition,
  type StageType,
} from './pipeline/index.js';
export type {
  IPluginLoader,
  LoadedPlugins,
  PluginExports,
} from './plugins/index.js';

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------
export {
  emptyLoadedPlugins,
  FileSystemPluginLoader,
  type FileSystemPluginLoaderConfig,
  getDefaultPluginDirs,
  loadPlugins,
  mergePluginExports,
} from './plugins/index.js';
// ---------------------------------------------------------------------------
// Providers (LLM)
// ---------------------------------------------------------------------------
export {
  DefaultModelResolver,
  type MakeLlmConfig,
  makeDefaultLlm,
  makeLlm,
} from './providers.js';

// ---------------------------------------------------------------------------
// Reranker
// ---------------------------------------------------------------------------
export { LlmReranker } from './reranker/llm-reranker.js';
export { NoopReranker } from './reranker/noop-reranker.js';

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------
export { RateLimiterLlm } from './resilience/rate-limiter-llm.js';
export { RetryLlm, type RetryOptions } from './resilience/retry-llm.js';
export {
  type TokenBucketConfig,
  TokenBucketRateLimiter,
} from './resilience/token-bucket-rate-limiter.js';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
export { NoopSessionManager } from './session/noop-session-manager.js';
export { SessionManager } from './session/session-manager.js';

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export {
  ClaudeSkillManager,
  CodexSkillManager,
  FileSystemSkillManager,
} from './skills/index.js';

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------
export { NoopTracer } from './tracer/noop-tracer.js';

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
export { LazyInitError, type LazyOptions, lazy } from './utils/lazy.js';

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------
export { NoopValidator } from './validator/noop-validator.js';
