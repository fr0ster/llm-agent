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

## Dialogue coordination and planning

Pass an `IPlanAuthor` to `DialogueSession.open({ planAuthor, ... })` to separate
planning from conversation. Profile mode selects `prompts.coordinator ??
DIALOGUE_COORDINATOR_SYSTEM`; a supplied planner instance should use that coordinator
prompt itself. Without `planAuthor`, the existing planner mode is preserved.

`ProfilePlanAuthor({ source, runner, notes? })` implements the stateless core
`IPlanAuthor`: `create({ goal, context?, references? }, options?)` and
`revise({ plan, change, brief? }, options?)` return a typed plan or author error.
It selects `plannerCreate` / `plannerRevise` from source prompts, falling back to
`PLAN_CREATE_SYSTEM` / `PLAN_REVISE_SYSTEM`, and calls `runner.preparePlanAuthor`
for a fresh tool loop. The host enforces read-only knowledge tools and excludes
SAP tools at definition and execution time. Revisions retain completed work;
invalid output leaves the session plan unchanged.

`PlannerToolsClient` exposes `plan_create`, `plan_revise` only with an author,
plus `plan_get`, `plan_update`, `delegate_task`, `get_task`, `list_tasks`,
`stop_task`, `search_knowledge`, `new_request` and `deliver`. `plan_create` stores
a new authored plan; `plan_revise` merges a revision of the current structured
plan. `plan_get` reads filtered, paged steps; `plan_update` edits without an LLM
call. `get_plan` / `update_plan` have been removed without aliases.

External coordinators can use `session.callTool(name, args, { signal? }?)` without
a planner turn or planner agent. It returns `Result<McpToolResult, McpError>`,
persists state and emits normal plan/task signals. Busy sessions refuse calls
with `isError: true` rather than queueing them; `new_request` / `deliver` are
turn-only. Task events stay in persisted `pendingEvents` without waking the LLM;
the next user `send()` consumes them and resumes dialogue mode. These events are
separate from pending replies read by `takePending()`. See the
[dialogue guide](../../docs/PIPELINES.md#dialogue-planner) for details.

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

### Host-owned agent profiles

Supply `profileSource` and `profileRunner` together to `DialogueSession.open` or
`TaskBoard`. Legacy `workers` maps and planner instances remain supported. Profile
mode needs no workers-map entry for a new function. A standalone profile board uses
`await board.startTask(request)`; `board.start(request)` preserves the synchronous
legacy API. `profileTimeoutMs` defaults to 3000 milliseconds per source resolution.

The source implements the public `IAgentProfileSource` contract: `list()` returns
enabled names, descriptions and result kinds; `get(name)` performs an exact,
case-sensitive lookup and distinguishes missing from disabled records; `getPrompts()`
returns optional `workerBase`, `planner`, `coordinator`, `plannerCreate` and
`plannerRevise` text. Empty strings are explicit text; absent fields select the
corresponding library defaults. Errors fail closed.
Do not use a positive TTL or stale-while-revalidate: check current revision and
availability on every lookup. Immutable revision bodies may then be cached by the host.

Discovery refreshes before every planner call, including corrective calls. Delegation
validates the enabled name and full record. After acquiring its concurrency slot, a
task reloads its profile and prompts, so queued edits apply. A changed result kind
fails that attempt and requires reopening the step. Running tasks retain a snapshot.
Profile source failures never substitute a legacy worker or stale prompt.

The runner implements `IAgentProfileRunner`. `createWorker` constructs a task-scoped
agent from `workerBase` followed by `profile.systemPrompt`. Route these through
`ContextAssembler.systemPromptPreamble`; `DirectLlmSubAgent` accepts `workerBase`
alongside `systemPrompt`. Library protocol guidance follows this static text.
Retrieved skills, extra fragments, brief, dependency results and request time belong
in request content. `preparePlanner` applies the resolved `systemPrompt` to a fresh
call-scoped planner, replacing its default text. Reusable provider clients are fine;
mutable per-task prompts and tool settings must never be shared.

Profiles request permissions; they do not grant them. The runner must intersect the
requested policy with a code-owned ceiling. `all` means all within that ceiling;
omitted `allow` leaves it unchanged; `deny` wins. The host defines exact tool names
and read-only classes and rejects unsupported policies. Verdict workers always have
a read-only ceiling. Filter offered definitions and enforce authorization on every
execution path, including direct calls, MCP, external tools, nested delegation and
resumed calls. An allowed tool must not indirectly broaden privileges. The library
cannot sandbox an arbitrary host agent.

The library profile tests keep a contract fixture proving that policies reach the
runner unchanged. Host conformance tests live in the host and cover ceiling
intersection, deny precedence, verdict read-only limits, offered-definition filtering
and enforcement across direct, MCP, external, nested and resumed calls.

Assign independent checks to profiles with `result: 'verdict'`; other functions use
`result: 'report'`. Structured plans bind roles through library resolution, require
successful independent report sources and retain delivery restrictions even when
profiles are removed. Additive persisted role fields keep completed attempts auditable
without saving prompt bodies or tool authorization. Legacy checker records normalize
to verdict without changing names or source bindings. Explicit-source hosts restoring
these records must expose an enabled verdict alias named `checker`, or explicitly
reopen and reassign those steps.

For manual host integration, add a RAG record with a new exact name and description,
select it through the planner, edit its prompt and tool policy, and verify that the
next task uses the revision and narrowed tools. Disable it and verify a named tool
error with no worker invocation. This requires the host's real source and enforcing
runner; no new library environment variables or RAG backend are supplied.

An executable in-memory RAG host integration fixture lives in
`src/coordinator/dialogue/__tests__/agent-profiles.test.ts`, named
`RAG-backed host integration: exact discovery, prompt/policy edits and disablement reach actual runner assembly`.
Run it from the repository root with
`node --import tsx/esm --test --test-name-pattern="RAG-backed host integration" packages/llm-agent-libs/src/coordinator/dialogue/__tests__/agent-profiles.test.ts`.
It stores and edits exact profile records in `InMemoryRag`, delegates through planner
tools, assembles the refreshed worker prompt, computes permissions for two host-owned
direct tools, rejects a denied direct call, and disables the record without starting
another task. This fixture does not establish enforcement in a production host or
through MCP, external, nested or resumed routing; those remain host obligations.
