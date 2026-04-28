# @mcp-abap-adt/llm-agent-libs

Core SmartAgent composition runtime. Builder, agent runtime, pipeline, sessions, history, resilience, observability, plugins, skills.

## Top-level exports

`SmartAgentBuilder`, `SmartAgentBuilderConfig`, `BuilderMcpConfig`, `BuilderPromptsConfig`, `SmartAgentReconfigureOptions`, `LlmAdapter`, `LlmAdapterProviderInfo`, `LlmProviderBridge`, `DefaultModelResolver`, `makeDefaultLlm`, `makeLlm`, `MakeLlmConfig`, `ConfigWatcher`, `ConfigWatcherOptions`, `HotReloadableConfig`, `HealthChecker`, `HealthCheckerDeps`, `HistoryMemory`, `HistorySummarizer`, `DefaultRequestLogger`, `NoopRequestLogger`, `InMemoryMetrics`, `NoopMetrics`, `DefaultPipeline`, `PipelineExecutor`, `buildDefaultHandlerRegistry`, `evaluateCondition`, `FileSystemPluginLoader`, `FileSystemPluginLoaderConfig`, `loadPlugins`, `mergePluginExports`, `getDefaultPluginDirs`, `emptyLoadedPlugins`, `LlmReranker`, `NoopReranker`, `RateLimiterLlm`, `RetryLlm`, `RetryOptions`, `TokenBucketConfig`, `TokenBucketRateLimiter`, `SessionManager`, `NoopSessionManager`, `ClaudeSkillManager`, `CodexSkillManager`, `FileSystemSkillManager`, `NoopTracer`, `lazy`, `LazyInitError`, `LazyOptions`, `NoopValidator`. Plus type re-exports of the core contracts (`AgentCallOptions`, `BaseAgentLlmBridge`, `SmartAgentHandle`, `SmartAgentRagStores`) for ergonomics.

## Subpath exports

- `@mcp-abap-adt/llm-agent-libs/testing` — test helpers.
- `@mcp-abap-adt/llm-agent-libs/otel` — OpenTelemetry tracer adapter.

## Optional peer dependencies (LLM providers)

- `@mcp-abap-adt/openai-llm`
- `@mcp-abap-adt/anthropic-llm`
- `@mcp-abap-adt/deepseek-llm`
- `@mcp-abap-adt/sap-aicore-llm`

Install only the providers you use. Missing providers throw `MissingProviderError` at first call to `makeLlm` or `makeDefaultLlm`.

## Migration from 12.0.0

```ts
// Before (12.0.0 — symbols were in llm-agent-server, which is now binary-only)
import {
  SmartAgentBuilder,
  SessionManager,
  makeLlm,
} from '@mcp-abap-adt/llm-agent-server'; // ← no longer valid

// After (12.0.1+)
import {
  SmartAgentBuilder,
  SessionManager,
  makeLlm,
} from '@mcp-abap-adt/llm-agent-libs';

// makeLlm is now async — add await at direct callsites
const llm = await makeLlm(cfg, temperature);
```

`SmartAgentBuilder.build()` is already async; users of the builder are unaffected by the `makeLlm` async conversion.

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.
