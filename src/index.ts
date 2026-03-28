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
export type { SmartAgentRagStores } from './smart-agent/agent.js';
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
// Smart Agent interfaces
export type { IClientAdapter } from './smart-agent/interfaces/client-adapter.js';
export type { ILlm } from './smart-agent/interfaces/llm.js';
export type { IMcpClient } from './smart-agent/interfaces/mcp-client.js';
export type {
  IModelInfo,
  IModelProvider,
} from './smart-agent/interfaces/model-provider.js';
// Embedder & RAG
export type {
  EmbedderFactory,
  EmbedderFactoryConfig,
  IEmbedder,
  IRag,
} from './smart-agent/interfaces/rag.js';
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
} from './smart-agent/interfaces/types.js';
export { SkillError } from './smart-agent/interfaces/types.js';
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
  StructuredPipelineDefinition,
} from './smart-agent/pipeline/index.js';
export {
  buildDefaultHandlerRegistry,
  evaluateCondition,
  getDefaultPipelineDefinition,
  getDefaultStages,
  PipelineExecutor,
  PresentHandler,
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
// Query Expander
export {
  type IQueryExpander,
  LlmQueryExpander,
  NoopQueryExpander,
} from './smart-agent/rag/query-expander.js';
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
export {
  RetryLlm,
  type RetryOptions,
} from './smart-agent/resilience/retry-llm.js';
export { NoopSessionManager } from './smart-agent/session/noop-session-manager.js';
export { SessionManager } from './smart-agent/session/session-manager.js';
// Session Manager
export type { ISessionManager } from './smart-agent/session/types.js';
export {
  ClaudeSkillManager,
  CodexSkillManager,
  FileSystemSkillManager,
} from './smart-agent/skills/index.js';
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
