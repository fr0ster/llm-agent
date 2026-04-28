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
export { BaseLLMProvider } from '@mcp-abap-adt/llm-agent';
// Legacy Agent (kept for backward compatibility, but deprecated)
export { Agent } from './agent.js';
// MCP Client
export { MCPClientWrapper, } from './mcp/client.js';
export { LlmAdapter, } from './smart-agent/adapters/llm-adapter.js';
export { LlmProviderBridge } from './smart-agent/adapters/llm-provider-bridge.js';
export { McpClientAdapter } from './smart-agent/adapters/mcp-client-adapter.js';
export { SmartAgentBuilder, } from './smart-agent/builder.js';
// Config
export { ConfigWatcher, } from './smart-agent/config/config-watcher.js';
// Embedder factory registry
export { builtInEmbedderFactories, prefetchEmbedderFactories, } from './smart-agent/embedder-factories.js';
export { HealthChecker, } from './smart-agent/health/health-checker.js';
// History
export { HistoryMemory } from './smart-agent/history/history-memory.js';
export { HistorySummarizer } from './smart-agent/history/history-summarizer.js';
export { DefaultRequestLogger } from './smart-agent/logger/default-request-logger.js';
export { NoopRequestLogger } from './smart-agent/logger/noop-request-logger.js';
export { createDefaultMcpClient } from './smart-agent/mcp-client-factory.js';
export { InMemoryMetrics, } from './smart-agent/metrics/in-memory-metrics.js';
export { NoopMetrics } from './smart-agent/metrics/noop-metrics.js';
export { buildDefaultHandlerRegistry, DefaultPipeline, evaluateCondition, PipelineExecutor, } from './smart-agent/pipeline/index.js';
export { emptyLoadedPlugins, FileSystemPluginLoader, getDefaultPluginDirs, loadPlugins, mergePluginExports, } from './smart-agent/plugins/index.js';
export { DefaultModelResolver, makeDefaultLlm, makeLlm, makeRag, resolveEmbedder, } from './smart-agent/providers.js';
// Reranker
export { LlmReranker } from './smart-agent/reranker/llm-reranker.js';
export { NoopReranker } from './smart-agent/reranker/noop-reranker.js';
export { RateLimiterLlm } from './smart-agent/resilience/rate-limiter-llm.js';
export { RetryLlm, } from './smart-agent/resilience/retry-llm.js';
export { TokenBucketRateLimiter, } from './smart-agent/resilience/token-bucket-rate-limiter.js';
export { NoopSessionManager } from './smart-agent/session/noop-session-manager.js';
export { SessionManager } from './smart-agent/session/session-manager.js';
export { ClaudeSkillManager, CodexSkillManager, FileSystemSkillManager, } from './smart-agent/skills/index.js';
// Connection strategies
export { LazyConnectionStrategy, NoopConnectionStrategy, PeriodicConnectionStrategy, } from './smart-agent/strategies/index.js';
// Tracer
export { NoopTracer } from './smart-agent/tracer/noop-tracer.js';
// Lazy initialization
export { LazyInitError, lazy, } from './smart-agent/utils/lazy.js';
export { NoopValidator } from './smart-agent/validator/noop-validator.js';
//# sourceMappingURL=index.js.map