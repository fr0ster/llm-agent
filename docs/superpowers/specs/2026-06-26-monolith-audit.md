# Monolith audit

Monolith audit — analysis only, no code changes; feeds separate per-monolith refactor plans.
This document is built incrementally: each task appends a section.

## Component catalog reference

The table below is the "components-first" lookup used by later audit tasks to decide
"reimplement on existing component X" rather than inventing new code.

| Component / interface | Package | Owns (one line) |
|---|---|---|
| `IMcpConnectionStrategy` | `@mcp-abap-adt/llm-agent` | Contract for establishing/maintaining an MCP connection (connect, reconnect lifecycle) |
| `LazyConnectionStrategy` | `@mcp-abap-adt/llm-agent-mcp` | Defers MCP connection until first use; re-connects on demand |
| `PeriodicConnectionStrategy` | `@mcp-abap-adt/llm-agent-mcp` | Re-establishes MCP connection on a fixed time interval |
| `NoopConnectionStrategy` | `@mcp-abap-adt/llm-agent-mcp` | No-op strategy; connection is assumed externally managed |
| `makeConnectionStrategy` | `@mcp-abap-adt/llm-agent-mcp` | Factory: selects and instantiates the right `IMcpConnectionStrategy` from config |
| `IReadinessReporter` | `@mcp-abap-adt/llm-agent` | Implemented by objects that can report their own readiness status (health gate) |
| `IMcpClient` | `@mcp-abap-adt/llm-agent` | Thin contract over an MCP session: list tools, call tool, list resources |
| `McpClientAdapter` | `@mcp-abap-adt/llm-agent-mcp` | Adapts `MCPClientWrapper` to the `IMcpClient` interface |
| `MCPClientWrapper` | `@mcp-abap-adt/llm-agent-mcp` | Low-level MCP client wrapping the SDK transport (stdio/sse/stream-http/embedded) |
| `IStageHandler` | `@mcp-abap-adt/llm-agent` | Contract for a single named pipeline stage (handle request → result) |
| `CoordinatorHandler` | `@mcp-abap-adt/llm-agent-libs` | Stage handler: runs a multi-step coordinator loop (planning → dispatch → review) |
| `DagCoordinatorHandler` | `@mcp-abap-adt/llm-agent-libs` | Stage handler: DAG-based coordinator that executes steps as a directed acyclic graph |
| `StepperCoordinatorHandler` | `@mcp-abap-adt/llm-agent-server-libs` | Stage handler: cyclic stepper coordinator with suspend/resume and durable bundles |
| `IPipelinePlugin` | `@mcp-abap-adt/llm-agent` | Contract for a pipeline plugin: `name`, `build(config, context)` returns an `IPipelineInstance` |
| `IPipelineFactory` | `@mcp-abap-adt/llm-agent` | Contract for a factory that produces a `BuiltCoordinator` from deps |
| `LinearFactory` | `@mcp-abap-adt/llm-agent-server-libs` | `IPipelinePlugin`: builds a single-agent linear coordinator pipeline |
| `DagFactory` | `@mcp-abap-adt/llm-agent-server-libs` | `IPipelinePlugin`: builds a DAG multi-agent coordinator pipeline |
| `CyclicFactory` | `@mcp-abap-adt/llm-agent-server-libs` | `IPipelinePlugin`: builds the cyclic (stepper) coordinator pipeline |
| `PlannedFactory` | `@mcp-abap-adt/llm-agent-server-libs` | `IPipelinePlugin`: builds a planned-react stepper pipeline |
| `DeepStepperFactory` | `@mcp-abap-adt/llm-agent-server-libs` | `IPipelinePlugin`: builds the deep-stepper (nested decomposition) pipeline |
| `ControllerFactory` | `@mcp-abap-adt/llm-agent-server-libs` | `IPipelinePlugin`: builds the full controller pipeline (planner + executor subagents) |
| `HealthChecker` | `@mcp-abap-adt/llm-agent-libs` | Aggregates readiness of multiple `IReadinessReporter` components; exposes `/health` status |
| `ISessionManager` | `@mcp-abap-adt/llm-agent` | CRUD contract for agent sessions (create, get, list, delete) |
| `SessionManager` | `@mcp-abap-adt/llm-agent-libs` | Default in-memory `ISessionManager` implementation |
| `NoopSessionManager` | `@mcp-abap-adt/llm-agent-libs` | No-op `ISessionManager` for single-session or stateless deployments |
| `SessionGraph` / `SessionGraphFactory` | `@mcp-abap-adt/llm-agent-libs` | Graph of linked sessions; factory creates per-session agent sub-graphs |
| `makeLlm` / `makeDefaultLlm` | `@mcp-abap-adt/llm-agent-libs` | Async factories: instantiate an `ILlm` from provider config (openai/anthropic/deepseek/…) |
| `makeRag` | `@mcp-abap-adt/llm-agent-rag` | Async factory: creates an `IRag` from backend config (in-memory/qdrant/hana/pg) |
| `resolveEmbedder` | `@mcp-abap-adt/llm-agent-rag` | Sync: resolves a pre-fetched `IEmbedder` from config after `prefetchEmbedderFactories` |
| `IRequestLogger` | `@mcp-abap-adt/llm-agent` | Per-request token/tool-call/RAG usage sink; rolled up into `RequestSummary` |
| `DefaultRequestLogger` | `@mcp-abap-adt/llm-agent-libs` | Concrete `IRequestLogger`: accumulates entries, exposes `getSummary()` |
| `SessionRequestLogger` | `@mcp-abap-adt/llm-agent-libs` | `IRequestLogger` that rolls usage up into a session-scoped ledger |
| `parseLinearConfig` | `@mcp-abap-adt/llm-agent-server-libs` | Parses `pipeline: linear` YAML block into `CoordinatorHandlerDeps` |
| `parseStepperCoordinatorConfig` | `@mcp-abap-adt/llm-agent-server-libs` | Parses stepper/cyclic YAML block into `StepperCoordinatorConfig` |
| `resolveSmartServerConfig` | `@mcp-abap-adt/llm-agent-server-libs` | Loads + validates the full `smart-server.yaml` into a typed `SmartServerConfig` |
| `SmartServer` | `@mcp-abap-adt/llm-agent-server-libs` | HTTP server wrapper: routes `/v1/chat`, `/health`, session endpoints; lifecycle orchestration |
| `SmartAgentBuilder` | `@mcp-abap-adt/llm-agent-libs` | Fluent builder: wires LLM + RAG + MCP + pipeline plugin into a `SmartAgent` |
| `CircuitBreaker` | `@mcp-abap-adt/llm-agent` | Generic open/half-open/closed circuit breaker; wraps any fallible operation |
| `FallbackRag` | `@mcp-abap-adt/llm-agent` | `IRag` decorator: falls back to secondary store on primary failure |
| `ISkillPluginHost` | `@mcp-abap-adt/llm-agent` | Contract for a host that downloads, ingests, and serves skill plugin sources at runtime |
| `ControllerSkillPipelineBuilder` | `@mcp-abap-adt/llm-agent-server-libs` | Fluent builder for embedding a controller pipeline into a consumer application |
| `buildAgent` | `@mcp-abap-adt/llm-agent-server-libs` | Async factory: composes and returns a fully-wired pipeline agent (no HTTP listen) |

## Triage

**Sweep command used** (binding excludes: node_modules, tests, dist/build, coverage, generated, vendor, *.d.ts):
```bash
find packages/*/src -name "*.ts" \
  ! -name "*.test.ts" ! -path "*/__tests__/*" \
  ! -name "*.d.ts" \
  ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/build/*" \
  ! -path "*/coverage/*" ! -path "*/generated/*" ! -path "*/vendor/*" \
  | xargs wc -l 2>/dev/null | awk '$1>500 && $2!="total"{print $1"\t"$2}' | sort -rn
```

**Priority ordering rationale:** Priority is ranked by a composite score — `lines × #responsibilities × √(blast_radius + 1) × componentFit_multiplier` — where `componentFit_multiplier` is 1.5 for a clean catalog map (known landing zone = low design uncertainty), 1.0 for partial fit, 0.7 for test/harness files. High blast amplifies value (more consumers benefit) and large line count proxies refactor effort. Priority 1 = highest composite score = do first. The Priority column is a strict descending sort of this score (every adjacent pair checked — no formula-vs-rank inversion remains): smart-server 117197 > agent 53434 > config 44496 > controller-handler 22651 > builder 19279 > tool-loop 7098 > qdrant-store 6525 > dag-coordinator 5393 > default-pipeline 4224 > client.ts 4056 > sap-core 3917 > testing/index 1901 > plan-analysis 713. `agent.ts` blast is `~16` (targeted `from '.*/agent\.js'` count for `llm-agent-libs`; a broad `agent.js` grep over-counts another package's own interfaces referencing a different `agent.js`) — it does not change agent.ts's rank-2 position.

**Blast radius** = count of non-test files that import the module directly (by `.js` path in ESM imports); self-imports excluded.

| File / lines | Responsibilities (count · names) | Principle violated | Split risk | Blast radius | Driver (why it grew) | Priority |
|---|---|---|---|---|---|---|
| `llm-agent-server-libs/src/smart-agent/smart-server.ts` · 3926 | 6 — HTTP request routing, worker/sub-agent lifecycle, session lifecycle, MCP client init, LLM/embedder factory, knowledge-backend construction | SRP: HTTP server, agent orchestration, session management, infra wiring in one god-class | high | 10 | Every new HTTP endpoint and server feature accumulated in the single class with no extraction discipline | 1 |
| `llm-agent-libs/src/agent.ts` · 2160 | 6 — LLM request orchestration (process/stream), tool selection + revectorization, session CRUD, history management + summarization, subprompt classification, health-check coordination | SRP: runtime execution, tool catalog, session state, history, classification are orthogonal concerns | high | ~16 | Every new agent capability landed in `SmartAgent` without extraction; highest fan-in in the codebase | 2 |
| `llm-agent-server-libs/src/smart-agent/config.ts` · 1648 | 6 — YAML loading + env-var resolution, LLM config normalization, coordinator/dispatch config resolution, stepper coordinator config parsing, finalizer building, config-template generation | SRP: loader, LLM resolver, pipeline resolvers, template generator are separate concerns | med | 8 | Each new pipeline type added its own parser inline; no per-pipeline config module discipline | 3 |
| `llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` · 2026 | 5 — controller execution loop (planner→executor→reviewer→finalizer), step-state board rendering, run-scoped artifact recall, tool-call normalization utilities, plan JSON parsing helpers | SRP: stage handler mixed with recall logic, JSON parsers, and board renderer | med | 4 | Controller grew stage-by-stage with recovery paths and helpers added inline; no extraction for utilities | 4 |
| `llm-agent-libs/src/builder.ts` · 1437 | 4 — `SmartAgentBuilder` fluent wiring (LLM + RAG + MCP → agent), `SmartAgentHandle` type definitions, retrieval-source construction, MCP/prompts config types | SRP: builder logic, handle/config type definitions, retrieval wiring are separable | med | 4 | Fluent builder accumulated all wiring logic and type definitions as features were added | 5 |
| `llm-agent-libs/src/pipeline/handlers/tool-loop.ts` · 1004 | 5 — tool-loop stage execution, streaming tool-call assembly, tool result processing + error mapping, external tool-call bridging, tool availability tracking | SRP: execution loop, streaming, error mapping, external bridge are distinct concerns | low | 1 | Single handler grew to absorb all tool-call mechanics including streaming and external bridge | 6 |
| `llm-agent-libs/src/skills/plugin-host/qdrant-store.ts` · 769 | 4 — Qdrant REST client + reader, Postgres catalog store, in-process catalog store, catalog generation lifecycle (upsert/sweep/carry-forward) | SRP: three storage backends + lifecycle management collocated | low | 1 | Multiple backends added to one file for convenience; no per-backend file discipline | 7 |
| `sap-aicore-llm/src/sap-core-ai-provider.ts` · 554 | 5 — SAP AI Core LLM provider (chat), SAP AI Core embedding provider, model-list retrieval, message format translation, HTTP client management | SRP: `ILlm` and `IEmbedder` are separate interfaces; provider mixes both plus client plumbing | low | 1 | SAP AI Core SDK exposes both LLM and embedding; both were implemented in one convenience class | 11 |
| `llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` · 536 | 3 — DAG step execution (topological sort + parallel dispatch), ancestor-context building, node output collection | SRP: mostly cohesive; ancestor-context helper is separable | low | 4 | DAG execution complexity grew organically; ancestor-context helper added inline | 8 |
| `llm-agent-libs/src/pipeline/default-pipeline.ts` · 542 | 3 — `DefaultPipeline` stage execution, session-registry resolution, stage + context construction | SRP: mild; session-registry resolution is separable from pipeline execution | low | 2 | Pipeline stage complexity grew as session handling was added directly | 9 |
| `llm-agent-libs/src/testing/index.ts` · 543 | 5 — mock LLM factories, mock RAG factories, mock MCP client, mock logging/tracing infra, mock session + deps builders | SRP: all test fixtures in one file (by design for convenience, not a production concern) | low | 0 | Test harness consolidated for ease of import; no production blast | 12 |
| `llm-agent-mcp/src/client.ts` · 507 | 4 — MCP connection lifecycle (connect/disconnect/retry), transport detection + setup (stdio/sse/stream-http/embedded), tool listing, tool calling (single + batch) | SRP: transport negotiation and tool operations are separable; otherwise cohesive | low | 3 | Natural growth of a single-class MCP client; just crossed the threshold | 10 |
| `llm-agent-server-libs/src/smart-agent/controller/plan-analysis.ts` · 509 | 2 — dev evaluation harness (live/stub LLM modes), plan-quality analysis runner | Wrong location: dev eval harness shipped in production source tree, not a library concern | low | 0 | Eval harness developed inline with the controller and never extracted to scripts/ | 13 |

## Blueprint: smart-server.ts

`packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (3926 lines). The
`SmartServer` class (decl `1000`, body to `3918`) is the god-object; ~20 free
functions already sit at module scope (`358`–`985`, `3919`) — these are *partial*
extractions that the blueprint completes by relocating them into named, reusable
modules and pulling the remaining cohesive class-method clusters out next to them.
This is the **template** the other four blueprints reuse: six subsections, every
responsibility in §1 carries a target in §3.

### 1. Responsibility map (jobs → method clusters / line ranges)

| # | Responsibility | Class methods (line ranges) | Already-extracted module helpers |
|---|---|---|---|
| **R1** | **HTTP request routing & response shaping** — normalize URL, CORS/OPTIONS, dispatch the route table (`/v1/models`, `/v1/embedding-models`, `/v1/usage`, `/v1/sessions`, `…/resume`, `DELETE …`, `/v1/config`, `/health`, `/v1/messages`, `/v1/chat/completions`), shape JSON/SSE responses | `_handle` `2903`–`3206` (the if/else route chain), `_handleAdapterRequest` `3207`–`3296`, `_handleChat` `3297`–`3737`, `_handleConfigUpdate` `3738`–`3918`, `_start` `1891`–`1972` (creates `http.Server`, binds `_handle`) | `jsonError` `364`, `jsonValidationError` `370`, `readBody` `385`, `writeNotReady` `985`, `mapStopReason` `358`, `CORS_HEADERS` |
| **R2** | **Server lifecycle / infra build (composition root)** — load config, register plugins/pipelines, build LLMs+RAG+MCP+sessions+health, mount adapters, install the config-reload file watcher, then listen | `constructor` `1127`–`1143`, `start` `1144`–`1177`, `_buildInfra` `1178`–`1833` (655-line core; config-reload watcher inline `1685`–`1796`), `_buildEmbeddedAgent` `1834`–`1877`, `_embeddedSessionParts` `1878`–`1890` | `buildAgent` `3919` (embeddable twin) |
| **R3** | **Session lifecycle handling** — per-request session acquire/identity/cookie, knowledge seed, start/end ledger, list/resume/delete | `_withSession` `2847`–`2902` | `buildSessionLifecycle` `704`, `seedSessionKnowledge` `775`, `recordSessionStart` `809`, `recordSessionEnd` `833`, `handleListSessions` `848`, `handleResumeSession` `860`, `handleDeleteSession` `877`, `resolveSubAgentRagRegistry` `670` |
| **R4** | **MCP client init / wiring** — connect clients from config, ownership-routed `tools/list`/`call` bridge, health/fail-loud, stepper `callMcp` | `callMcp` `2236`–`2243` | `connectMcpClientsFromConfig` `920`, `buildMcpBridge` `947` |
| **R5** | **LLM/embedder factory & role resolution** — build an `ILlm` from config, default-temperature variant, resolve per-role (main/helper/planner/classifier) with cache | `_makeLlm` `2172`–`2176`, `_makeLlmDefault` `2177`–`2191`, `resolveRoleLlm` `2192`–`2213` | — (`makeLlm`/`makeRag` consumed) |
| **R6** | **Worker/sub-agent lifecycle + pipeline & knowledge-backend composition** — build sub-agents, worker registry+cache, knowledge backend, tools-RAG handle, shared pipeline infra, server ctx, base builder, per-session agent | `buildSubAgent` `1973`–`2171`, `buildWorkerRegistry` `2435`–`2513`, `buildSessionAgent` `2809`–`2846`, `buildPipelineInstance` `2404`–`2420`, `buildSharedPipelineInfra` `2268`–`2297`, `buildServerCtx` `2555`–`2658`, `buildBaseBuilder` `2659`–`2808`, `partsToBaseInput` `2514`–`2554`, `knowledgeRagFor` `2214`–`2235`, `buildKnowledgeBackend` `2298`–`2313`, `buildToolsRagHandle` `2325`–`2403`, `_mintStepperId`/`_mintTurnId` `2244`–`2267`, `warn` `2421` | `resolveWorkerLlmSet` `567`, `drainWorkerCache` `536`, `backfillWorkerCacheFromHandle` `622` |

### 2. Seams (cut lines + shared state read/written across each cut)

Shared mutable fields (`1008`–`1115`) are the coupling currency; each seam lists the
state it touches. **Bold = field written by more than one cluster (a coupling cost the
extraction must convert into a constructor-injected dependency, not a captured `this`).**

| Cut | Methods on the producing side | Shared state read (R) / written (W) | Coupling note |
|---|---|---|---|
| **R5 LLM resolver** | `_makeLlm`/`_makeLlmDefault`/`resolveRoleLlm` | R/W `_mainLlm` `_helperLlm` `_classifierLlm`; R `_llmMap` `_pipelineFallback` `_mainTemp` | Cleanest cut: a closed set of 6 fields, written only here + once in `_buildInfra`. Inject as a `RoleLlmResolver` value object. |
| **R4 MCP wiring** | `callMcp`, `connectMcpClientsFromConfig`, `buildMcpBridge` | R/W **`_sharedMcpClients`** **`_stepperMcpClients`**; R `_mcpSeamInjected` `_deps.connectMcp` | `_sharedMcpClients` is harvested in `_buildInfra` (YAML path) AND set in `buildSharedPipelineInfra` (DI path) — two writers; the seam must expose it as an explicit handle returned by the wiring module. |
| **R6 workers/pipeline** | `buildSubAgent` `buildWorkerRegistry` `buildSessionAgent` `build*Infra/Ctx/Builder` | R/W **`_workerLlmCache`** `_stepperKnowledgeBackend` `_toolsRag` `_toolsRagHandle`; R `_resolvedEmbedder` `_mergedEmbedderFactories` `_stepperMcpClients` `_sharedMcpClients` `_skillHost` | Highest coupling: reads R4+R5+R2 state. `_workerLlmCache` written by `buildSubAgent`, `buildWorkerRegistry`, and drained by the reload watcher (R2) — three writers. Knowledge-backend + tools-RAG-handle are internally cohesive sub-seams that can leave first. |
| **R3 sessions** | `_withSession` + the 8 module helpers | R/W `_lifecycle` `_sessionMetaStore` `_sessionCloseFns` | Already ~80% extracted to free functions; `_withSession` is a thin facade over `_lifecycle`. Low coupling — depends on R6 only via the `buildAgent` callback passed into `buildSessionLifecycle`. |
| **R1 routing** | `_handle` + `_handleChat`/`_handleAdapterRequest`/`_handleConfigUpdate` + `_start` | Reads injected params only (`smartAgent`, `chat`, `streamChat`, `healthChecker`, `modelProvider`, `adapterMap`) — **no `_` fields** except via R3 `_withSession` | Best-isolated large cut: `_handle` already receives its dependencies as 10 arguments (`2903`–`2913`), so it has no hidden `this` state — it is a pure dispatcher waiting to become a route table. |
| **R2 composition root** | `start`/`_buildInfra`/`_buildEmbeddedAgent` | Writes ~all `_` fields; the config-reload watcher `1685`–`1796` reads/writes `cfg.agent`, drains `_workerLlmCache`, re-vectorizes RAG | The residual after R1/R3/R4/R5/R6 leave; `_buildInfra` shrinks to "instantiate the extracted collaborators and connect them". The reload watcher is itself a separable sub-seam. |

### 3. Decomposition target per responsibility (components-first)

For each responsibility: first checked the **Component catalog reference** above.

- **R1 HTTP routing → EXTRACT new module `HttpRouteTable` (+ `IRoute`/`RouteHandler`).**
  No catalog component does HTTP routing — `SmartServer` is the only HTTP surface, so
  there is nothing to reuse. Justified as a *real* component: a small, interface-bounded,
  reusable dispatcher (`{ method, match, handle }[]`) plus three focused handler
  objects (`ChatRouteHandler`, `AdapterRouteHandler`, `ConfigRouteHandler`) carved from
  `_handleChat`/`_handleAdapterRequest`/`_handleConfigUpdate`. `_handle` becomes a 20-line
  `routeTable.dispatch(req,res,ctx)`. Reuses existing `jsonError`/`writeNotReady` helpers
  for response shaping — not new glue.
- **R2 Composition root → REUSE `SmartAgentBuilder` + `buildAgent` + the pipeline
  factories** (`LinearFactory`/`DagFactory`/`CyclicFactory`/`ControllerFactory`) already
  in the catalog for the build itself; **EXTRACT one small `ConfigReloadWatcher`
  (interface-bounded, reusable)** for the inline `1685`–`1796` watcher — no catalog
  component owns hot-reload, and it is a clean `start/stop` strategy over
  `resolveSmartServerConfig`. The residual `SmartServer.start()` stays as a thin
  composition root that wires the extracted collaborators (the desired end-state under
  Principle 2).
- **R3 Session lifecycle → REUSE `ISessionManager`/`SessionManager`/`SessionGraph` +
  `IRequestLogger`** (catalog). The per-request orchestration is *already* extracted to
  module functions (`buildSessionLifecycle`, `handleListSessions/Resume/Delete`,
  `recordSessionStart/End`, `seedSessionKnowledge`); finish the job by relocating them +
  `_withSession` into a `session-lifecycle/` module that returns the existing
  `SessionLifecycle` facade. No new component — pure REUSE/relocate.
- **R4 MCP client init → REUSE `IMcpConnectionStrategy` + `makeConnectionStrategy` +
  `McpClientAdapter` + `IReadinessReporter`/`HealthChecker`** (catalog). The bespoke
  `connectMcpClientsFromConfig`/`buildMcpBridge`/`callMcp` should be expressed *through*
  `makeConnectionStrategy` (consumer-swappable per Principle 5) rather than ad-hoc
  connect loops. The only residual is the ownership-routing tools bridge — keep
  `buildMcpBridge` as a small `IToolsRagHandle`-shaped module (already interface-bounded),
  relocated into `llm-agent-mcp`. Mostly REUSE; no new god-fragment.
- **R5 LLM/embedder factory & role resolution → REUSE `makeLlm`/`makeDefaultLlm`/
  `resolveEmbedder`** for construction; **EXTRACT a tiny `RoleLlmResolver` (interface
  `IRoleLlmResolver { resolve(role): Promise<ILlm> }`).** The catalog has the *factories*
  but no *role resolver*; the role→LLM cache (`main/helper/planner/classifier`) is a
  cohesive 6-field cluster reused by both the server and worker builds, so it is a
  genuine small reusable component, not a fragment.
- **R6 Workers/pipeline/knowledge → REUSE `SmartAgentBuilder` + `buildAgent` + pipeline
  factories + the existing `KnowledgeBackend` impls** (`JsonlKnowledgeBackend`/
  `InMemoryKnowledgeBackend`/`makeKnowledgeSemanticIndex`) **+ `IToolsRagHandle`** for
  composition. **EXTRACT two small interface-bounded modules**: (a) `WorkerRegistry`
  (owns `_workerLlmCache` + `buildSubAgent`/`buildWorkerRegistry` + the already-extracted
  `resolveWorkerLlmSet`/`drainWorkerCache`/`backfillWorkerCacheFromHandle`), and
  (b) a one-call `makeKnowledgeBackend(cfg, embedder)` factory wrapping the 15-line
  selector at `2298`–`2313`. Both are reusable (workers + reload-drain consume the cache;
  any pipeline consumes the backend) and bounded — not arbitrary slices of the monster.

Every R1–R6 has a target. Net: 4 EXTRACT (all small + interface-bounded + reusable:
`HttpRouteTable`, `ConfigReloadWatcher`, `RoleLlmResolver`, `WorkerRegistry`) + 1 tiny
factory (`makeKnowledgeBackend`); everything else is REUSE/relocate onto catalog
components.

### 4. Behavior-preservation strategy

Behavior-preserving, public-API-stable refactor pinned by characterization tests.

**Public API that must stay byte-stable** (verified by `public-api.test.ts`):
the `SmartServer` class + `start()/SmartServerHandle`, the exported config interfaces
(`SmartServer*Config`), the module functions other packages import
(`connectMcpClientsFromConfig`, `buildMcpBridge`, `buildSessionLifecycle`,
`buildAgent`, `writeNotReady`, `resolveWorkerLlmSet`, …), and **every route's
method+path+status+JSON/SSE shape** (`/v1/models`, `/v1/embedding-models`, `/v1/usage`,
`/v1/sessions[/:id/resume]`, `/v1/config`, `/health`, `/v1/messages`,
`/v1/chat/completions`). Blast radius 10 → keep the barrel exports re-exporting from
the new module paths.

**Existing characterization tests to lean on:** `public-api.test.ts` (exports),
`smart-server-session-lifecycle.test.ts` + `sessions-endpoints.test.ts` +
`session-identity-resolver.test.ts` + `session-meta-store.test.ts` (R3),
`config-endpoints.test.ts` + `smart-server-config-reload.test.ts` (R1 config route +
R2 watcher), `smart-server-api-adapters.test.ts` (R1 adapters), `readiness-gate.test.ts`
(`/health`), `usage-per-session.test.ts` (`/v1/usage`), `worker-llm-cache.test.ts` +
`subagent-shared-rag.test.ts` (R6 workers), `mcp-bridge-failloud.test.ts` +
`mcp-single-connect.test.ts` + `mcp-yaml-vectorization.test.ts` +
`stepper-callmcp-bridge.test.ts` + `stepper-mcp-from-config.test.ts` (R4),
`llm-map-normalize.test.ts` (R5 map), `embedder-knowledge-index.test.ts` +
`jsonl-knowledge-backend.test.ts` (R6 knowledge backend).

**Tests to ADD before refactoring (gaps):**
1. A **route-table characterization test** covering the small infra routes still tested
   only indirectly — `GET /v1/models`, `GET /v1/embedding-models` (incl.
   `?exclude_embedding=true`), `OPTIONS` 204 + CORS headers, and the unknown-path 404 —
   asserting status + body shape. Pin BEFORE extracting `HttpRouteTable` (R1).
2. A **`RoleLlmResolver` test**: each role (`main`/`helper`/`planner`/`classifier`)
   returns the cached instance and falls back to `_mainLlm`/`_makeLlm(cfg)` exactly as
   `resolveRoleLlm` `2192`–`2213` does today. Pin BEFORE R5.

### 5. Suggested PR slices (ordered; first = lowest-risk / highest-value)

| # | Slice | Touches | Rough Δ | Risk | Why here |
|---|---|---|---|---|---|
| 1 | **`makeKnowledgeBackend` factory** — extract the `2298`–`2313` selector to a pure factory in a `knowledge/` module; `buildKnowledgeBackend` calls it | R6 (knowledge sub-seam) | −15 / +35 | **very low** | Pure, single field (`_stepperKnowledgeBackend`), covered by existing knowledge tests. Sets the EXTRACT pattern with near-zero blast. |
| 2 | **`RoleLlmResolver` value object** — move `_makeLlm`/`_makeLlmDefault`/`resolveRoleLlm` + the 6 LLM fields behind `IRoleLlmResolver`; server holds one instance | R5 | −45 / +90 | **low** | Closed field set, only other writer is one block in `_buildInfra`; new test (§4) pins it. Reused by R6 worker build → compounding value. |
| 3 | **`session-lifecycle/` relocation** — move the 8 already-extracted session funcs + `_withSession` into a module; barrel re-exports preserve imports | R3 | −120 / +130 (mostly moves) | **low** | Almost a file-move; pinned by 4 existing session tests + `public-api.test.ts`. |
| 4 | **`WorkerRegistry` module** — fold `_workerLlmCache` + `buildSubAgent`/`buildWorkerRegistry` + the 3 worker free-funcs behind an interface; reload watcher drains via the interface | R6 (worker sub-seam) | −210 / +230 | **medium** | Three writers of `_workerLlmCache` collapse to one owner; `worker-llm-cache.test.ts`/`subagent-shared-rag.test.ts` pin it. Do after R5 (it consumes the resolver). |
| 5 | **`HttpRouteTable` + route handlers** — extract `_handle` route chain + `_handleChat`/`_handleAdapterRequest`/`_handleConfigUpdate` into a table + 3 handler objects; `_handle` becomes `dispatch` | R1 | −900 / +620 | **medium-high** | Biggest line win and the headline Principle-6 fix, but highest blast (every route). Gate behind the new route-table characterization test (§4 #1) + all endpoint tests. `_handle` already takes deps as args → no hidden state to thread. |
| 6 | **`ConfigReloadWatcher` + slim composition root** — extract the `1685`–`1796` watcher; `_buildInfra` shrinks to wiring the extracted collaborators | R2 | −500 / +250 | **medium** | Last: depends on every prior extraction existing so `_buildInfra` has collaborators to instantiate. `smart-server-config-reload.test.ts` pins the watcher. |

Cumulative: `smart-server.ts` drops from 3926 toward ~1.4k (a thin composition root +
route dispatcher) with the rest landing in 5 small reusable modules — under the
Principle-6 threshold. **R4 MCP** is intentionally NOT its own slice here: the
`connectMcpClientsFromConfig`/`buildMcpBridge`/`callMcp` rework onto
`makeConnectionStrategy` rides into the R4-owning `llm-agent-mcp` audit (`client.ts`,
Priority 10) to avoid a cross-package double-touch; this blueprint records the target,
that plan executes it (one-monolith-per-plan).

### 6. Principle self-check

| # | Principle | Compliance of this decomposition |
|---|---|---|
| 1 | **Build ON existing components** | R2/R3/R4/R5/R6 lead with REUSE of `SmartAgentBuilder`, `buildAgent`, pipeline factories, `ISessionManager`, `makeLlm`/`makeRag`, `makeConnectionStrategy`, `HealthChecker`, `KnowledgeBackend` impls. The 4 EXTRACTs land in the **library**, not app-local glue, and become reusable components. ✅ |
| 2 | **The app IS the example** | End-state `SmartServer` is a thin composition root that *consumes* the components — the demonstration we want consumers to copy. The fix is reimplement-on-components, never carve-into-fragments. ✅ |
| 3 | **Everything around interfaces** | New cuts are interface-typed: `IRoute`/`RouteHandler`, `IRoleLlmResolver`, the `WorkerRegistry` interface, `IToolsRagHandle` (reused), `ConfigReloadWatcher` start/stop contract. Server depends on the interfaces, not the classes. ✅ |
| 4 | **Many small interfaces (ISP)** | Each EXTRACT gets its own focused interface; none widens an existing one. Readiness stays the separate `IReadinessReporter` (reused, not bolted onto a strategy). ✅ |
| 5 | **Consumer-owned variation = strategies** | MCP connect routed through swappable `IMcpConnectionStrategy` (`Lazy/Periodic/Noop`/custom); route handlers and `RoleLlmResolver` are injectable; reload watcher is a strategy with a no-op default. ✅ |
| 6 | **Control file size** | Primary objective: 3926 → ~1.4k residual + 5 small modules (target <500 each). Slices 1+5+6 carry the bulk of the reduction. ✅ |
| 7 | **Don't break components** | All changes additive + behavior-preserving: barrel re-exports keep `connectMcpClientsFromConfig`/`buildMcpBridge`/`buildSessionLifecycle`/`buildAgent`/… import paths stable; route method+path+status+shape unchanged; pinned by `public-api.test.ts` + endpoint characterization tests. ✅ |

