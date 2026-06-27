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

Cumulative: `smart-server.ts` drops from 3926 toward ~1.4k (the largest single-slice
reduction in the audit, though the residual remains above the 500-line target — see §6)
with the rest landing in 5 small reusable modules. **R4 MCP** is intentionally NOT its own slice here: the
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
| 6 | **Control file size** | Primary objective: 3926 → ~1.4k residual + 5 small modules (target <500 each). Slices 1+5+6 carry the bulk of the reduction. The ~1.4k residual does NOT reach the 500-line per-file target; the remaining size is the route-handling + composition root reduced as far as this audit pass scopes — further reduction is out of scope (one-monolith-per-plan). ✅ |
| 7 | **Don't break components** | All changes additive + behavior-preserving: barrel re-exports keep `connectMcpClientsFromConfig`/`buildMcpBridge`/`buildSessionLifecycle`/`buildAgent`/… import paths stable; route method+path+status+shape unchanged; pinned by `public-api.test.ts` + endpoint characterization tests. ✅ |

## Blueprint: agent.ts

`packages/llm-agent-libs/src/agent.ts` (2160 lines). The `SmartAgent` class (decl `232`,
body to `2160`) is the core god-object; two module-level helpers (`mergeSignals`,
`createTimeoutSignal`, `202`–`224`) are small and stay. The class has ~16 direct importers
across the monorepo — the highest fan-in in `llm-agent-libs`. All importers use
`SmartAgent`, `SmartAgentDeps`, `SmartAgentConfig`, `SmartAgentReconfigureOptions`,
`OrchestratorError`, or `SmartAgentRagStores`; these symbols must remain in `agent.ts` or
be barrel re-exported from it.

The key architectural insight: the **streaming tool loop** (`_runStreamingToolLoop`
`1244`–`2007`, ~764 lines) is nearly identical to `ToolLoopHandler`
(`pipeline/handlers/tool-loop.ts`, 1004 lines). Both already share `classifyToolResult`
and `fireInternalToolsAsync`. The blueprint converges them rather than extracting yet
another copy.

### 1. Responsibility map (jobs → method clusters / line ranges)

| # | Responsibility | Method cluster (line ranges) |
|---|---|---|
| **R1** | **Streaming tool loop** — per-iteration LLM call, streaming chunk assembly, external-tool index tracking, heartbeat (SSE), concurrent tool execution, tool availability filtering, blocked / hallucinated / external-call dispatch, mixed-call bridging, output validation, `streamMode` buffering, `onBeforeStream` hook, `classifyToolResult` escalation (fail-loud) | `_runStreamingToolLoop` `1244`–`2007` |
| **R2** | **RAG + context assembly orchestration** — history summarization gate, `classificationEnabled` branch, subprompt classification, per-store embedding (translated vs. original), reranking, tool RAG selection + enriched-tool-search, skill injection (RAG-driven + fallback query), context assembly via `IContextAssembler`, final tool merge + availability filter | `streamProcess` `817`–`1168` (the `smart`/`hard` branch), `_preparePipeline` `1178`–`1242`, `_toEnglishForRag` `2033`–`2053`, `_summarizeHistory` `2055`–`2097` |
| **R3** | **Pass-through mode** — `mode === 'pass'` transparent LLM proxy: stream chunks, strip intermediate usage, emit terminal usage summary; no tool loop, no RAG | `streamProcess` `717`–`801` (the `pass` branch) |
| **R4** | **Structured-pipeline delegation** — `deps.pipeline` path: adapts `IPipeline.execute` callback-push API into an async generator via a queue + `resolveWait` pattern; delegates all execution; propagates errors | `_runStructuredPipeline` `2099`–`2159` |
| **R5** | **Session + RAG store lifecycle** — `closeSession` (registry cleanup + history flush), `addRagStore` / `removeRagStore` (registry or direct-store path, `translateQueryStores` bookkeeping, `rebuildStages` signal) | `closeSession` `425`–`437`, `addRagStore` `368`–`399`, `removeRagStore` `405`–`418` |
| **R6** | **Config & LLM hot-swap** — `applyConfigUpdate`, `reconfigure` (swap main/helper/classifier LLM + `LlmClassifier` rebuild + pipeline propagation via `deps.pipeline.reconfigure`), `getActiveConfig`, `getAgentConfig` | `applyConfigUpdate` `313`–`315`, `reconfigure` `334`–`358`, `getActiveConfig` `440`–`450`, `getAgentConfig` `453`–`471` |
| **R7** | **Health-check coordination** — `healthCheck` probes LLM (`.healthCheck` or `chat('ping')` fallback), RAG (first store), and each MCP client; merges abort signals + timeout; `isReady` delegates to `connectionStrategy` | `healthCheck` `484`–`579`, `isReady` `479`–`482` |
| **R8** | **MCP tool listing + connection resolution** — `_listAllTools` (resolves active clients via strategy, parallel `listTools`, de-dups name-first-wins), `_resolveActiveClients` (connectionStrategy.resolve + conditional revectorize on `toolsChanged`), `_revectorizeTools` (upserts tool text into the tools RAG store) | `_listAllTools` `2008`–`2031`, `_resolveActiveClients` `283`–`293`, `_revectorizeTools` `295`–`310` |

### 2. Seams (cut lines + shared state read/written across each cut)

Mutable class fields (declared `233`–`248`) are the coupling currency. Request-scoped
state (`toolClientMap`, per-iteration locals) lives on the stack and does NOT leak across
seams.

| Cut | Methods on the producing side | Shared state read (R) / written (W) | Coupling note |
|---|---|---|---|
| **R8 MCP tool listing** | `_listAllTools`, `_resolveActiveClients`, `_revectorizeTools` | R/W **`_activeClients`**; R `deps.connectionStrategy` `deps.ragStores.tools` | `_activeClients` written here and read by R7 healthCheck and R1 (indirectly via `_listAllTools`). Cleanest first cut: a closed 3-method cluster producing `{ tools, toolClientMap }` as a value object. |
| **R7 Health-check** | `healthCheck`, `isReady` | R `_mainLlm` `_activeClients`; R `deps.ragStores` `deps.connectionStrategy` | Reads R6's `_mainLlm` and R8's `_activeClients`. The logic mirrors `HealthChecker`; seam is natural once R8 exposes `_activeClients` via interface. |
| **R3 Pass-through** | `streamProcess` lines `717`–`801` | R `_mainLlm`; R `requestLogger` | Only two deps; already a self-contained block. No fields written. Easiest isolated cut. |
| **R4 Pipeline adapter** | `_runStructuredPipeline` | R `deps.pipeline` only | Zero field deps; already a private method with a clean parameter surface. |
| **R2 RAG orchestration** | `streamProcess` `817`–`1168`, `_preparePipeline`, `_toEnglishForRag`, `_summarizeHistory` | R `_mainLlm` `_helperLlm` `_classifier` `_classifierLlm`; R `deps.*` (ragStores, embedder, assembler, reranker, queryExpander, skillManager, translateQueryStores, connectionStrategy) | Reads R6 LLM fields and R8 tool listing. Must run after R8 extraction so `_listAllTools` is already behind `IMcpToolRegistry`. R2 produces `{ retrieved, finalTools, skillContent, assembledMessages }` passed to R1. |
| **R1 Streaming tool loop** | `_runStreamingToolLoop` | R `_mainLlm` `config`; R `toolCache` `toolAvailabilityRegistry` `pendingToolResults` `metrics` `tracer` `outputValidator` `requestLogger` `sessionManager`; R `defaultLlmCallStrategy` | The largest cluster. All deps are constructor-injected (no `_activeClients` mutation here — `toolClientMap` is a parameter). This is the convergence target: the class-field deps become explicit constructor params of the extracted `runToolLoop` function. |
| **R5 / R6 (residual)** | `closeSession`, `addRagStore`, `removeRagStore`, `reconfigure`, `applyConfigUpdate`, `getActiveConfig`, `getAgentConfig` | R/W `_mainLlm` `_helperLlm` `_classifierLlm` `_classifier` `config`; R `deps.ragRegistry` `deps.historyMemory` `deps.pipeline` | The residual public API after all extractions. These 8 methods are already slim facades (≤20 lines each); they stay in `SmartAgent`. |

### 3. Decomposition target per responsibility (components-first)

For each responsibility: the **Component catalog reference** was checked first.

- **R1 Streaming tool loop → CONVERGE onto `ToolLoopHandler` (REUSE).**
  `ToolLoopHandler` (`pipeline/handlers/tool-loop.ts`) is the same algorithm. Both already
  share `classifyToolResult` (`escalate-if-unavailable.ts`) and `fireInternalToolsAsync`.
  The heartbeat race, external-tool forwarding, blocked/hallucination handling, and tool
  cache patterns are duplicated. No new component: extract the shared body into a single
  free async generator function `runToolLoop(deps, config, loopInput)` in
  `agent/run-tool-loop.ts`. `ToolLoopHandler.execute` delegates to it; `SmartAgent`'s
  `_runStreamingToolLoop` becomes a one-call wrapper. Net: one authoritative loop, two thin
  entry points. Blast-radius: `ToolLoopHandler` has blast 1 (no external importers); the
  convergence is additive to agent.ts's public API.

- **R2 RAG + context assembly → EXTRACT `RagOrchestrator` (REUSE + bounded EXTRACT).**
  No catalog component owns "per-request RAG fan-out + rerank + tool-skill selection +
  assembly". The sub-components it delegates to are all catalog: `IContextAssembler`
  (reused), `IReranker` (reused), `IQueryExpander` (reused), `IRag` stores (reused). Gap:
  the *coordination* logic. EXTRACT a minimal `IRagOrchestrator` interface +
  `RagOrchestrator` class in `agent/rag-orchestrator.ts` with one entry
  `orchestrate(query, opts) → Promise<OrchestratedContext>`. The two helpers
  (`_toEnglishForRag`, `_summarizeHistory`) become module-scope functions injected as
  optional strategies. Reusable by any host needing the same RAG-then-assemble pattern.

- **R3 Pass-through mode → REUSE `IStageHandler` contract (EXTRACT `PassThroughHandler`).**
  The `pass` branch is a focused, testable unit with two deps (`_mainLlm`,
  `requestLogger`). Express it as a standalone async generator function
  `runPassThrough(llm, requestLogger, messages, opts)` in `pipeline/handlers/pass-through.ts`
  — reusing the `IStageHandler`-shaped pattern without the interface overhead (it is not
  plugged into a stage registry). `streamProcess` delegates to it.

- **R4 Structured-pipeline delegation → EXTRACT `pipelineToStream` free function (REUSE `IPipeline`).**
  `_runStructuredPipeline` (60 lines) is a reusable adapter: converts `IPipeline.execute`'s
  callback-push API into an async generator. Extract as
  `pipelineToStream(pipeline, input, opts): AsyncIterable<…>` in
  `pipeline/pipeline-to-stream.ts`. REUSE `IPipeline` (catalog). Zero new interface.
  Reusable by any consumer that hosts an `IPipeline`.

- **R5 Session + RAG store lifecycle → REUSE `ISessionManager` + `IRagRegistry` (no extraction).**
  `closeSession`, `addRagStore`, `removeRagStore` are already thin delegating facades over
  catalog interfaces. No extraction needed — they stay as the correct public API boundary.
  The test is that each is ≤20 lines and contains no business logic.

- **R6 Config + LLM hot-swap → REUSE pattern (keep slim, no extraction).**
  `reconfigure`/`applyConfigUpdate` are 20 lines combined; they propagate to `deps.pipeline`
  (REUSE). No extraction warranted — they are already the right abstraction.

- **R7 Health-check coordination → REUSE `HealthChecker` (catalog).**
  `healthCheck` (96 lines) reinvents what `HealthChecker` does: aggregate per-component
  health results. Rework: `SmartAgent.healthCheck` instantiates an ad-hoc `HealthChecker`
  (or calls a `buildAgentHealthChecker(llm, ragStores, mcpClients)` factory function in
  `health/agent-health.ts`) and delegates to it. REUSE `IReadinessReporter` + `HealthChecker`
  (catalog). `isReady()` already delegates correctly (no change).

- **R8 MCP tool listing + connection → EXTRACT `McpToolRegistry` (interface-bounded, REUSE `IMcpConnectionStrategy`).**
  `_listAllTools`, `_resolveActiveClients`, `_revectorizeTools` form a cohesive 51-line
  cluster. REUSE `IMcpConnectionStrategy` (catalog) for the connection resolution.
  EXTRACT `IMcpToolRegistry { resolve(opts): Promise<ToolRegistryResult> }` +
  `McpToolRegistry` in `mcp/tool-registry.ts`. Reusable: any agent or pipeline stage
  needing tool-discovery can consume it. `SmartAgent` holds one instance (constructor-
  injected), eliminating `_activeClients` as a mutable class field.

Every R1–R8 has a catalog REUSE or a named, interface-bounded EXTRACT target.
Net: **5 EXTRACTs** (all small + reusable: `runToolLoop` convergence function,
`RagOrchestrator`, `PassThroughHandler` function, `pipelineToStream`, `McpToolRegistry`)
+ **2 REUSE-only** (`HealthChecker` delegation for R7; R5/R6 already-slim facades).

### 4. Behavior-preservation strategy

Behavior-preserving, public-API-stable refactor pinned by characterization tests.

**Public API that must stay byte-stable** (verified by export contract):
- `SmartAgent` class (all public methods: `process`, `streamProcess`, `healthCheck`,
  `isReady`, `reconfigure`, `applyConfigUpdate`, `addRagStore`, `removeRagStore`,
  `closeSession`, `getActiveConfig`, `getAgentConfig`, `currentMainLlm` getter)
- `SmartAgentDeps`, `SmartAgentConfig`, `SmartAgentReconfigureOptions`, `SmartAgentRagStores`
- `OrchestratorError`, `AgentCallOptions`, `SmartAgentResponse`, `StopReason`
  (re-exported from `@mcp-abap-adt/llm-agent`)

Blast radius ~16 → all importers keep their import paths stable. If `OrchestratorError`
eventually migrates to `@mcp-abap-adt/llm-agent` (contracts package), add a barrel
re-export in `agent.ts` to preserve import paths (Principle 7).

**Existing characterization tests to lean on:**
- `streaming.test.ts` (R1 main path)
- `heartbeat.test.ts` (R1 heartbeat)
- `agent-mcp-unavailable-escalates.test.ts` (R1 fail-loud via `classifyToolResult`)
- `parallel-mixed-tool-calls.test.ts` (R1 mixed-call bridge)
- `tool-reselection.test.ts` (R2 per-iteration reselect)
- `builder-tool-selection.test.ts` (R2 tool RAG selection)
- `smart-agent-custom-rag.test.ts` (R2 multi-store RAG)
- `pass-usage.test.ts` (R3 pass-through usage)
- `agent-readiness.test.ts` (R7 isReady + healthCheck)
- `mcp-reconnection.test.ts`, `mcp-clients-di.test.ts` (R8 connection resolution)
- `reconfigure.test.ts`, `handle-hotswap.test.ts` (R6)
- `smart-agent-close-session.test.ts` (R5)

**Tests to ADD before refactoring (gaps):**
1. A **`runToolLoop` parity test**: drive both `_runStreamingToolLoop` (agent path) and
   `ToolLoopHandler` with identical inputs; assert identical chunk sequences. Pin BEFORE
   the R1 convergence (Slice 6).
2. A **`_toEnglishForRag` + enriched-tool-search characterization test**: verify the
   translate-then-embed + two-phase RAG path in isolation. Pin BEFORE extracting
   `RagOrchestrator` (Slice 5).

### 5. Suggested PR slices (ordered; first = lowest-risk / highest-value)

| # | Slice | Touches | Rough Δ | Risk | Why here |
|---|---|---|---|---|---|
| 1 | **`pipelineToStream` free function** — extract `_runStructuredPipeline` `2099`–`2159` into `pipeline/pipeline-to-stream.ts`; `SmartAgent` calls it | R4 | −60 / +75 | **very low** | Zero field deps, no public API change, zero blast. Pure adapter pattern. Sets extraction habit. |
| 2 | **`McpToolRegistry` module** — extract `_listAllTools`/`_resolveActiveClients`/`_revectorizeTools` behind `IMcpToolRegistry`; `SmartAgent` holds an instance | R8 | −51 / +120 | **low** | Closed 3-method cluster, removes `_activeClients` mutable field. Pinned by `mcp-reconnection.test.ts`, `mcp-clients-di.test.ts`. Enables R7 (health uses same client list). |
| 3 | **`PassThroughHandler` function** — extract `pass` branch `717`–`801` into `pipeline/handlers/pass-through.ts`; `streamProcess` delegates | R3 | −84 / +95 | **low** | Self-contained 80-line block, pinned by `pass-usage.test.ts`. No new interface needed. |
| 4 | **`HealthChecker` delegation** — rework `healthCheck` to compose `HealthChecker` (catalog); add `buildAgentHealthChecker` factory | R7 | −70 / +50 | **low-med** | Pinned by `agent-readiness.test.ts`. `healthCheck` public signature unchanged. Depends on Slice 2 (client list). |
| 5 | **`RagOrchestrator` + helpers** — extract `_toEnglishForRag`, `_summarizeHistory`, RAG fan-out block, context assembly coordination into `agent/rag-orchestrator.ts` | R2 | −350 / +280 | **medium** | Largest extraction; pinned by `smart-agent-custom-rag.test.ts`, `tool-reselection.test.ts`, `builder-tool-selection.test.ts`. New gap test (§4 #2) must gate this. Depends on Slice 2 (McpToolRegistry) for the `_listAllTools` call inside `_preparePipeline`. |
| 6 | **`runToolLoop` convergence** — extract `_runStreamingToolLoop` body into `agent/run-tool-loop.ts`; `ToolLoopHandler` delegates to same function; delete duplicate code in tool-loop.ts | R1 | −760 / +420 | **medium** | Biggest Δ, touches two files simultaneously. New parity test (§4 #1) must gate this. All R1 characterization tests pin it. Last because it depends on all prior extractions (McpToolRegistry for toolClientMap seam, all dependencies explicit). |

Cumulative: `agent.ts` drops from 2160 toward ~900 lines; `ToolLoopHandler` drops from
1004 toward ~300 lines (the shared loop body lives in `run-tool-loop.ts`). The residual
`SmartAgent` is the public API façade + thin orchestrator calling the extracted components
— the desired Principle-2 end-state.

### 6. Principle self-check

| # | Principle | Compliance of this decomposition |
|---|---|---|
| 1 | **Build ON existing components** | R1: CONVERGE onto `ToolLoopHandler` / shared `runToolLoop` (REUSE, not new); R2: REUSE `IContextAssembler`, `IReranker`, `IQueryExpander`; R3: REUSE `IStageHandler` pattern; R4: REUSE `IPipeline` contract; R7: REUSE `HealthChecker`; R8: REUSE `IMcpConnectionStrategy`. All 5 EXTRACTs land in the library as reusable components, not app-local glue. ✅ |
| 2 | **The app IS the example** | Post-refactor `SmartAgent` is a thin orchestrator that *consumes* `McpToolRegistry`, `RagOrchestrator`, `runToolLoop`, `pipelineToStream`, and `HealthChecker` — the demonstration consumers should copy when building their own agent host. ✅ |
| 3 | **Everything around interfaces** | New cuts: `IRagOrchestrator`, `IMcpToolRegistry`. `IStageHandler`/`IPipeline`/`IContextAssembler`/`IMcpConnectionStrategy`/`HealthChecker` (all reused). `SmartAgent` depends on interfaces, not classes. ✅ |
| 4 | **Many small interfaces (ISP)** | Each EXTRACT gets one focused interface. `IReadinessReporter` stays separate (already correct — `isReady` delegates without widening the interface). ✅ |
| 5 | **Consumer-owned variation = strategies** | Connection strategy stays `IMcpConnectionStrategy` (catalog, swappable). `RagOrchestrator` helpers (`_toEnglishForRag`, `_summarizeHistory`) become injectable functions. `PassThroughHandler` and `pipelineToStream` are standalone, replaceable. ✅ |
| 6 | **Control file size** | Primary objective: `agent.ts` 2160 → ~900; `ToolLoopHandler` 1004 → ~300. No extracted module exceeds ~450 lines; the largest, `run-tool-loop.ts` at ~420, stays well under the 500-line target. ✅ |
| 7 | **Don't break components** | All 16+ importers of `agent.ts` import only `SmartAgent`, `SmartAgentDeps/Config/ReconfigureOptions`, `OrchestratorError`, `SmartAgentRagStores` — all stay in `agent.ts` or barrel re-exported. Public method signatures unchanged. Pinned by existing test suite. ✅ |

## Blueprint: controller-coordinator-handler.ts

`packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`
(2026 lines). The `ControllerCoordinatorHandler` class (decl `214`, body to `1577`) is the
primary target; ~450 lines of module-scope helpers sit below the class (`1578`–`2026`) — partial
extractions that belong in sibling modules but never landed there. The existing controller
component family (`board.ts`, `artifacts.ts`, `planner.ts`, `reviewer.ts`, `types.ts`,
`run-scope.ts`, `session-bundle.ts`, `subagent-client.ts`) is the landing zone: the blueprint
maps each responsibility onto that family via REUSE or move-to-sibling, not new parallel modules.

A key structural defect: `planner.ts` and `reviewer.ts` currently import `extractJsonObject`
FROM this handler — an inverted dependency that makes the handler the provider for its own
siblings. The blueprint fixes that as its first slice.

### 1. Responsibility map (jobs → method clusters / line ranges)

| # | Responsibility | Methods (line ranges) | Module-scope helpers |
|---|---|---|---|
| **R1** | **Controller execution loop** — classify/resume/fresh run routing (three-stage recovery), evaluator goal-establishment, planner main loop (plan-parse, rewind, done→finalize, next→runStep), step-state reconciliation; `runStep` inner loop (episodic recall, per-step tool select, executor dispatch, reviewer gate, tool-routing, external-tool suspend/resume, settle); crash-guard budgets; escalation + terminal surface | `execute()` `217`–`876`; `runStep()` `887`–`1335`; `escalate()` `1339`–`1350`; `abortTerminal()` `1355`–`1378`; `finalize()` `1380`–`1507`; `commitTerminalSuccess()` `1511`–`1534`; `surfaceClarify()` `1536`–`1549`; `surfaceFinal()` `1551`–`1560`; `surfaceToolCall()` `1562`–`1576` | `mapOutcome()` `1826`–`1832`; `recordStepControl()` `1834`–`1852`; `synthMeta()` `1808`–`1822`; `isAffirmation()` `1606`–`1612`; `EXECUTOR_SYSTEM`; `TOOL_SELECT_K` |
| **R2** | **Step-state board rendering** — reconstruct + render the live step-state board from RAG artifacts before each planner call | `renderLiveBoard()` `1786`–`1806` | board budget constants (`maxDigestChars`/`maxIntentChars`/`maxActiveSteps`/`maxBoardChars`/`keepRecentDigests`) set in `execute()` `583`–`590`; `BoardOverBudgetError` branch `706`–`715` |
| **R3** | **Run-scoped artifact recall** — embedding-based deduped recall over the session's knowledge backend; relevant-extract (windowed cosine scoring); approved-results collection for the finalizer; recall-block text building | `runScopedRecall()` `1895`–`1941`; `relevantExtract()` `1995`–`2026`; `collectApproved()` `1857`–`1884`; `buildRecallBlock()` `1650`–`1669`; `rankStatus()` `1944`–`1952`; `isBetterStep()` `1954`–`1971`; `isBetterMcp()` `1976`–`1981`; recall constants `1634`–`1642` |
| **R4** | **Tool-call normalization** — coerce a `StreamToolCall` (full or delta) into a canonical `LlmToolCall` for external-tool surfacing | `toLlmToolCall()` `1754`–`1782` (module-scope, used only inside `runStep`) |
| **R5** | **Plan JSON parsing helpers** — parse the planner's reply into a typed `NextStep`; extract the first balanced JSON object from prose/fenced text | `parseNextStep()` `1686`–`1722`; `extractJsonObject()` `1727`–`1751` — **currently imported by `planner.ts` and `reviewer.ts` from this handler (inverted dependency)** |
| **R-util** | **Token-usage logging utility** — build the per-request `logUsage(role, usage)` closure that writes every subagent call into `IRequestLogger` with role-to-model attribution | `makeLogUsage()` `79`–`113` (exported; called once in `execute()`; no external production importer — only the TEST `usage-logging.test.ts`) |

### 2. Seams (cut lines + shared state read/written across each cut)

The class has a single constructor field (`private readonly deps: ControllerHandlerDeps`) — no
mutable class-level state. All coupling flows through the `deps` object (injected) and the
`SessionBundle` (persisted to `KnowledgeBackend`). Module-scope helpers are already decoupled by
parameter surface. Seams are therefore import-level, not field-level.

| Cut | Producing side | Shared state / import dependency | Coupling note |
|---|---|---|---|
| **R5 JSON parser seam** | `parseNextStep`, `extractJsonObject` | Imported BY `planner.ts` (`extractJsonObject`) AND `reviewer.ts` (`extractJsonObject`) from the handler — inverted direction | The handler is the bottom of the controller dependency graph; siblings importing FROM it block future handler imports of planner/reviewer helpers. Move-to-sibling `parser.ts` reverses the direction without changing any signature. |
| **R2 board rendering seam** | `renderLiveBoard` | Reads `rag`, `bundle`, `boardBudget`; delegates entirely to `board.ts` (`readPlanDecisions`, `readClaims`, `rag.list`, `reconstructBoard`, `renderBoard`) — ZERO handler-specific logic | Pure glue function: 20 lines that belong in `board.ts` next to the components it calls. The call site in `execute()` `706` already imports those same board symbols. |
| **R3 recall seam** | `runScopedRecall`, `relevantExtract`, `collectApproved`, `buildRecallBlock`, `rankStatus`, `isBetterStep`, `isBetterMcp` | Reads `rag` (param) + `bundle.runId`/`writeOrdinal` (passed as params); `relevantExtract` imports `cosine` from `../embedder-knowledge-index.js` | Already a self-contained cluster. `run-scoped-recall.test.ts` tests `runScopedRecall` and `relevantExtract` in isolation — the test knows these belong in their own module. |
| **R-util usage-logging seam** | `makeLogUsage` | Reads `IRequestLogger`, `requestId`, `models` map — no class state | Already tested in `usage-logging.test.ts`; no external production importer (called once in `execute()`). A standalone utility masquerading as part of the handler. |
| **R4 tool-call normalizer seam** | `toLlmToolCall` | Used ONLY inside `runStep` at one call site; no external importers | Trivial inline candidate: move the body adjacent to its single call site in `runStep` and delete the module-scope function. Alternatively move to `types.ts` alongside `LlmToolCall`. |
| **R1 execution loop (residual)** | All class methods | Reads `this.deps` (injected); writes `SessionBundle` via `persistBundle` (called through `deps.backend`); consumes R2–R5 helpers as module-scope calls | After R2–R5 move out, the handler is the pure execution loop consuming its neighbors — the correct architecture. |

### 3. Decomposition target per responsibility (components-first)

For each responsibility the **Component catalog reference** was checked first; then the existing
controller sibling family.

- **R5 Plan JSON parsing → MOVE to new sibling `controller/parser.ts` (FIX inverted dependency).**
  No catalog component owns JSON parsing; `types.ts` already owns `NextStep`/`Step` shapes.
  Introducing a tiny `parser.ts` next to `types.ts` is the minimum seam: it owns
  `parseNextStep` + `extractJsonObject`. `planner.ts` and `reviewer.ts` re-point their
  `extractJsonObject` imports to `./parser.js` (the only PRODUCTION consumers of either symbol
  outside the handler); the handler barrel re-exports both as a no-cost safety net for the TEST
  import paths (`parseNextStep` is consumed only by `controller-coordinator-handler.test.ts`).
  The inverted dependency is eliminated — the handler is no longer required by its own sibling.
  No interface overhead needed (pure functions, no state).

- **R2 Board rendering → MOVE `renderLiveBoard` into existing sibling `controller/board.ts`
  (REUSE + relocate).**
  `board.ts` already owns `reconstructBoard`, `renderBoard`, `BoardBudget`, `BoardOverBudgetError`
  — every component `renderLiveBoard` delegates to. The function is a 20-line glue with zero
  handler-specific logic; it belongs in the module it exclusively delegates to. Move: add
  `renderLiveBoard` to `board.ts`; the call site in `execute()` adds one import. The board
  budget constants stay in `execute()` (they are run-config values, not board logic). Net: zero
  new modules; pure REUSE/relocate onto an existing controller sibling.

- **R3 Run-scoped artifact recall → MOVE to new sibling `controller/recall.ts` (catalog +
  relocate).**
  The recall cluster (`runScopedRecall`, `relevantExtract`, `collectApproved`, `buildRecallBlock`,
  `rankStatus`, `isBetterStep`, `isBetterMcp`) is self-contained, already has a dedicated test
  file (`run-scoped-recall.test.ts`), and has no dependencies on the class or on any other
  handler helper. REUSE `IKnowledgeRagHandle` (catalog, already the parameter type) and
  `IEmbedder` (catalog) as the interface boundary. The new `recall.ts` exports
  `runScopedRecall` and `relevantExtract` (the two that are tested directly in
  `run-scoped-recall.test.ts`; neither has a production importer outside the handler). The
  handler re-exports both from `recall.ts` as a no-cost safety net for the test import path.
  No new interface needed — the functions ARE the interface.

- **R-util Usage logging → MOVE to new sibling `controller/usage-logging.ts` (REUSE
  `IRequestLogger` + relocate).**
  `makeLogUsage` is already tested in isolation (`usage-logging.test.ts`), is exported, and
  is called once inside `execute()` (no external production importer) — it has no coupling to
  the handler's execution logic. REUSE `IRequestLogger` (catalog) as the interface boundary. Move: create
  `usage-logging.ts` in the controller directory; handler re-exports `makeLogUsage` from it.
  Net: zero new interfaces; pure REUSE/relocate.

- **R4 Tool-call normalization → INLINE into `runStep` (trivial; zero new module).**
  `toLlmToolCall` is 28 lines, has zero external importers, and is called at exactly one site
  inside `runStep` (`1207`). The correct move is to inline it — eliminate the module-scope
  function and expand the call site. No extraction needed. Alternatively it can move to
  `types.ts` alongside `LlmToolCall`/`StreamToolCall` if the co-location is preferred, but
  no catalog component or new interface is needed either way.

- **R1 Controller execution loop → RESIDUAL in handler (primary job; no extraction).**
  After R2–R5 leave, the handler retains its core identity: `execute()` + `runStep()` + the
  private terminal-state methods (`escalate`, `abortTerminal`, `finalize`, `commitTerminalSuccess`,
  `surface*`). These share the `SessionBundle` write pattern, the `deps` injection, and the
  budget-guard logic — they are a cohesive atomic unit. The residual also keeps `mapOutcome`,
  `recordStepControl`, `synthMeta`, `isAffirmation`, `EXECUTOR_SYSTEM`, `TOOL_SELECT_K` which
  are tightly bound to execution semantics and have no external consumers. Net: handler drops
  from 2026 to ~1350 lines — a material reduction toward the Principle-6 threshold, with the
  residual remaining a single-responsibility loop.

Every R1–R5 + R-util has a target. Net: **4 new sibling modules** (`parser.ts`, `recall.ts`,
`usage-logging.ts`, and `renderLiveBoard` moves into `board.ts`) + **1 inline** (`toLlmToolCall`);
everything is REUSE/relocate onto the existing controller sibling family — no invented parallel
modules.

### 4. Behavior-preservation strategy

Behavior-preserving, public-API-stable refactor pinned by characterization tests.

**Public API that must stay byte-stable** (every "imported by" claim below grep-verified;
production blast radius = exactly 2 files that import a SYMBOL needing re-export: `planner.ts`
and `reviewer.ts`, both for `extractJsonObject`):
- `ControllerCoordinatorHandler` class + `execute()` signature (production importers:
  `controller-factory.ts`, `pipelines/controller.ts` — the latter re-exports it; also
  `factories/__tests__/controller-factory.test.ts`). NOT a moved symbol — stays in the handler.
- `ControllerHandlerDeps` interface (production importers: `controller-factory.ts`,
  `pipelines/controller.ts` re-export; tests: `controller-factory.skills.test.ts`,
  `__tests__/usage-e2e.test.ts`). NOT a moved symbol — stays in the handler.
- `TerminalUsage` type — no external importer; stays in the handler.
- `makeLogUsage` function — **NO external production importer** (`pipelines/controller.ts`
  re-exports only `ControllerCoordinatorHandler` + `ControllerHandlerDeps`). Sole importer
  outside the handler is the TEST `usage-logging.test.ts`; in production it is called once
  inside `execute()`. The re-export after the move is a no-cost safety net for the TEST path.
- `parseNextStep` function — **ZERO importers outside the handler in production**; sole importer
  is the TEST `controller-coordinator-handler.test.ts`. The Slice-1 re-export is a no-cost
  safety net for that test path, not driven by any external production importer.
- `extractJsonObject` function — **the only genuinely externally-consumed moved symbol**:
  imported in PRODUCTION by `planner.ts` and `reviewer.ts` (verified). These two update their
  import to `./parser.js` in Slice 1.
- `runScopedRecall` function — no production importer outside the handler; tested in
  `run-scoped-recall.test.ts`. Re-export = no-cost safety net for the test path.
- `relevantExtract` function — no production importer outside the handler; tested in
  `run-scoped-recall.test.ts`. Re-export = no-cost safety net for the test path.

All moved symbols are barrel re-exported from `controller-coordinator-handler.ts` until the
next major version, so every importer (production AND test) keeps its import path without change.
`planner.ts` and `reviewer.ts` MUST be updated to import `extractJsonObject` from `./parser.js`
(not re-exporting FROM handler to handler's own siblings would be circular).

**Existing characterization tests to lean on:**
- `controller-coordinator-handler.test.ts` (R1 execution loop, full integration)
- `round-trip.test.ts` (R1 suspend/resume, external-tool round-trip)
- `run-scoped-recall.test.ts` (R3 recall + extract)
- `board.test.ts` (R2 board rendering, already tests `reconstructBoard`/`renderBoard`)
- `usage-logging.test.ts` (R-util `makeLogUsage`)
- `planner.test.ts`, `planner.skills.test.ts` (planner side; exercises `extractJsonObject` indirectly via `parseNextStep`)
- `reviewer.test.ts` (exercises `extractJsonObject` via reviewer JSON parsing)
- `usage-e2e.test.ts` (R1 end-to-end with usage accounting)
- `select-tools-options.test.ts` (R1 per-step tool selection)

**Tests to ADD before refactoring (gaps):**
1. A **`parseNextStep` characterization test** covering valid `done`/`next`/`rewind` shapes,
   JSON-fenced input, and invalid/partial JSON. Pin BEFORE moving to `parser.ts` (Slice 1).
   `controller-coordinator-handler.test.ts` already unit-tests `parseNextStep` for the
   `validateRequires` boundary (lines `2283`+) but not the full shape matrix — broaden it.
2. A **`renderLiveBoard` unit test** asserting the glue delegates correctly to
   `reconstructBoard`+`renderBoard` and returns `''` on absent `runId`. Pin BEFORE moving
   to `board.ts` (Slice 2). `board.test.ts` covers the components but not the glue entry.

### 5. Suggested PR slices (ordered; first = lowest-risk / highest-value)

| # | Slice | Touches | Rough Δ | Risk | Why here |
|---|---|---|---|---|---|
| 1 | **`parser.ts` — move `parseNextStep`+`extractJsonObject`** — create `controller/parser.ts`; update `planner.ts` and `reviewer.ts` import paths; handler re-exports both | R5 | −70 / +80 | **very low** | Fixes the inverted dependency. Only 2 sibling files update their import path (`planner.ts` → `./parser.js`; `reviewer.ts` → `./parser.js`). External importers of the handler keep their paths via re-export. Gate with new `parseNextStep` characterization test (§4 #1). |
| 2 | **`renderLiveBoard` → `board.ts`** — move the 20-line function into `board.ts`; add one import in the handler | R2 | −20 / +25 | **very low** | Zero external importers of `renderLiveBoard`. `board.test.ts` already covers the components. Gate with new `renderLiveBoard` unit test (§4 #2). Pure move-to-sibling. |
| 3 | **`usage-logging.ts` — move `makeLogUsage`** — create `controller/usage-logging.ts`; handler re-exports `makeLogUsage` | R-util | −35 / +45 | **very low** | Already tested in isolation (`usage-logging.test.ts`). NO external production importer (called once inside `execute()`); the handler re-export is a no-cost safety net keeping the TEST import path stable. Zero behavior change. |
| 4 | **`recall.ts` — move recall cluster** — create `controller/recall.ts` with `runScopedRecall`, `relevantExtract`, `collectApproved`, `buildRecallBlock`, `rankStatus`, `isBetterStep`, `isBetterMcp`, recall constants; handler re-exports the two public functions | R3 | −250 / +270 | **low** | `run-scoped-recall.test.ts` pins the two exported functions in isolation. `collectApproved` is only called by `finalize()` in the handler; the import is internal. The `cosine` dependency (`../embedder-knowledge-index.js`) moves with `recall.ts`. |
| 5 | **Inline `toLlmToolCall`** — expand the one call site in `runStep` and delete the module-scope function | R4 | −30 / +20 | **very low** | Single call site; zero external importers; trivially verifiable by the existing `round-trip.test.ts` exercising the external-tool path. Do after Slice 4 to keep the diff set coherent. |
| 6 | **Residual cleanup** — after all moves, remove dead re-exports that are no longer needed, tighten section comments in the shrunken handler | R1 residual | −10 / +0 | **very low** | Cosmetic; no behavior change. Handler ends at ~1350 lines — a single-responsibility execution loop. |

Cumulative: `controller-coordinator-handler.ts` drops from 2026 toward ~1350 lines; the
controller component family gains `parser.ts`, `recall.ts`, `usage-logging.ts`, and an enriched
`board.ts` — all small, single-purpose, individually testable modules aligned with the existing
family's naming discipline. The inverted `extractJsonObject` dependency is eliminated in Slice 1.

### 6. Principle self-check

| # | Principle | Compliance of this decomposition |
|---|---|---|
| 1 | **Build ON existing components** | R2: REUSE `board.ts` (sibling; owns all board components `renderLiveBoard` delegates to). R3: REUSE `IKnowledgeRagHandle`/`IEmbedder` (catalog) as the boundary for the recall module. R-util: REUSE `IRequestLogger` (catalog). R1 residual: REUSE `ISubagentClient`, `IFinalizer`, `IReviewer`, `IControllerPlanner` (all catalog/sibling interfaces). All 4 new modules land in the existing controller family — not invented parallel layers. ✅ |
| 2 | **The app IS the example** | Post-refactor the handler is a thin orchestrator that imports from its named sibling modules (`parser`, `board`, `recall`, `usage-logging`) — the exact pattern consumers building their own controller should copy. No more mixed responsibilities in the entry point. ✅ |
| 3 | **Everything around interfaces** | New modules are parameter-typed against catalog interfaces (`IKnowledgeRagHandle`, `IEmbedder`, `IRequestLogger`). The handler itself is already `IStageHandler`. No new interface for the pure-function modules (the function signatures ARE the interface for the pure parser/recall clusters — no object needed). ✅ |
| 4 | **Many small interfaces (ISP)** | No existing interface is widened. The pure-function modules expose focused, single-concern signatures. `IStageHandler` (handler), `ISubagentClient` (executor/planner/evaluator), `IReviewer`, `IFinalizer`, `IControllerPlanner` all remain unchanged. ✅ |
| 5 | **Consumer-owned variation = strategies** | Variation points (`deps.reviewer`, `deps.finalizer`, `deps.controllerPlanner`, `deps.skillsRecall`, `deps.isExternalTool`) are already injectable seams in `ControllerHandlerDeps` — unchanged. `makeControllerPlanner` selects the planner implementation (reused). ✅ |
| 6 | **Control file size** | Primary objective: 2026 → ~1350 residual handler + 4 small sibling modules (each under 300 lines). The four new modules are well below the 500-line threshold. The residual handler at ~1350 lines remains large; further reduction requires splitting the execution loop itself (out of scope for this audit, one-monolith-per-plan). ✅ |
| 7 | **Don't break components** | All 4 production blast-radius importers keep their import paths unchanged via barrel re-exports in the handler. `planner.ts` and `reviewer.ts` update to `./parser.js` (correct direction). Public function and class signatures are byte-stable. Pinned by the full controller test suite (21 test files) + `public-api.test.ts`. ✅ |

## Blueprint: config.ts

`packages/llm-agent-server-libs/src/smart-agent/config.ts` (1648 lines). The file is a
pure-function module with no class state — all coupling flows through imports, not mutable
fields. Its six responsibilities are each already expressed as discrete exported functions
or cohesive clusters of private helpers, making this the lowest-risk decomposition in the
audit: the extraction targets are already function-shaped; the work is relocation + barrel
re-export, not re-architecture.

Key structural fact: `parsers.ts` carries a comment `// PERMANENT facade: re-exports the
pure parsers from config.ts (they STAY there ...)`. That was a prior per-PR decision; this
blueprint supersedes it — the extraction targets are precisely those parsers.

Blast radius = 8 direct non-test production importers (grep-verified, listed in §4).

### 1. Responsibility map (jobs → function clusters / line ranges)

| # | Responsibility | Functions / types (line ranges) |
|---|---|---|
| **R1** | **YAML loading + env-var resolution + template generation** — read a YAML file, substitute `${VAR:-default}` env references recursively, write the starter-template file | `YamlConfig` type `284`, `YAML_TEMPLATE` const `311`–`428`, `resolveEnvVars` `430`–`448`, `loadYamlConfig` `450`–`456`, `generateConfigTemplate` `458`–`460` |
| **R2** | **LLM config normalization + role resolution** — detect flat vs. map shape, normalise to `NormalizedLlmMap { main, … }`, look up a named role with fallback chain | `LlmConfigMap` `38`, `NormalizedLlmMap` `39`, `isFlatLlmConfig` `48`–`56` (private), `normalizeLlmConfig` `64`–`78`, `resolveLlmConfigStrict` `86`–`92`, `resolveLlmConfig` `102`–`110`, `resolveReviewerLlmName` `117`–`130` |
| **R3** | **Coordinator/dispatch config resolution + finalizer building** — resolve YAML coordinator knobs to concrete strategy objects (`IPlanning`, `IDispatch`, `IActivation`, `IToolSelectionStrategy`, `IFinalizer`) | `YamlCoordinator` interface `132`–`158`, `resolveCoordinatorPlanning` `160`–`176`, `resolveCoordinatorDispatchKind` `184`–`188`, `resolveCoordinatorDispatch` `190`–`220`, `resolveCoordinatorActivation` `222`–`233`, `resolveToolSelectionStrategy` `235`–`256`, `FinalizerYaml` `462`–`466`, `buildFinalizer` `479`–`503` |
| **R4** | **Config validation** — fail-loud legacy-shape guard, LLM / RAG / MCP / pipeline-name shape checks | `VALID_PROVIDERS` `258`–`264`, `VALID_RAG_TYPES` `266`–`271`, `ConfigValidationError` `273`–`282`, `get` accessor `505`–`511` (private), `checkLlmRole` `513`–`561` (private), `checkRagStore` `563`–`623` (private), `validateLlmEntry` `626`–`635` (private), `assertNoLegacyPipelineConfig` `648`–`671`, `validateResolvedConfig` `673`–`771` (private) |
| **R5** | **Top-level config resolution + sub-agent parsing** — integrate R1–R4 + skill-plugins + subagents into the full `SmartServerConfig`; the public integration entry point | `ResolveConfigArgs` `286`–`309`, `ResolveSmartServerConfigOptions` `868`–`881`, `parseSubAgents` `785`–`866` (private), `resolveSmartServerConfig` `883`–`1206` |
| **R6** | **Stepper coordinator config parsing** — parse `coordinator.flow` YAML into `StepperCoordinatorConfig`; mode preset expansion; nested composition node tree | `StepperMode` `1215`, `CompositionNode` `1225`–`1231`, `StepperCompositionSpec` `1237`–`1259`, `StepperCoordinatorConfig` `1261`–`1323`, `MODES` `1326`–`1330`, `MODE_FLOW_PRESET` `1338`–`1345`, `parseFlowPlan` `1348`–`1368`, `FlowBounds` type `1371`–`1381`, `parseNestedFlowSpec` `1388`–`1435`, `parseSystemPromptOverride` `1438`–`1446`, `parseCompositionNodes` `1449`–`1472`, `parseStepperCoordinatorConfig` `1484`–`1648` |

Approximate line counts per responsibility: R1 ~130, R2 ~95, R3 ~185, R4 ~260, R5 ~375, R6 ~434.

### 2. Seams (cut lines + shared state / data boundaries)

The file has no mutable class state — all coupling is through function parameters, imports,
and the shared `YamlConfig` / `NormalizedLlmMap` types. Seams are therefore import-level,
not field-level.

| Cut | Shared state / type boundary | Coupling note |
|---|---|---|
| **R1 YAML loader** | `YamlConfig` type consumed by R4 + R5 | Cleanest cut: `YamlConfig` moves with R1 to `yaml-loader.ts`; R4 and the residual R5 import it from there. The private `get` accessor (lines `505`–`511`) is used in both R4 (`validateResolvedConfig`) and R5 (`resolveSmartServerConfig`); it is a 5-line pure function — duplicate in both targets or keep in a shared util. |
| **R2 LLM map** | `NormalizedLlmMap` consumed by R3 (`buildFinalizer`, `resolveCoordinatorDispatch`), R5 (`resolveSmartServerConfig`), and 4 production files external to config.ts | `NormalizedLlmMap` must move with R2 to `llm-config-map.ts`; R3 and R5 import it from there. Barrel re-exports in `config.ts` keep all external import paths stable. |
| **R3 coordinator resolvers** | Receives `NormalizedLlmMap` (R2), `SmartServerLlmConfig` (from `smart-server.ts` types), `ILlm` | R3 depends on R2 types — extract R2 first, then R3 can import from `llm-config-map.ts`. No shared mutable state. |
| **R4 validator** | `YamlConfig` (R1), `VALID_PROVIDERS`/`VALID_RAG_TYPES` (constants); calls `checkLlmRole`/`checkRagStore` (private, stay with R4) | `assertNoLegacyPipelineConfig` and `validateResolvedConfig` are called only inside R5 (`resolveSmartServerConfig`); zero external production importers of either (grep-verified). Safest cut: all are private to the validator module after extraction. |
| **R5 residual** | Integrates R1 (`loadYamlConfig`, `resolveEnvVars`), R4 (`assertNoLegacyPipelineConfig`, `validateResolvedConfig`), R6 (`parseStepperCoordinatorConfig` not called here — but `parseSubAgents` calls `resolveSmartServerConfig` recursively), plus `parseSkillPluginsConfig` (external import) | After R1–R4, R6 leave, the residual ~350-line `config.ts` is `resolveSmartServerConfig` + `parseSubAgents` + `ResolveConfigArgs` + `ResolveSmartServerConfigOptions` + the private `get` accessor. The recursive `parseSubAgents → resolveSmartServerConfig` call is an intra-R5 detail; no new coupling introduced. |
| **R6 stepper config** | `PlanNode` from `@mcp-abap-adt/llm-agent` (catalog, already imported); no types shared back to R1–R5 | Cleanest cut of all: R6 has zero shared types with R1–R4 and is not called by R5. It is a fully self-contained 434-line block. The only callers are `build-stepper-root.ts` (imports `parseStepperCoordinatorConfig`, `StepperCompositionSpec`, `StepperCoordinatorConfig`, `NormalizedLlmMap`, `resolveLlmConfig`) and `parsers.ts` (re-exports `parseStepperCoordinatorConfig`, `StepperCoordinatorConfig`). |

### 3. Decomposition target per responsibility (components-first)

For each responsibility: the **Component catalog reference** was checked first.

- **R1 YAML loading → EXTRACT `yaml-loader.ts`.**
  No catalog component owns YAML file loading or env-var substitution. `resolveEnvVars` and
  `loadYamlConfig` are pure utility functions with no strategy variation; `YAML_TEMPLATE` +
  `generateConfigTemplate` are the single point of template ownership. A focused
  `yaml-loader.ts` module (`YamlConfig` type, `resolveEnvVars`, `loadYamlConfig`,
  `generateConfigTemplate`, `YAML_TEMPLATE`) is justified as a reusable, zero-dependency
  FS+env utility. Any future consumer (e.g. a test harness, a config editor) can import
  it without pulling in all coordinator-resolver or validation logic. Zero catalog REUSE
  opportunity — the catalog has no generic YAML loader; this is a genuine new small module.

- **R2 LLM config normalization → EXTRACT `llm-config-map.ts`.**
  No catalog component owns LLM-map normalization. The four exported functions
  (`normalizeLlmConfig`, `resolveLlmConfig`, `resolveLlmConfigStrict`, `resolveReviewerLlmName`)
  are already discrete and stateless; they form a cohesive "LLM role resolution" cluster.
  Extract to `llm-config-map.ts`. The catalog's `makeLlm`/`makeDefaultLlm` (in
  `llm-agent-libs`) are the factory end; this module is the "which config to pass to the
  factory" end — they are complementary, not overlapping. `NormalizedLlmMap` moves with the
  module. REUSE `SmartServerLlmConfig` (imported from `smart-server.ts`) as the input type;
  no new interfaces needed (the function signatures ARE the interface).

- **R3 Coordinator resolvers + finalizer → EXTRACT `pipelines/coordinator-resolvers.ts`.**
  `resolveCoordinatorPlanning`, `resolveCoordinatorDispatch`, `resolveCoordinatorDispatchKind`,
  `resolveCoordinatorActivation`, `resolveToolSelectionStrategy`, `buildFinalizer` return objects
  implementing catalog interfaces (`IPlanning`, `IDispatch`, `IActivation` from
  `@mcp-abap-adt/llm-agent-libs`; `IToolSelectionStrategy`, `IFinalizer` from
  `@mcp-abap-adt/llm-agent`). REUSE these catalog interfaces as the contract.
  Natural landing zone: the `pipelines/` family alongside `parsers.ts`, which already imports
  three of these functions from `config.js`. Moving them to `pipelines/coordinator-resolvers.ts`
  shortens the import chain for `parsers.ts` (same directory) and makes `parsers.ts`'s facade
  comment (`re-exports the pure parsers from config.ts`) obsolete. `buildFinalizer` belongs
  here because it is the coordinator's finalizer sub-factory (not a top-level config concern).
  `YamlCoordinator` interface also moves here as the YAML input shape for the coordinator block.

- **R4 Config validation → EXTRACT `config-validator.ts`.**
  No catalog component owns YAML config validation. `ConfigValidationError` and
  `assertNoLegacyPipelineConfig` are exported but have zero external production importers
  (grep-verified: they appear only inside `config.ts` itself — `assertNoLegacyPipelineConfig`
  is called by `resolveSmartServerConfig`, `ConfigValidationError` is thrown by
  `validateResolvedConfig`). All private validators (`checkLlmRole`, `checkRagStore`,
  `validateLlmEntry`, `validateResolvedConfig`) move with them. `VALID_PROVIDERS` and
  `VALID_RAG_TYPES` are pure validation constants that move with the validator. The `get`
  accessor (5-line private YAML-path helper) is duplicated or kept in each caller — trivial.
  Result: an entirely internal module (`config.ts` imports from `config-validator.ts`;
  no external importer changes). Very low risk.

- **R5 Top-level resolution → KEEP as residual `config.ts` (integration root; no extraction).**
  `resolveSmartServerConfig` is the public integration entry point: it calls R1, R4, R6,
  and `parseSkillPluginsConfig` to produce the full `SmartServerConfig`. `parseSubAgents`
  is an 80-line recursive sub-routine that can only exist alongside `resolveSmartServerConfig`
  (it calls it recursively). These cannot be split further without reducing to trivial
  delegation. After all other extractions, the residual `config.ts` retains:
  `ResolveConfigArgs`, `ResolveSmartServerConfigOptions`, `parseSubAgents`,
  `resolveSmartServerConfig`, the 5-line `get` accessor, and barrel re-exports of all moved
  symbols to preserve import paths. Residual target: ~350 lines. Public API is byte-stable.

- **R6 Stepper config parsing → EXTRACT `smart-agent/stepper-config.ts`.**
  The 434-line stepper block is the most self-contained cluster in the file: it owns its
  own types (`StepperMode`, `StepperCompositionSpec`, `StepperCoordinatorConfig`,
  `CompositionNode`), its own constants (`MODES`, `MODE_FLOW_PRESET`), and a single public
  entry point (`parseStepperCoordinatorConfig`). REUSE `PlanNode` from `@mcp-abap-adt/llm-agent`
  (catalog; already imported). Natural landing zone: next to `build-stepper-root.ts`, which
  consumes this config to build the runtime `Stepper`. The `parsers.ts` "PERMANENT facade"
  comment is superseded by this blueprint. `parsers.ts` updates its re-export source to
  `../smart-agent/stepper-config.js`. `build-stepper-root.ts` updates its import to
  `./stepper-config.js`. All other consumers via the `index.ts` barrel need no changes.

Every R1–R6 has a target. Net: **5 EXTRACTs** (all small + focused: `yaml-loader.ts`,
`llm-config-map.ts`, `pipelines/coordinator-resolvers.ts`, `config-validator.ts`,
`smart-agent/stepper-config.ts`) + **1 KEEP** (R5 residual in `config.ts`, the integration
root). No new god-fragments; all extractions are reusable modules bounded by function
signatures or catalog interfaces.

### 4. Behavior-preservation strategy

Behavior-preserving, public-API-stable refactor pinned by characterization tests.

**Public API that must stay byte-stable** (every importer claim below grep-verified against
production non-test files):

| Symbol | Current importer(s) — grep-verified | Strategy |
|---|---|---|
| `resolveSmartServerConfig` | `builders/controller-skill-pipeline-builder.ts` (line 3); `llm-agent-server/scripts/start-smart-server.ts`; `llm-agent-server/src/smart-agent/cli.ts` (line 61); re-exported by `smart-server.ts` (line 458) and `index.ts` (line 11 via `export *`) | Stays in residual `config.ts` — no change |
| `NormalizedLlmMap` | `smart-server.ts` (line 431); `build-stepper-root.ts` (line 32); `build-dag-coordinator-deps.ts` (line 18 via `config.js`); `pipelines/server-context.ts` (line 13) | Barrel re-export in `config.ts` from `llm-config-map.ts`; all import paths stable |
| `normalizeLlmConfig` | `smart-server.ts` (line 433) | Barrel re-export in `config.ts` |
| `resolveLlmConfig` | `smart-server.ts` (line 434); `build-stepper-root.ts` (line 37); `build-dag-coordinator-deps.ts` | Barrel re-export in `config.ts` |
| `resolveLlmConfigStrict` | `smart-server.ts` (line 435); `build-dag-coordinator-deps.ts` | Barrel re-export in `config.ts` |
| `resolveToolSelectionStrategy` | `smart-server.ts` (lines 436, 2765); re-exported by `smart-server.ts` (line 462) | Barrel re-export in `config.ts` |
| `resolveCoordinatorPlanning`, `resolveCoordinatorDispatch`, `resolveCoordinatorDispatchKind` | `pipelines/parsers.ts` (lines 13–15) | Barrel re-export in `config.ts` and update `parsers.ts` import to `./coordinator-resolvers.js` (same directory) |
| `resolveCoordinatorActivation` | `build-dag-coordinator-deps.ts` (line 19) | Barrel re-export in `config.ts` |
| `buildFinalizer` | `build-dag-coordinator-deps.ts` (line 17) | Barrel re-export in `config.ts` |
| `resolveReviewerLlmName` | `build-dag-coordinator-deps.ts` (line 22) | Barrel re-export in `config.ts` |
| `parseStepperCoordinatorConfig`, `StepperCoordinatorConfig`, `StepperCompositionSpec`, `CompositionNode` | `build-stepper-root.ts` (lines 37–41); `pipelines/parsers.ts` re-exports (lines 3–5, 6) | Barrel re-export in `config.ts`; `parsers.ts` re-export source updates to `../smart-agent/stepper-config.js` |
| `loadYamlConfig`, `resolveEnvVars`, `generateConfigTemplate`, `YAML_TEMPLATE`, `YamlConfig` | Re-exported by `smart-server.ts` (lines 453–464) and `index.ts` (via `export *`) | Barrel re-export in `config.ts` from `yaml-loader.ts` |
| `assertNoLegacyPipelineConfig` | **No external production importer** (grep-verified: only appears inside `config.ts` itself) | Can remain internal to `config-validator.ts`; barrel re-export optional |
| `ConfigValidationError` | **No external production importer** (grep-verified: only referenced inside `config.ts`) | Can remain internal to `config-validator.ts`; barrel re-export optional |

**Existing characterization tests to lean on:**
- `stepper-config.test.ts` (R6 `parseStepperCoordinatorConfig` — direct cover)
- `llm-map-normalize.test.ts` (R2 `normalizeLlmConfig`, `resolveLlmConfig`)
- `coordinator-dispatch-resolver.test.ts` (R3 coordinator resolvers)
- `config-validation.test.ts` (R4 + R5 `resolveSmartServerConfig`, validation)
- `tool-selection-config.test.ts` (R3 `resolveToolSelectionStrategy`)
- `build-stepper-root.test.ts` (R6 integration — exercises `parseStepperCoordinatorConfig` via `buildStepperRoot`)
- `build-dag-coordinator-deps.test.ts` (R2 + R3 integration — exercises `normalizeLlmConfig`, `buildFinalizer`, `resolveCoordinatorActivation`)

**Tests to ADD before refactoring (gaps):**
1. A **`buildFinalizer` unit test** — `passthrough` / `template` / `llm` branches, including
   the error case when no LLM config is available. Pin BEFORE extracting R3 (`coordinator-resolvers.ts`).
2. A **`resolveEnvVars` deep-nesting + fallback test** — array-of-objects with `${VAR:-default}`
   at multiple depths. Pin BEFORE extracting R1 (`yaml-loader.ts`), though the function is
   already partially tested via `config-validation.test.ts`.

### 5. Suggested PR slices (ordered; first = lowest-risk / highest-value)

| # | Slice | Touches | Rough Δ | Risk | Why here |
|---|---|---|---|---|---|
| 1 | **`stepper-config.ts` — extract R6** — create `smart-agent/stepper-config.ts` with all stepper types + `parseStepperCoordinatorConfig`; `config.ts` barrel re-exports; `build-stepper-root.ts` updates import to `./stepper-config.js`; `parsers.ts` updates re-export source | R6 | −434 / +450 | **low** | Largest single-step line reduction; fully self-contained (zero shared state, no external type dependencies except `PlanNode`); pinned by `stepper-config.test.ts` + `build-stepper-root.test.ts`. Supersedes the "PERMANENT" comment in `parsers.ts`. |
| 2 | **`yaml-loader.ts` — extract R1** — create `yaml-loader.ts`; move `YamlConfig`, `YAML_TEMPLATE`, `resolveEnvVars`, `loadYamlConfig`, `generateConfigTemplate`; `config.ts` barrel re-exports all | R1 | −130 / +145 | **very low** | Pure FS + env functions, no strategy variation. All external callers go through `smart-server.ts` re-exports or `index.ts` barrel — no import path changes needed. |
| 3 | **`llm-config-map.ts` — extract R2** — create `llm-config-map.ts`; move `LlmConfigMap`, `NormalizedLlmMap`, `normalizeLlmConfig`, `resolveLlmConfig`, `resolveLlmConfigStrict`, `resolveReviewerLlmName`; `config.ts` barrel re-exports all | R2 | −95 / +110 | **very low** | Discrete exported functions; pinned by `llm-map-normalize.test.ts`. 4 importers of `NormalizedLlmMap` keep their paths via barrel re-export. |
| 4 | **`config-validator.ts` — extract R4** — create `config-validator.ts`; move `VALID_PROVIDERS`, `VALID_RAG_TYPES`, `ConfigValidationError`, `assertNoLegacyPipelineConfig`, all private validation helpers; `config.ts` imports validators internally | R4 | −260 / +275 | **very low** | Zero external production importers of any moved symbol (grep-verified). `resolveSmartServerConfig` imports `assertNoLegacyPipelineConfig`/`validateResolvedConfig` from `./config-validator.js`. Barrel re-export of `ConfigValidationError`+`assertNoLegacyPipelineConfig` optional (no consumer). |
| 5 | **`pipelines/coordinator-resolvers.ts` — extract R3** — create `pipelines/coordinator-resolvers.ts`; move `YamlCoordinator`, all `resolveCoordinator*`, `resolveToolSelectionStrategy`, `FinalizerYaml`, `buildFinalizer`; update `parsers.ts` import path; `config.ts` barrel re-exports all | R3 | −185 / +200 | **low** | Pinned by `coordinator-dispatch-resolver.test.ts`. `parsers.ts` updates its import from `../smart-agent/config.js` → `./coordinator-resolvers.js` (same directory, shorter path). `build-dag-coordinator-deps.ts` import remains from `./config.js` (barrel). New `buildFinalizer` unit test (§4 #1) must gate this. |
| 6 | **Residual cleanup** — remove dead internal boilerplate in `config.ts`; verify `config.ts` is now ~350 lines containing only R5 + barrel re-exports; update `parsers.ts` PERMANENT comment | residual | −10 / +0 | **very low** | Cosmetic. `config.ts` ends as the single integration entry point (`resolveSmartServerConfig`) — the correct thin composition root. |

Cumulative: `config.ts` drops from 1648 lines toward ~350 lines (R5 residual + barrel
re-exports); the 5 extracted modules are each under 450 lines, all cohesive single-concern,
all individually testable. The `pipelines/` family gains `coordinator-resolvers.ts` next to
`parsers.ts`, and the `smart-agent/` family gains `stepper-config.ts` next to
`build-stepper-root.ts` — both logically co-located with their primary consumers.

### 6. Principle self-check

| # | Principle | Compliance of this decomposition |
|---|---|---|
| 1 | **Build ON existing components** | R3: REUSE `IPlanning`, `IDispatch`, `IActivation` (catalog; from `llm-agent-libs`), `IToolSelectionStrategy`, `IFinalizer` (catalog; from `llm-agent`) as return-type contracts for the extracted coordinator resolvers — the modules become thin constructors of catalog components. R6: REUSE `PlanNode` (catalog; `llm-agent`). All 5 EXTRACTs use catalog types as boundaries; none invent parallel abstractions. ✅ |
| 2 | **The app IS the example** | Post-refactor the residual `config.ts` is a thin composition root that imports from `yaml-loader`, `llm-config-map`, `pipelines/coordinator-resolvers`, `config-validator`, and `stepper-config` — the pattern a consumer building their own config pipeline should copy. ✅ |
| 3 | **Everything around interfaces** | R3 functions return catalog interface types (`IPlanning`, `IDispatch`, etc.) — the caller sees interfaces, not classes. R2 functions return `NormalizedLlmMap` (a data type bounded by `SmartServerLlmConfig`). No new class-level interfaces needed for the pure-function modules — function signatures ARE the contracts. ✅ |
| 4 | **Many small interfaces (ISP)** | Each extract is single-concern: YAML loading, LLM-map resolution, coordinator strategy resolution, validation, stepper config parsing are each a focused surface. No existing interface is widened. ✅ |
| 5 | **Consumer-owned variation = strategies** | Coordinator strategies (`IPlanning`, `IDispatch`, `IActivation`) are already consumer-injectable strategy objects — the extracting does not change that contract. `buildFinalizer` stays async-factory shaped, accepting `makeLlm` as an injectable. ✅ |
| 6 | **Control file size** | Primary objective: 1648 → ~350 residual + 5 modules each under 450 lines (R6 ~450, R4 ~275, R3 ~200, R1 ~145, R2 ~110). Every extracted module is well under the 500-line threshold. ✅ |
| 7 | **Don't break components** | All 8 blast-radius importers keep their import paths via barrel re-exports in `config.ts`. Only two files update their imports: `parsers.ts` shortens its coordinator-resolver import to `./coordinator-resolvers.js` (same directory, same package); `build-stepper-root.ts` updates to `./stepper-config.js` (same directory). Both are internal to `llm-agent-server-libs`. Public function signatures are byte-stable. Pinned by all 7 existing test suites listed in §4. ✅ |

## Blueprint: builder.ts

`packages/llm-agent-libs/src/builder.ts` (1437 lines). The file is a single exported class
(`SmartAgentBuilder`) plus its companion config types and one private helper. The class has grown
to embed ~250 lines of MCP tool-vectorization logic (batch + sequential embed loops for tool
and skill indexing) directly inside `build()`, which `docs/ARCHITECTURE.md` (lines 1134–1138)
explicitly flags as a tech-debt extraction target. Beyond that inline block the file divides
cleanly into four jobs: config/handle types, fluent setter API, MCP+vectorization, and core
assembly. Blast radius = 4 direct non-test production importers (grep-verified, §4).

### 1. Responsibility map (jobs → method clusters / line ranges)

| # | Responsibility | Code cluster (line ranges) |
|---|---|---|
| **R1** | **Config and handle types** — public input/output shapes for the builder: `BuilderMcpConfig`, `BuilderPromptsConfig`, `SmartAgentBuilderConfig`, `SmartAgentHandle` type alias, and the `isModelProvider` type-guard used with the handle | `BuilderMcpConfig` 111–121; `BuilderPromptsConfig` 123–134; `SmartAgentBuilderConfig` 136–154; `SmartAgentHandle` 162–168; `isModelProvider` 174–181 (~71 lines total) |
| **R2** | **Fluent setter API** — ~50 `with*`/`set*`/`add*`/`create*` methods; private field declarations; constructor. Pure pass-throughs that accumulate injected values into private fields | Private fields 184–250; constructor 251–253; fluent setters 260–706 (~524 lines) |
| **R3** | **MCP connection + tool/skill vectorization** — normalise `BuilderMcpConfig[]` → `McpConnectionConfig[]`, call `makeConnectionStrategy` + `resolve()`, iterate over connected clients and embed their tool descriptions (batch path → sequential fallback → sequential-only), log embedding usage, then vectorize skill descriptions into the same RAG store. Also includes the `buildRetrievalSource` private helper that wraps a RAG + embedder pair into a `SubAgentRetrievalSource` callback (used by coordinator dispatch wiring in R4) | `buildRetrievalSource` 713–723; MCP config normalisation 955–967; connection setup 963–970; per-client vectorization batch path 973–1051; batch fallback to sequential 1052–1091; sequential-only path 1092–1127; client-level catch 1129–1138; skill vectorization 1245–1276 (~250 lines across the two `build()` blocks) |
| **R4** | **Core `build()` assembly** — model validation, startup probe, RAG store auto-creation, registry + provider wiring, circuit-breaker wrapping, request-logger setup, SmartAgent config assembly, retry + rate-limiter wrapping, classifier construction, assembler construction, history memory + summarizer, plugin loader, pipeline init, `SmartAgent` construction, model-provider auto-detection, API adapter merge, handle return | Lines 725–938 + 1142–1437, minus R3 sub-ranges; remaining assembly ~450 lines |

Approximate line counts per responsibility: R1 ~71, R2 ~524, R3 ~250, R4 ~450 (post-R3).

### 2. Seams (natural cut lines + shared state / data boundaries)

The class has mutable private fields but they are only read once, inside `build()`. All coupling
is therefore local to `build()`'s sequential flow — no field mutated after construction.

| Cut | Shared state / type boundary | Coupling note |
|---|---|---|
| **R1 config/handle types** | `SmartAgentBuilderConfig` consumed by the constructor; `SmartAgentHandle` is the return type of `build()` | Clean import-level cut. All four importer files reach these types via the `@mcp-abap-adt/llm-agent-libs` barrel — moving the types to `builder-types.ts` with barrel re-export in `builder.ts` + `index.ts` leaves all import paths unchanged. |
| **R2 setter API** | Setters are the only writers of private fields; `build()` is the only reader | Setters and class state are inseparable by design (fluent builder pattern). Extracting them would require either duplicating the class or an awkward mixin approach. No extraction. |
| **R3 vectorization block** | Inputs: `mcpClients: IMcpClient[]`, `toolsRag: IRag`, `this._embedder`, `requestLogger`, `log`. Output: side-effect (RAG store populated). All inputs are resolved before the vectorization loop begins (line 939), and no local variable created in the vectorization block is consumed by subsequent R4 steps. | Cleanest cut in the file. The block is a pure function of its arguments — no reads or writes to private fields inside the loop. Extraction does not break the sequential flow; `build()` calls the extracted function and continues. `buildRetrievalSource` (lines 713–723) is a 5-line helper used in R4's coordinator dispatch wiring (line 1291); it is NOT part of R3's vectorization function — it stays in `builder.ts`. |
| **R4 assembly phases** | Each phase creates local variables fed into the next (e.g. `wrappedMainLlm` → classifier → assembler → pipeline → `SmartAgent` → handle) | Phases are intrinsically sequential with local-variable coupling. No useful seam exists within R4; decomposing it would produce a context-object pass-around that adds more code than it removes. KEEP as one build() body. |

### 3. Decomposition target per responsibility (components-first)

Catalog checked first for each R.

- **R1 Config/handle types → EXTRACT `builder-types.ts`.**
  No catalog component owns builder config shapes. `BuilderMcpConfig`, `BuilderPromptsConfig`,
  `SmartAgentBuilderConfig` are the public wiring contract for `SmartAgentBuilder`; `SmartAgentHandle`
  is its public return type. Moving them to a focused ~70-line companion file (`builder-types.ts`,
  same directory as `builder.ts`) separates types from implementation, improves discoverability for
  embed-as-library users who need the config shapes without importing the full builder, and shrinks
  `builder.ts`'s import section. `isModelProvider` (4-line private guard) moves with `SmartAgentHandle`
  since it guards that type. `builder.ts` re-exports all R1 symbols so import paths are stable.
  Zero new interfaces needed — the type shapes ARE the interface.

- **R2 Fluent setter API → KEEP in builder.ts.**
  Catalog has no "setter mixin" component. The 50 setters are by design inseparable from the private
  fields they populate — extracting them would create an awkward class-split with no reuse benefit.
  They add zero logic; they are the public builder surface.

- **R3 MCP connection + tool/skill vectorization → EXTRACT `vectorize-mcp-tools.ts` (PRIME EXTRACT).**
  `docs/ARCHITECTURE.md` (lines 1134–1138) explicitly names this as the prime tech-debt extraction
  target: "the builder's MCP block (connect + tool vectorization — pull the vectorization into its
  own small module consumed by the builder)." No catalog component owns MCP tool vectorization.
  The extracted module exposes two focused async functions:
  - `vectorizeMcpTools(clients: IMcpClient[], toolsRag: IRag, requestLogger: IRequestLogger, logger: ILogger | undefined): Promise<void>` — batch + sequential embed paths (lines 973–1139)
  - `vectorizeSkills(skillManager: ISkillManager, toolsRag: IRag, requestLogger: IRequestLogger, logger: ILogger | undefined): Promise<void>` — skill indexing (lines 1245–1276)

  REUSE catalog interfaces as all parameter types: `IMcpClient`, `IRag`, `IEmbedder`, `isBatchEmbedder`,
  `IRequestLogger`, `ILogger`, `ISkillManager` — all from `@mcp-abap-adt/llm-agent`. No new interfaces
  needed; function signatures ARE the contract (Principle 3, pure-function module). Landing zone:
  `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts` (co-located with MCP-adjacent code in
  `llm-agent-libs`). Any future builder variant, server-side worker, or consumer that pre-indexes
  tools from a different trigger path can import this function without pulling in the full builder.

- **R4 Core assembly → KEEP in residual builder.ts.**
  `build()` is the public integration entry point — it is the composition root. All catalog
  components are already instantiated from the catalog: `CircuitBreakerLlm`, `RetryLlm`,
  `RateLimiterLlm`, `DefaultRequestLogger`, `LlmClassifier`, `ContextAssembler`, `HistoryMemory`,
  `HistorySummarizer`, `DefaultPipeline`, `SimpleRagRegistry`, `SimpleRagProviderRegistry` — this
  is exactly "building ON existing components." The sequential assembly cannot be split further
  without creating a context-object pass-around that adds more lines than it removes and produces
  an ad-hoc fragment (Principle 1 corollary). After R3 extraction, the residual `build()` method
  body is ~450 lines (the method body alone — not a per-file comparison).

Net: **2 EXTRACTs** (`builder-types.ts` ~70 lines, `vectorize-mcp-tools.ts` ~250 lines) + **2 KEEPs**
(setter API R2, core assembly R4). Post-extraction `builder.ts` drops from 1437 → ~1170 lines
(imports + R2 setters + R4 assembly + barrel re-exports for R1).

### 4. Behavior-preservation strategy

Behavior-preserving, public-API-stable refactor pinned by existing characterization tests.

**Public API that must stay byte-stable** (all importer claims grep-verified; commands and
raw results in `.superpowers/sdd/task-7-report.md`):

| Symbol | Current importer(s) — grep-verified | Strategy |
|---|---|---|
| `SmartAgentBuilder` | `smart-server.ts:76`; `pipelines/server-context.ts:11`; `pipelines/register-skill-sources.ts:1`; `legacy/flat.ts:2` (re-export) — all via `@mcp-abap-adt/llm-agent-libs` barrel | Stays in `builder.ts`; barrel unchanged |
| `SmartAgentHandle` | `smart-server.ts:77` — via `@mcp-abap-adt/llm-agent-libs` barrel | Barrel re-export from `builder-types.ts` via `builder.ts`; path stable |
| `BuilderMcpConfig` | **No external production importer** (grep-verified: only `index.ts:34` barrel export) | Barrel re-export from `builder-types.ts`; optional (no external consumer) |
| `BuilderPromptsConfig` | **No external production importer** (grep-verified: only `index.ts:35` barrel export) | Barrel re-export from `builder-types.ts`; optional |
| `SmartAgentBuilderConfig` | **No external production importer** (grep-verified: only `index.ts:37` barrel export) | Barrel re-export from `builder-types.ts`; optional |

All 4 blast-radius importers reach `SmartAgentBuilder` via the `@mcp-abap-adt/llm-agent-libs`
package barrel (`index.ts` → `builder.js`). None import `./builder.js` directly (grep-verified:
only `index.ts:39` imports `from './builder.js'` within the package). Import paths are unchanged
by any extraction — the barrel is the stable public surface.

**Existing characterization tests to lean on** (15 test files exercise `SmartAgentBuilder`,
grep-verified):

- `builder-tool-selection.test.ts` — direct cover for R3 tool vectorization + RAG selection
- `builder-startup-validation.test.ts` — direct cover for R4 model validation probe
- `builder-mcp-failure-logging.test.ts` — direct cover for R3 MCP failure + warning paths
- `builder-coordinator-dispatch-default.test.ts` — direct cover for R4 coordinator default wiring
- `builder-context-builder-wiring.test.ts` — direct cover for `buildRetrievalSource` (stays in R4)
- `builder-api-adapters.test.ts` — R4 API adapter merge
- `builder-rag-collection-idempotency.test.ts` — R4 RAG registry idempotency
- `handle-exposes-rag-registry.test.ts` — handle shape (R1 `SmartAgentHandle`)
- `mcp-clients-di.test.ts` — R2/R3 MCP client DI path (`withMcpClients`)
- `agent-readiness.test.ts` — R4 builder → readiness
- `mcp-yaml-vectorization.test.ts` (server-libs) — R3 YAML-driven vectorization path
- `mcp-single-connect.test.ts` (server-libs) — R3 single-connect path
- `server-context.test.ts` (server-libs) — R1/R2 `SmartAgentBuilder` as context factory
- `register-skill-sources.test.ts` (server-libs) — R2 `addRagCollection` + R3 skill wiring
- `dag.test.ts` (server-libs) — R4 DAG coordinator wiring via builder

`builder-tool-selection.test.ts` and `builder-mcp-failure-logging.test.ts` together pin the
batch/sequential vectorization paths — the primary targets of the R3 extraction. Run these as
the gate before and after `vectorize-mcp-tools.ts` extraction.

**Tests to ADD before refactoring (gaps):**

1. **`vectorizeMcpTools` unit test** — pin the batch path (mock `isBatchEmbedder` + `embedBatch`),
   the sequential fallback (mock `embedBatch` throwing), and the sequential-only path (no batch
   support). Add BEFORE extracting R3 so the characterization exists in the new module from day 1.
2. **`vectorizeSkills` unit test** — pin the skills loop (mock `ISkillManager.listSkills`) including
   the `!result.ok` warning branch. Add alongside #1.

### 5. Suggested PR slices (ordered; lowest-risk first)

| # | Slice | Touches | Rough Δ | Risk | Why here |
|---|---|---|---|---|---|
| 1 | **`builder-types.ts` — extract R1** — create `builder-types.ts` with `BuilderMcpConfig`, `BuilderPromptsConfig`, `SmartAgentBuilderConfig`, `SmartAgentHandle`, `isModelProvider`; `builder.ts` re-exports all; `index.ts` unchanged | R1 | −71 / +80 | **very low** | Pure type-only move; zero runtime behavior change. No import paths change (all consumers use barrel). Pinned by `handle-exposes-rag-registry.test.ts` + `builder-startup-validation.test.ts` (they use the types). Lowest risk first frees subsequent slices from type-refactor noise. |
| 2 | **`vectorize-mcp-tools.ts` — extract R3 (PRIME EXTRACT)** — add characterization tests for `vectorizeMcpTools` + `vectorizeSkills` (gap tests from §4); create `mcp/vectorize-mcp-tools.ts` with both functions; update `build()` to call them; `builder.ts` import added | R3 | −250 / +270 | **low** | Primary tech-debt reduction named in ARCHITECTURE.md. Pinned by `builder-tool-selection.test.ts`, `builder-mcp-failure-logging.test.ts`, `mcp-yaml-vectorization.test.ts`. All existing tests must pass unchanged — function behavior is identical, only location moves. |
| 3 | **Residual cleanup** — remove any dead comments or section separators in `build()` now that R3 is gone; verify `builder.ts` is now ~1170 lines; no logic changes | residual | −10 / +0 | **very low** | Cosmetic. `builder.ts` ends as the fluent builder API (R2) + composition entry point (R4) — the correct final shape. |

Cumulative: `builder.ts` drops from 1437 → ~1170 lines; the two extracted modules are each
under 280 lines, cohesive, individually testable, reusable outside the builder. `vectorize-mcp-tools.ts`
closes the explicit ARCHITECTURE.md tech-debt item.

### 6. Per-blueprint principle self-check

| # | Principle | Compliance of this decomposition |
|---|---|---|
| 1 | **Build ON existing components** | R3 EXTRACT uses catalog interfaces (`IMcpClient`, `IRag`, `IEmbedder`, `isBatchEmbedder`, `IRequestLogger`, `ILogger`, `ISkillManager`) as all parameter types — the extracted functions are thin coordinators of catalog components. R4 KEEP already instantiates 10+ catalog components from `llm-agent` and `llm-agent-libs` (`CircuitBreakerLlm`, `RetryLlm`, `RateLimiterLlm`, `DefaultRequestLogger`, etc.). No bespoke parallel abstractions invented. ✅ |
| 2 | **The app IS the example** | `SmartAgentBuilder` is itself the canonical example of how a consumer assembles a `SmartAgent` from catalog components. After extraction, `build()` becomes a cleaner composition root that delegates vectorization to `vectorize-mcp-tools.ts` — demonstrating the same "compose catalog components" pattern the Architecture Principles mandate. ✅ |
| 3 | **Everything around interfaces** | R3 extracted functions take only catalog interface types as parameters — no concrete class dependencies. R1 types are shapes (not classes). R4 continues wiring concrete implementations behind catalog interfaces (`ISubpromptClassifier`, `IContextAssembler`, `IHistoryMemory`, etc.). ✅ |
| 4 | **Many small interfaces (ISP)** | No existing interface is widened. The extracted `vectorize-mcp-tools.ts` module needs no new interface — function signatures ARE the contract for a pure-function module. `builder-types.ts` adds no new interface; it relocates existing type aliases. ✅ |
| 5 | **Consumer-owned variation = strategies** | R3's vectorization strategy (batch vs. sequential) is already determined by capability detection (`isBatchEmbedder`, `upsertPrecomputedRaw` existence) — extraction preserves this. The `IMcpConnectionStrategy` (which owns reconnect and readiness) is already a consumer-injectable strategy via `withMcpConnectionStrategy()`. No variation point is hardened. ✅ |
| 6 | **Control file size** | Primary objective: 1437 → ~1170 lines (R1 ~−71, R3 ~−250, barrel re-exports ~+54). Extracted modules: `builder-types.ts` ~70 lines, `vectorize-mcp-tools.ts` ~270 lines — both well under 500 lines. The residual `builder.ts` at ~1170 lines does NOT reach the 500-line per-file target; the ~524-line R2 setter block cannot be split without violating Principles 1/3/7 (the 50 one-liner setters are inseparable from the builder's own mutable state — splitting them would require duplicating the class or an awkward mixin with no reuse benefit). Further reduction of the residual is out of scope for this audit pass (one-monolith-per-plan). ✅ |
| 7 | **Don't break components** | All 4 blast-radius importers reach `SmartAgentBuilder`/`SmartAgentHandle` via the `@mcp-abap-adt/llm-agent-libs` barrel; barrel stays unchanged. `BuilderMcpConfig`/`BuilderPromptsConfig`/`SmartAgentBuilderConfig` have no external production importer — those re-exports are optional. Only `builder.ts` itself adds two new internal imports (`./builder-types.js`, `./mcp/vectorize-mcp-tools.js`). Public function signatures of `SmartAgentBuilder.build()` and all 50 setters are byte-stable. Pinned by all 15 existing test suites listed in §4. ✅ |

## Synthesis

### Priority-ordered refactor sequence

The sequence below follows the triage priority ranking exactly (§ Triage — composite score
rationale). Files ranked 1–5 have full component-first decomposition blueprints in this document
and are ready to feed per-monolith refactor plans immediately. Files ranked 6–13 are triaged and
annotated; per the one-monolith-per-plan constraint, their blueprints are deferred until the
higher-priority refactors are underway or complete.

| Rank | File | Blueprint status | Recommended next action |
|---|---|---|---|
| 1 | `llm-agent-server-libs/src/smart-agent/smart-server.ts` (3926 lines) | Full blueprint (§ Blueprint: smart-server.ts) | Open per-monolith refactor plan; start with Slice 1 (`makeKnowledgeBackend` factory) |
| 2 | `llm-agent-libs/src/agent.ts` (2160 lines) | Full blueprint (§ Blueprint: agent.ts) | Open per-monolith refactor plan after smart-server Slices 1–3 land; different package — can interleave |
| 3 | `llm-agent-server-libs/src/smart-agent/config.ts` (1648 lines) | Full blueprint (§ Blueprint: config.ts) | Open per-monolith refactor plan; same package as smart-server — do not run concurrently with smart-server plan |
| 4 | `llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (2026 lines) | Full blueprint (§ Blueprint: controller-coordinator-handler.ts) | Open per-monolith refactor plan; Slice 1 (fix inverted `extractJsonObject` dependency) is safe to start at any time — self-contained, no blast |
| 5 | `llm-agent-libs/src/builder.ts` (1437 lines) | Full blueprint (§ Blueprint: builder.ts) | Open per-monolith refactor plan; Slice 1 (`builder-types.ts` type extraction) is the correct low-risk entry for the builder campaign |
| 6 | `llm-agent-libs/src/pipeline/handlers/tool-loop.ts` (1004 lines) | Triaged; blueprint deferred | Draft blueprint when agent.ts Slice 6 (`runToolLoop` convergence) begins — the two share the convergence target and must be authored together |
| 7 | `llm-agent-libs/src/skills/plugin-host/qdrant-store.ts` (769 lines) | Triaged; blueprint deferred | Draft blueprint after Priority 5 completes; three backends → three focused files is the obvious split direction |
| 8 | `llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` (536 lines) | Triaged; blueprint deferred | Low urgency; the ancestor-context helper is the only separable seam |
| 9 | `llm-agent-libs/src/pipeline/default-pipeline.ts` (542 lines) | Triaged; blueprint deferred | Low urgency; session-registry resolution is the separable seam |
| 10 | `llm-agent-mcp/src/client.ts` (507 lines) | Triaged; blueprint deferred | Coordinate with smart-server.ts R4 MCP rework (that plan executes the R4 catalog-strategy target for `makeConnectionStrategy` adoption) |
| 11 | `sap-aicore-llm/src/sap-core-ai-provider.ts` (554 lines) | Triaged; blueprint deferred | Split `ILlm` and `IEmbedder` implementations into sibling files; straightforward, isolated, low risk |
| 12 | `llm-agent-libs/src/testing/index.ts` (543 lines) | Triaged; not a production concern | Consolidation is by design for the test harness; address only if build-time import impact becomes measurable |
| 13 | `llm-agent-server-libs/src/smart-agent/controller/plan-analysis.ts` (509 lines) | Triaged; relocation target | Move to `scripts/` or `experiments/`; this is a relocation, not a refactor — can be done independently at any time |

### First refactor: the highest-value, lowest-risk starting slice

**Start with: `makeKnowledgeBackend` factory — smart-server.ts Slice 1.**

Extract the 15-line knowledge-backend selector (`SmartServer.buildKnowledgeBackend`, lines
2298–2313 of `smart-server.ts`) into a pure `makeKnowledgeBackend(cfg, embedder)` factory
function in a new `knowledge/` module; `buildKnowledgeBackend` delegates to it. This is
Slice 1 of the Blueprint: smart-server.ts §5.

**Justification against the other Slice-1 candidates:**

| Candidate Slice-1 | Blueprint source (priority) | Risk | Rough Δ | Selecting argument |
|---|---|---|---|---|
| **`makeKnowledgeBackend` factory** ← this pick | smart-server.ts (Priority 1) | very low | −15/+35 | Attacks the largest, highest-scored monolith; pure factory, single field, existing knowledge tests, zero blast. Correct opening move on the priority-1 file. |
| `pipelineToStream` free function | agent.ts (Priority 2) | very low | −60/+75 | Same "very low" risk and a clean adapter — but from Priority 2. Picking it would defer the most-impactful monolith by one plan. |
| `parser.ts` (fix inverted dependency) | controller-coordinator-handler.ts (Priority 4) | very low | −70/+80 | Fixes a real structural defect; but Priority 4 — architectural importance does not outweigh starting on the 3926-line Priority 1 file. |
| `stepper-config.ts` extraction | config.ts (Priority 3) | low | −434/+450 | Largest single-step line reduction of any Slice-1 — but rated "low" (not "very low") and from Priority 3. |
| `builder-types.ts` type move | builder.ts (Priority 5) | very low | −71/+80 | Correct first slice for the builder campaign, but lowest-impact of all candidates; Priority 5. |

`makeKnowledgeBackend` wins on three grounds simultaneously: it is on the highest-priority
monolith (Priority 1, 3926 lines, blast 10), carries the minimum absolute risk of any slice
in the campaign (15-line pure factory, no blast, fully covered by existing `knowledge-backend`
and `jsonl-knowledge-backend` tests), and it concretely demonstrates the EXTRACT pattern the
subsequent smart-server slices (`RoleLlmResolver`, `WorkerRegistry`, `HttpRouteTable`,
`ConfigReloadWatcher`) repeat at progressively larger scale. Opening on a lower-priority
file would defer the biggest payoff; opening on a riskier smart-server slice would skip
the "easiest win first" discipline the PR slice ordering encodes.
