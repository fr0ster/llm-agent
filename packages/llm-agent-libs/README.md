# @mcp-abap-adt/llm-agent-libs

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

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

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`GPL-3.0.txt`](GPL-3.0.txt) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
