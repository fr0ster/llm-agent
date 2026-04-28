/**
 * @mcp-abap-adt/llm-agent-libs — core SmartAgent composition surface.
 *
 * Re-exports the runtime composition classes that are needed to build a
 * SmartAgent without depending on @mcp-abap-adt/llm-agent-server.
 */

// ---------------------------------------------------------------------------
// Builder + agent
// ---------------------------------------------------------------------------
export {
  SmartAgentBuilder,
  type SmartAgentBuilderConfig,
  type BuilderMcpConfig,
  type BuilderPromptsConfig,
  type SmartAgentHandle,
} from './builder.js';
export {
  SmartAgent,
  type SmartAgentConfig,
  type SmartAgentDeps,
  type SmartAgentReconfigureOptions,
  type SmartAgentRagStores,
  OrchestratorError,
  type SmartAgentResponse,
  type StopReason,
} from './agent.js';

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

// ---------------------------------------------------------------------------
// Providers (LLM)
// ---------------------------------------------------------------------------
export {
  DefaultModelResolver,
  makeDefaultLlm,
  makeLlm,
  type MakeLlmConfig,
} from './providers.js';

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
  InMemoryMetrics,
  type CounterSnapshot,
  type HistogramSnapshot,
  type MetricsSnapshot,
} from './metrics/in-memory-metrics.js';
export { NoopMetrics } from './metrics/noop-metrics.js';

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
export {
  buildDefaultHandlerRegistry,
  DefaultPipeline,
  evaluateCondition,
  PipelineExecutor,
  type BuiltInStageType,
  type ControlFlowType,
  type IStageHandler,
  type PipelineContext,
  type StageDefinition,
  type StageType,
} from './pipeline/index.js';
export type {
  IPipeline,
  PipelineDeps,
  PipelineResult,
} from './interfaces/pipeline.js';

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
export type {
  IPluginLoader,
  LoadedPlugins,
  PluginExports,
} from './plugins/index.js';

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
