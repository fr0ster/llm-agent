# @mcp-abap-adt/llm-agent

## 20.5.0

### Features

- **Per-round tool-loop context strategy — `IToolLoopContextStrategy` (#224).** A consumer-swappable seam for how each tool-loop round forms the executor's context, with four strategies: `LegacyAccumulate` (byte-identical default), `Window` (RAG-less bounded window), `RagRecall` (generic RAG-managed, fail-loud `runId`+counter), and `LegacyTranscript` (one-release resume migration). Threaded via a DI factory (builder + `ctx` + deps); the controller injects `RagRecall`, the server default and the direct `SmartAgent` inject `Window`, a bare agent keeps `LegacyAccumulate`. Both the shared tool-loop and the direct loop now form per-round context via the strategy (+ a `controlTail` for validation reprompts), dropping raw transcript accumulation. Effect on a heavy live run: the outlier prompt dropped from ~1.1M to ~134k tokens and per-round executor context from ~30.7k to ~7.8k.
- **Controller per-step / per-run execution control — `IStepExecutionControl` + `IRunExecutionControl` (#224).** Two focused ISP seams that give the controller a *time* budget (it previously had only count budgets, so a non-converging plan step could run to the outer HTTP timeout — an executor livelock). `DefaultStepExecutionControl` adds a wall-clock `budgets.perStepTimeoutMs` (explicit `AbortController`+`setTimeout`) plus a prospective `maxToolCalls` gate; the per-step `AbortSignal` is merged (`AbortSignal.any`) into **both** the executor LLM call and MCP `callTool`/`listTools`, so the step is bounded regardless of what consumed the time. A cut is a typed `control-failure` (`'maxToolCalls' | 'step-timeout' | 'control-failure'`) that the planner replans on; the #223 MCP-unavailable fail-loud order is preserved. `IRunExecutionControl` ships as a no-op default (run-level budget deferred). Wired via `BuildAgentDeps` / `IPipelineContext` (no builder change); no injection + no `perStepTimeoutMs` ⇒ byte-identical.
- **`IAuxiliaryMcpTools` — pipeline-level auxiliary/service MCP tools, first tool `wait` (#225).** A narrow, consumer-swappable seam (`listTools`/`callTool`, **not** `extends IMcpClient`, no `healthCheck`, outside the MCP fail-loud classifier) through which a pipeline contributes stateless service tools into the tool-selection catalog and the `callMcp` bridge — always present, even MCP-less. The default `wait` tool pauses N seconds (clamped to a max, and bounded above by `perStepTimeoutMs` — a wait beyond the step budget is cut → `step-timeout`→replan; an abort propagates and is never mapped to a string). `DefaultAuxiliaryMcpTools`/`makeWaitTool`/`cancelableDelay` live in `@mcp-abap-adt/llm-agent-mcp`; the composition (`resolveAuxDefs`/`assertNoAuxCollision`/`composeAuxiliaryBridge`/`composeAuxiliarySelect`) in `@mcp-abap-adt/llm-agent-server-libs`. Wired via `BuildAgentDeps.auxiliaryMcpTools` / `IPipelineContext.auxiliaryMcpTools`; the controller contributes the default `wait` at `build()`, consumer overrides the whole provider. RAG is deliberately **not** exposed through this seam.

### Config

- **`pipeline.config.budgets.perStepTimeoutMs`** (controller) — optional per-step wall-clock budget in ms. Absent ⇒ time never fires (count-only bound, as before).

### Behavior notes

- The controller default now adds `wait` to its offered tools (the livelock-mitigation point). Restore the prior tool surface by injecting an empty provider: `ctx.auxiliaryMcpTools = new DefaultAuxiliaryMcpTools([])`.
- **Fail-loud collision:** a controller + MCP deployment whose domain catalog already exposes a tool named `wait` now **throws at build** (`assertNoAuxCollision`) — intentional (better than silently shadowing); remedy: rename the auxiliary tool or inject an empty provider.
- The guidance for using `wait` (decompose an async `activate` into `activate → wait → verify` as separate plan steps) is a **consumer skill** (skills-RAG, runtime) reaching the controller planner via its existing skills-recall hook — it is NOT shipped in these packages.

## 20.4.0

### Fixes

- **The controller pipeline no longer returns a silent `(no response)` when the MCP *server* is unavailable (transport drop / `fetch failed` / 404 / 502) mid-run (#223).** An unrecoverable MCP availability error during the executor's tool step is now escalated and surfaced as a LOUD error instead of degrading to empty content. This closes the residual gap in the #201–205 fail-loud lineage — both on the shared tool-loop core (`ok:false` `OrchestratorError('MCP_UNAVAILABLE')`) and on the controller bridge (a loud `abortTerminal` "MCP server unavailable: …" chunk).
- **`toMcpError` now classifies streamable-HTTP transport errors — including a 404 route-gone (`MCP_HTTP_404`) — as MCP-unavailable (#223).** A genuine tool-level "not found" still maps to `MCP_ERROR`: the 404/"not found" match is gated inside the streamable-HTTP wrapper signature, preserving the anti-false-positive guard.
- **The controller trusts the bridge throw-contract (#223).** `buildMcpBridge` throws only when the classifier deems a failure `'unavailable'` (tool-level errors are returned as text, never thrown), so the controller catch now surfaces any thrown `McpError` loudly instead of re-checking the code with a hardcoded `isMcpUnavailable` — which previously dropped a *custom* classifier's verdict for otherwise-tool-level codes. The `pipeline: controller` path forwards `ctx.mcpFailureClassifier` into its bridge.

### Features

- **`IMcpFailureClassifier` — a consumer-swappable strategy that decides `'unavailable'` (fail loud) vs `'tool-error'` (feed back to the LLM) for a failed MCP tool call (#223).** Wired via dependency injection at both MCP-failure decision points (`buildMcpBridge` and the shared `classifyToolResult`), threaded to both tool-loop callers (the direct `SmartAgent` and the pipeline `ToolLoopHandler`), the controller bridge, and a builder seam — `builder.withMcpFailureClassifier(...)` / `BuildAgentDeps.mcpFailureClassifier`. The default `DefaultMcpFailureClassifier` (in `@mcp-abap-adt/llm-agent-mcp`) is error-based (built on the existing `isMcpUnavailable`) and adds **no** per-call round-trip. An optional `probeHealth` seam (MCP `ping` via `IMcpClient.healthCheck`) lets a consumer implement a health-confirming classifier; the default never probes. **DI/programmatic only — no YAML / `SmartServerConfig` change.**

### Notes

- With no classifier injected, runtime behavior is byte-identical to before this release (the default classifier is `isMcpUnavailable`-based and ignores the probe). New public surface: `IMcpFailureClassifier` / `McpFailureKind` (`@mcp-abap-adt/llm-agent`), `DefaultMcpFailureClassifier` (`@mcp-abap-adt/llm-agent-mcp`), `MCP_HTTP_404` in `MCP_UNAVAILABLE_CODES`, `builder.withMcpFailureClassifier(...)`, and the optional `mcpFailureClassifier` field on `IPipelineContext` / `IExecuteToolBatchArgs` / `SmartAgentDeps` / `PipelineDeps` / `BuildAgentDeps`.
- Does **not** touch the #222 request-timeout work (folded in via 20.3.0). This release supersedes the tagged-but-unpublished 20.3.0 (and the earlier held 20.1.0 / 20.2.0) — see their CHANGELOG sections.

## 20.3.0

### Fixes

- **MCP tool calls no longer hit the SDK's implicit ~60s timeout (or hang) on heavy runs (#222).** `MCPClientWrapper.callTool` now passes an explicit, consumer-owned request timeout to the MCP SDK instead of falling through to its built-in ~60s `DEFAULT_REQUEST_TIMEOUT_MSEC` (which produced `-32001: Request timed out` → a silent `(no response)` on long multi-tool controller reviews). The timeout is a **generous per-call safety net**: `resolveToolTimeout(name) = toolTimeouts[name] ?? timeout ?? 120000` (2 min default), with `resetTimeoutOnProgress` so a tool that reports progress is not cut off. A stuck/orphaned call now dies at the resolved limit — no indefinite server hang.
- Removed the redundant MCP "timeout stack": the transport `requestInit` per-request `AbortSignal.timeout` cutoff and the connect-bound are gone — there is exactly one MCP timeout (the `callTool` one). Connection availability stays governed by the connection-strategy layer; the adapter's `withAbort(signal)` cancellation is unchanged. HTTP session-resume is preserved (the live server-assigned session id survives reconnect).

### Features

- **Configurable MCP request timeouts, per client and per tool (#222).** New `mcp.timeout` (default 120000 ms) sets the per-call default; `mcp.toolTimeouts: { <toolName>: <ms> }` sets per-tool overrides (some tools legitimately take 5–15 min). Settable in YAML and programmatically; threaded through both the builder→factory and the YAML/server construction paths, for HTTP and stdio transports.
- **`IMcpRequestHeadersStrategy` (#222)** — an optional, consumer-owned strategy (default `NoopMcpRequestHeadersStrategy`, contributes nothing) to inject MCP request headers (e.g. a server-side "willing to wait longer" hint), wired via `builder.withMcpRequestHeadersStrategy(...)`. YAML users use the existing static `mcp.headers`.
- **MCP tool-call timing observability (#222).** Each MCP tool call emits a `tool_call` structured `LogEvent` (`toolName`, `isError`, `durationMs`) plus an `mcp_tool_call` session-debug step — through the existing structured logging (verbosity follows the run mode), including on timeout/unavailable failures. A `durationMs` near a tool's resolved timeout tells you which tool to raise via `toolTimeouts`.

### Notes

- This release also folds in the previously-tagged-but-unpublished 20.1.0 and 20.2.0 work (see their CHANGELOG sections): controller recalled-skill → finalizer delivery directives (#212), `/health` model-alias false-negative (#220), SAP AI Core concurrency hardening (#213/#219), `skillPlugins` docs (#211), and the monolith-decomposition campaign (#206–#218).

## 20.2.0

### Features

- **Controller: recalled skills now shape the finalizer's delivered answer (#212).** A `controllerSkillGroup` skill's output/delivery/formatting directives are honored in the delivered text, not just the plan. The engine stays agnostic — a generic honor-clause; the consumer's skill supplies the directive. With no skill configured the finalizer prompt is byte-unchanged; the "do not invent facts" guard is retained (skills govern delivery only).

### Fixes

- **`/health` no longer returns 503 for a working LLM (#220).** `LlmAdapter.healthCheck` reported a reachable LLM unhealthy when the configured model name was a valid alias absent from the provider's `/models` list (e.g. deepseek `deepseek-chat`). Now a reachable provider is healthy; LLM/RAG/MCP soft failures map to `degraded` (not `unhealthy`); `/health` returns 503 only when NOT ready (MCP-readiness gate unchanged, still fails loud); the LLM probe logs its failure cause instead of swallowing it. The `/health` JSON shape is unchanged.
- **SAP AI Core concurrency hardening (#213/#219).** `chat()` now uses a per-call non-keepAlive HTTPS agent (mirroring `streamChat`), avoiding a shared keepAlive connection that could let SAP AI Core route a response to the wrong in-flight request when concurrent requests share one XSUAA user.

### Docs

- **`skillPlugins` inline-record example uses the required `id` (not `name`) (#211).** The documented example crashed the server at startup (`id` is required; `name` is optional and defaults to `id`); corrected in `docs/EXAMPLES.md`.
- Documented that controller skills shape BOTH the planner and the finalizer (`EXAMPLES.md`, `ARCHITECTURE.md`, `PIPELINES.md`).

## 20.1.0

### Added

- **MCP readiness & fail-loud** (#201–#205): a first-class readiness surface for
  MCP-backed servers. `/health` now returns **503** while MCP is not ready; a
  pre-dispatch request gate rejects work that needs an unavailable MCP; and every
  execution surface **fails loud** instead of returning a silent `(no response)`.
  Built ON the MCP connection strategies (+ a small `IReadinessReporter`), with
  error classification and session-preserving reconnect; the builder now defaults
  MCP to a connection strategy with agent readiness.

### Changed

- **Behavior:** requests and health checks now surface MCP-unavailability errors
  loudly (503 / typed error) where prior versions could return an empty/degraded
  response. No published config key or API was removed — a config that loaded
  before still loads and runs; only genuine MCP-down conditions now error clearly.
- **Internal decomposition (monolith audit, #206; PRs #208–#218) — public API
  byte-stable, behavior-preserving.** The largest runtime files were decomposed
  into focused, individually-testable modules (all moves byte-for-byte, verified
  against characterization tests + whole-branch review):
  - `smart-server.ts` 3926 → 2559 (7 components + full HTTP handler extraction +
    `makeToolsRagHandle` factory).
  - `agent.ts` 2160 → 1302 and the shared tool-execution core deduped into
    `pipeline/handlers/tool-loop-core.ts`.
  - `config.ts` 1648 → 269 (5 modules + a thin `resolveSmartServerConfig`
    delegating per-section builders).
  - `controller-coordinator-handler.ts` 2026 → 1682 (parser/recall/usage-logging
    siblings) and an inverted dependency fixed (`planner`/`reviewer` no longer
    import from the handler).
  - `builder.ts` 1437 → 1182, extracting MCP **tool vectorization** into
    `mcp/vectorize-mcp-tools.ts` — closing the `docs/ARCHITECTURE.md` tech-debt.
  These changes are internal only; every public export path is unchanged.

## 20.0.0

### Added
- Controller planner capability-tuned planners (§C): smart-executor (default `controller`) and weak-executor (new `controller-weak` preset); preset-encoded selection; `ControllerFactory.build(config, deps, kind)` + `deps.controllerPlanner` DI seam.
### Changed
- `controller` defaults to the live digest board (smart-executor; was incremental).
### Removed
- `planner:` controller config key + `IncrementalPlanner` (clean break, fail-loud — no alias).
### Fixed / Docs
- v19 documentation-accuracy pass: migrated ~25 example configs + docs off removed shapes (`coordinator:`, structured `pipeline:{version,stages}`, `withStageHandler`) to the current `pipeline:{name,config}` model; all shipped examples config-validate.

## 19.2.0

### Added
- Controller planner — step identity & live digest board (Phase 1+2): stable per-step
  `stepId`, `plan-decision` artifacts, reviewer planning `digest` (`ReviewOutcome`),
  `stepId`+`digest` on every step-result (incl. control failures), bounded
  `renderBoard` with a guaranteed cap (fail-loud), additive board+plannerPrivate
  prompt, canonical writeOrdinal replay (no phantom planned orphans).
- Skill plugin-host & runtime gnostification (`skillPlugins:`): domain-agnostic host
  materialising consumer skills into a grouped skills-RAG; marketplace + inline
  sources; controller + assembler recall.
- Controller execution-result control & data backbone: reviewer/finalizer split,
  durable run-scope + crash recovery, run-scoped embedding recall.

### Fixed
- Results-RAG: bound embed input (`maxEmbedChars`, default 16000) for large tool/step
  results so an over-limit document no longer 400s the embedder and stalls the run;
  stored content stays full.

## 19.1.2

Release 19.1.2.

## 19.1.1

Release 19.1.1.

## 19.1.0

Release 19.1.0.

## 19.0.0

### ⚠ BREAKING CHANGES

- **Pipeline selection is now plugin-based.** The old top-level `coordinator:` YAML block and the legacy `pipeline: { mcp | rag | stages | llm }` overrides are **removed**. Select a pipeline with `pipeline: { name, config }` where `name` is `flat` | `linear` | `dag` | `stepper` | a custom plugin name. A config still using the old form **fails loud** at startup with a migration message. Top-level `llm:`, `mcp:`, `rag:`, `subagents:` are unchanged.
  - **Migration:** `coordinator: { mode: planned-react, knowledgeSeed: [...] }` → `pipeline: { name: stepper, config: { mode: planned-react, knowledgeSeed: [...] } }`; DAG (`planner`/`reviewer`/`finalizer`) → `pipeline: { name: dag, config: {...} }`; linear (`planning`/`dispatch`/`activation`) → `pipeline: { name: linear, config: {...} }`. `knowledgeSeed` now lives under `pipeline.config`. Pin a version `<= 18` for the old behavior.

### Added

- **Pipeline plugins.** A pipeline is an `IPipelinePlugin` (core `@mcp-abap-adt/llm-agent`) that builds an `IPipelineInstance` (`{ agent, close }`). Built-in `flat`/`linear`/`dag`/`stepper` wrap the existing coordinator components. Custom pipelines load dynamically via `plugins: [<module-specifier>]` (resolved against the user's cwd; a module's full `PluginExports` — incl. `embedderFactories`/`mcpClients` — is merged before RAG). Duplicate pipeline names across sources fail fast.
- **Subpath exports** from `@mcp-abap-adt/llm-agent-server-libs`: `./flat` `./linear` `./dag` `./stepper` (built-in plugins) and `./legacy/<flow>` (the pre-v19 coordinator components, for code-level composition without YAML). `IServerPipelineContext` + `createServerPipelineContext` are exported for plugin authors.

### Changed

- The per-session request-serving agent is built by the resolved pipeline plugin; the startup global agent remains the infra/passthrough handle. The plugin contract (`IPipelineInstance = { agent, close }`) stays core-clean — server concerns live in `IServerPipelineContext`.

### Fixed

- **MCP wiring.** A YAML `mcp:` block now connects **exactly once** (the prior path double-connected). `toolsRag.lookup()` resolves **synchronously before any query** (catalog eager-loaded at startup). MCP **tool-vectorization is preserved** for the YAML path (so `smart`/`flat` pipelines still surface MCP tools to the model). An explicit `mcpClients: []` **disables MCP** and overrides a YAML `mcp:` block (DI precedence).

## 18.2.0

Client-provided external tools under the DAG coordinator (#171). External (client) tools are now mode-independent (always offered; `hard` governs only internal MCP execution), consumer-executed (the worker surfaces a standard tool_call via the normal OpenAI/Anthropic round-trip — no custom transport), and carry deterministic content-addressed `ext:` ids for stateless re-run correlation. Parallel DAG workers' external calls are collected into one terminal assistant turn; incoming external results are adjacency-validated and the consumed turns stripped from internal LLM message lists.

## 18.1.2

### Patch Changes

- Fix: `usage.models` now keys by the LIVE (hot-swapped) model, not the stale initial one (#164).

  `SmartAgent.reconfigure()` swapped its own `_mainLlm` but the `DefaultPipeline` held a separate `deps.mainLlm` snapshot, so a hot-swapped request kept logging — and aggregating `usage.models` under — the initial model name. `reconfigure()` now propagates the swap into the pipeline. Also lands an env-gated `node:test` integration check that the DAG coordinator dispatches real MCP-tool work to its worker (regression gate for the toolless/hallucination path, #159), and the reviewed design spec + implementation plan for client-provided external tools under the DAG coordinator (#171).

## 18.1.1

### Patch Changes

- Version alignment — unify ALL workspace packages to a single version.

  18.1.0 bumped only the six core packages (the changeset `fixed` group at the time), leaving the eleven provider / embedder / RAG-backend packages at 18.0.2. The `fixed` group now contains all 17 packages so every release moves them together. This release carries no functional change — it only realigns the provider/embedder/backend packages (18.0.2 → 18.1.1) and the core packages (18.1.0 → 18.1.1) to one version.

## 18.1.0

### Minor Changes

- 18.1 — Evaluator spine, hallucination guards, and the SmartServer composition library.

  - **Evaluator (per-level input judge):** the Stepper coordinator now runs an LLM Evaluator before planning that routes a step `executable | needs-work | needs-consumer` with a `missing[]` list, on by default at all depths; recursion requires it as a terminator. The `missing` gaps drive an additive, single-intent tool search (prompt-search ∪ needs-search) so a "review the program" prompt surfaces `GetProgram` while the needs surface `GetInclude`/`GetIncludesList`.
  - **Hallucination guards (Stepper executor):** an explicit no-capability error — when the Evaluator established a need but the toolset is empty after all seeding, the executor throws a clarify signal instead of fabricating an answer (`allowToolless` to opt out); and a token-grounding detector — a final answer produced with no tool calls, no grounding facts, and tools on offer is flagged (`hallucination_suspected`) with token evidence.
  - **New package `@mcp-abap-adt/llm-agent-server-libs`:** the SmartServer composition runtime is now an importable library (between the binary and core `llm-agent-libs`). It carries `SmartServer`, `buildFromComposition`/`buildStepperRoot`, `StepperCoordinatorHandler`, coordinator config parsing, session stores, and the **pipeline builder-factories** `LinearFactory`, `DagFactory`, `CyclicFactory`, `PlannedFactory`, `DeepStepperFactory` (each builds one pipeline's `coordinator` stage handler from a typed config + role-resolving deps). `buildFromComposition` accepts a `makeRoleLlm` callback so factories work without the server's config types. `@mcp-abap-adt/llm-agent-server` is now a thin binary that depends on it (behaviour unchanged).
  - **Clean plain-mode content:** an `ephemeral` flag on `LlmStreamChunk`/`StreamChunk` marks tool-loop liveness markers (`[SmartAgent: Executing X]`) so they are excluded from non-streaming content accumulation — `stream:false` responses no longer leak execution traces; streaming clients still receive them.

## 12.0.3

### Patch Changes

- 108cd1d: Complete the v12 package split: introduce `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, and `@mcp-abap-adt/llm-agent-libs`. `@mcp-abap-adt/llm-agent-server` becomes binary-only — composition surface lives in `llm-agent-libs`, MCP in `llm-agent-mcp`, RAG/embedder in `llm-agent-rag`, interfaces and DTOs in `llm-agent`. Top-level `makeLlm` / `makeDefaultLlm` / `makeRag` are now async (`Promise<...>`); `resolveEmbedder` remains synchronous and uses the existing prefetch contract. `SmartAgentBuilder.build()` was already async — consumers using only the builder are unaffected. Closes #125.

## 12.0.0

### Major Changes

- Move library helpers from `@mcp-abap-adt/llm-agent-server` into `@mcp-abap-adt/llm-agent` (#123).

  **BREAKING CHANGE.** Embedded consumers that ship their own HTTP server can now depend on `@mcp-abap-adt/llm-agent` only and skip the server package entirely. The following symbols are no longer exported from `@mcp-abap-adt/llm-agent-server` — import them from `@mcp-abap-adt/llm-agent` instead:

  - **Resilience:** `CircuitBreaker`, `CircuitBreakerConfig`, `CircuitState`, `CircuitBreakerLlm`, `CircuitBreakerEmbedder`, `FallbackRag`
  - **LLM call policies:** `NonStreamingLlmCallStrategy`, `StreamingLlmCallStrategy`, `FallbackLlmCallStrategy`
  - **Tool cache:** `ToolCache`, `NoopToolCache`, `IToolCache`
  - **API adapters:** `AnthropicApiAdapter`, `OpenAiApiAdapter`, `AdapterValidationError`, `ApiRequestContext`, `ApiSseEvent`, `ILlmApiAdapter`, `NormalizedRequest`
  - **Client adapters:** `ClineClientAdapter`, `IClientAdapter`
  - **Tool utilities:** `normalizeAndValidateExternalTools`, `normalizeExternalTools`, `ExternalToolValidationCode`, `ExternalToolValidationError`, `CLIENT_PROVIDED_PREFIX`, `getStreamToolCallName`, `toToolCallDelta`
  - **Logger:** `ILogger`, `LogEvent`

  `@mcp-abap-adt/llm-agent` runtime dependencies remain unchanged (`zod` only). The runnable distribution (`SmartAgentBuilder`, `SmartServer`, providers/factories composition root, plugins, skills, sessions, metrics, tracer, validator, reranker, history, structured pipeline, health, config watcher, MCP client wrapper, CLI, bin entries) stays in `@mcp-abap-adt/llm-agent-server`.

## 11.1.2

### Patch Changes

- Bump dependencies: biome 2.4.13, typescript 6.0.3, @types/node 25, rimraf 6, zod 4.3. MCP SDK 1.29 supports zod 3 || 4; smoke-tested via `npm run dev` against real MCP server.

## 11.1.1

### Patch Changes

- Fix streaming `tool_calls` regression introduced in the 10.x provider split (#119) and surface MCP setup failures that were previously swallowed (#118).

  - **Streaming providers now emit normalized `toolCalls` deltas.** `sap-aicore-llm` reads `chunk.getDeltaToolCalls()`, `openai-llm` (and `deepseek-llm` by inheritance) reads `choice.delta.tool_calls`, and `anthropic-llm` tracks `tool_use` content blocks plus `input_json_delta` — populating the new optional `LLMResponse.toolCalls` field. `LlmProviderBridge` accumulates from this normalized field instead of digging into provider-specific `raw` payloads (it previously handled only the OpenAI shape, so SAP and Anthropic streaming tool calls were dropped). Anthropic also normalizes `stop_reason: 'tool_use'` → `finishReason: 'tool_calls'`.
  - **`SmartAgentBuilder.build()` no longer swallows MCP setup errors.** Connect failures (unreachable host, bad auth, container-network mismatch) and post-connect failures (tool vectorization throwing) now produce a `warning` log entry — `MCP setup failed for <url-or-command>: <error message>` — instead of disappearing into a bare `catch {}`. Graceful-degradation contract preserved.

## 11.1.0

### Patch Changes

- Released alongside the @mcp-abap-adt/sap-aicore-embedder + @mcp-abap-adt/llm-agent-server foundation-models scenario fix (#116, #117) and the @mcp-abap-adt/qdrant-rag dimension mismatch guard. No source changes in this package — version sync per the changesets fixed group.

## 11.0.0

### Major Changes

- Complete provider and backend extraction. Eight new packages shipped:
  @mcp-abap-adt/openai-llm, anthropic-llm, deepseek-llm, sap-aicore-llm,
  openai-embedder, ollama-embedder, sap-aicore-embedder, qdrant-rag.

  Breaking changes:

  - Back-compat re-exports from v10.0 removed. Each symbol lives in exactly
    one package. See docs/MIGRATION-v11.md for the symbol-by-symbol table.
  - Non-Smart Agent hierarchy removed. Use SmartAgent + a provider class
    directly.
  - Core runtime dep shrinks to zod only; axios and @sap-ai-sdk/\* move to
    their respective extracted packages.
  - Server provider dependencies are optional peer deps. Install only the
    peers your smart-server.yaml names. Missing peer throws
    MissingProviderError at startup.

## 10.0.0

### Major Changes

- Split single package into a monorepo with two initial packages:

  - `@mcp-abap-adt/llm-agent` — interfaces, types, and lightweight RAG default implementations.
  - `@mcp-abap-adt/llm-agent-server` — default SmartAgent, pipeline, LLM providers, MCP client, HTTP server, and CLIs.

  Consumers of the v9 single package must switch their imports to one or both v10 packages. See `docs/MIGRATION-v10.md` for the symbol-by-symbol mapping and install-command changes.

  CLI bins (`llm-agent`, `llm-agent-check`, `claude-via-agent`) remain available and are now shipped by `@mcp-abap-adt/llm-agent-server`.
