# @mcp-abap-adt/llm-agent-libs

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

Core SmartAgent composition runtime. Builder, agent runtime, pipeline, sessions, history, resilience, observability, plugins, skills.

## Top-level exports

`SmartAgentBuilder`, `SmartAgentBuilderConfig`, `BuilderMcpConfig`, `BuilderPromptsConfig`, `SmartAgentReconfigureOptions`, `LlmAdapter`, `LlmAdapterProviderInfo`, `LlmProviderBridge`, `NonStreamingLlm`, `wrapEmbedder`, `SmartAgent`, `ConfigWatcher`, `ConfigWatcherOptions`, `HotReloadableConfig`, `HealthChecker`, `HealthCheckerDeps`, `HistoryMemory`, `HistorySummarizer`, `DefaultRequestLogger`, `NoopRequestLogger`, `InMemoryMetrics`, `NoopMetrics`, `DefaultPipeline`, `PipelineExecutor`, `buildDefaultHandlerRegistry`, `evaluateCondition`, `FileSystemPluginLoader`, `FileSystemPluginLoaderConfig`, `loadPlugins`, `mergePluginExports`, `getDefaultPluginDirs`, `emptyLoadedPlugins`, `LlmReranker`, `NoopReranker`, `DecisionReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`, `wrapDecisionModel`, `EmbeddingRetrieval`, `RerankedRetrieval`, `RerankAllRetrieval`, `StrategyRag`, `applyRetrievalStrategy`, `hasRetrievalStrategy`, `RateLimiterLlm`, `RetryLlm`, `RetryOptions`, `TokenBucketConfig`, `TokenBucketRateLimiter`, `SessionManager`, `NoopSessionManager`, `SessionGraph`, `SessionGraphFactory`, `SessionRegistry`, `ClaudeSkillManager`, `CodexSkillManager`, `FileSystemSkillManager`, `NoopTracer`, `lazy`, `LazyInitError`, `LazyOptions`, `NoopValidator`. Plus type re-exports of the core contracts (`AgentCallOptions`, `BaseAgentLlmBridge`, `SmartAgentHandle`, `SmartAgentRagStores`) for ergonomics.

**Since v27:** the LLM factories and the default model resolver are removed — this package
constructs no LLM provider. See "Optional peer dependencies" below and docs/MIGRATION-v27.md item 2.

## Subpath exports

- `@mcp-abap-adt/llm-agent-libs/testing` — test helpers.
- `@mcp-abap-adt/llm-agent-libs/otel` — OpenTelemetry tracer adapter.

## Optional peer dependencies

This package constructs no LLM provider: pass an `ILlm` to `withMainLlm`. Construct the provider you
want yourself, from its own package (`@mcp-abap-adt/openai-llm`, `-anthropic-llm`, `-deepseek-llm`,
`-sap-aicore-llm`, `-ollama-llm`, …) — see [docs/MIGRATION-v27.md](../../docs/MIGRATION-v27.md) item 2.

## Migration from 12.0.0

```ts
// Before (12.0.0 — symbols were in llm-agent-server, which is now binary-only)
import {
  SmartAgentBuilder,
  SessionManager,
} from '@mcp-abap-adt/llm-agent-server'; // ← no longer valid

// After (12.0.1+)
import {
  SmartAgentBuilder,
  SessionManager,
} from '@mcp-abap-adt/llm-agent-libs';
```

`SmartAgentBuilder.build()` is already async.

**Since v27:** the LLM factories are gone; see docs/MIGRATION-v27.md item 2.

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.

## Request time

The shared `ContextAssembler` adds static `REQUEST_TIME_GUIDANCE` to the system prompt, including when no other system content exists. Each SmartAgent string request gets one `[request time] YYYY-MM-DD HH:mm +HH:mm (Zone)` line in request content, derived from its existing request start timestamp and reused across tool rounds. Message-array callers own their request time context unless they explicitly pass `requestStartedAt`. The timestamp never enters the system prompt, keeping its static guidance cacheable.

Use one deployment `timeZone` (default `UTC`) consistently in `SmartAgentConfig` and `DialogueSessionOptions`. The builder forwards the agent setting to `ContextAssemblerConfig`; standalone assemblers and `DirectLlmSubAgentOptions` also accept it. Invalid zones throw a `RangeError` naming `timeZone` at construction.

Dialogue workers inherit the owning request's `openedAt` through task options, even when queued. The session inserts the planner's line in both prepared and conversation modes using the session zone, without changing stored history or passing `requestStartedAt` to the planner. Hosts no longer append guidance to worker prompts. Direct calls to `ContextAssembler.assemble` or `DirectLlmSubAgent.run` should pass the existing request start as `requestStartedAt` in options or input respectively; these paths never read a clock. The assembler always inserts the line when this option is given, regardless of timestamp-like text already in client content or history.

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

## Usage analytics

Pass `{ usage: recorder.with({ sessionId, userId }) }` as the second argument
of `SmartAgent.process` or in `CallOptions` for component calls. DialogueSession
accepts `usage` in its open options; TaskBoard scopes workers with their task id
and role. Worker adapters forward `input.usage`. A caller's recorder survives
normalization and adapter layers. Retry and chunk wrappers preserve one logical
operation while providers record each physical request separately.

Use `@mcp-abap-adt/llm-usage` for buffered collection or implement
`IUsageRecorder` from `@mcp-abap-adt/llm-agent` to replace it. See the
[usage overview](../../docs/USAGE_ANALYTICS.md) for injection, replaceable
transports/sinks, shutdown and loss semantics. Usage records exclude content;
request logging is a separate API with different data and retention needs.

## Dialogue wait mode

`DialogueSession.open` accepts `waitTickMs` (default 30,000) and `longTaskMs`
(default 300,000). Both are non-negative integers; zero disables that feature
independently. While tasks are queued or running, wait ticks emit `dialogue.wait`
without calling the planner. Running tasks wake it through non-terminal
`long_running` events once per `longTaskMs`; settled tasks' queued wake events
are discarded. Long-running events carry no task usage and allow `NO_MESSAGE`.
Timers stop when no tasks remain active and on close. Restored tasks become
interrupted, so no timer runs for them. Timers are unref'ed; `now` and the optional
`scheduleTimer(callback, delayMs)` cancellation-function factory support fake clocks.

A second `get_task` on active work or `list_tasks` with active work in the same
turn ends the turn unless a task outcome intervened. Finished-task reads and
other tools do not count. The session aborts a turn-owned cooperative `stopSignal`,
combined with the caller's `stopSignal`. SmartAgent's tool loop answers the tool
call, then returns accumulated text and usage before another model call. The
session suppresses corrections and uses a waiting note if no text was produced;
`[actions]` records `wait (turn ended: tasks running)`. Caller `signal` retains
hard cancellation behavior. See [the dialogue guide](../../docs/PIPELINES.md#dialogue-planner).
