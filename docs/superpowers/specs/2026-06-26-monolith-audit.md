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

**Priority ordering rationale:** Priority is ranked by a composite score — `lines × #responsibilities × √(blast_radius + 1) × componentFit_multiplier` — where `componentFit_multiplier` is 1.5 for a clean catalog map (known landing zone = low design uncertainty), 1.0 for partial fit, 0.7 for test/harness files. High blast amplifies value (more consumers benefit) and large line count proxies refactor effort. Priority 1 = highest composite score = do first.

**Blast radius** = count of non-test files that import the module directly (by `.js` path in ESM imports); self-imports excluded.

| File / lines | Responsibilities (count · names) | Principle violated | Split risk | Blast radius | Driver (why it grew) | Priority |
|---|---|---|---|---|---|---|
| `llm-agent-server-libs/src/smart-agent/smart-server.ts` · 3926 | 6 — HTTP request routing, worker/sub-agent lifecycle, session lifecycle, MCP client init, LLM/embedder factory, knowledge-backend construction | SRP: HTTP server, agent orchestration, session management, infra wiring in one god-class | high | 10 | Every new HTTP endpoint and server feature accumulated in the single class with no extraction discipline | 1 |
| `llm-agent-libs/src/agent.ts` · 2160 | 6 — LLM request orchestration (process/stream), tool selection + revectorization, session CRUD, history management + summarization, subprompt classification, health-check coordination | SRP: runtime execution, tool catalog, session state, history, classification are orthogonal concerns | high | 20 | Every new agent capability landed in `SmartAgent` without extraction; highest fan-in in the codebase | 2 |
| `llm-agent-server-libs/src/smart-agent/config.ts` · 1648 | 6 — YAML loading + env-var resolution, LLM config normalization, coordinator/dispatch config resolution, stepper coordinator config parsing, finalizer building, config-template generation | SRP: loader, LLM resolver, pipeline resolvers, template generator are separate concerns | med | 8 | Each new pipeline type added its own parser inline; no per-pipeline config module discipline | 3 |
| `llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` · 2026 | 5 — controller execution loop (planner→executor→reviewer→finalizer), step-state board rendering, run-scoped artifact recall, tool-call normalization utilities, plan JSON parsing helpers | SRP: stage handler mixed with recall logic, JSON parsers, and board renderer | med | 4 | Controller grew stage-by-stage with recovery paths and helpers added inline; no extraction for utilities | 4 |
| `llm-agent-libs/src/builder.ts` · 1437 | 4 — `SmartAgentBuilder` fluent wiring (LLM + RAG + MCP → agent), `SmartAgentHandle` type definitions, retrieval-source construction, MCP/prompts config types | SRP: builder logic, handle/config type definitions, retrieval wiring are separable | med | 4 | Fluent builder accumulated all wiring logic and type definitions as features were added | 5 |
| `llm-agent-libs/src/pipeline/handlers/tool-loop.ts` · 1004 | 5 — tool-loop stage execution, streaming tool-call assembly, tool result processing + error mapping, external tool-call bridging, tool availability tracking | SRP: execution loop, streaming, error mapping, external bridge are distinct concerns | low | 1 | Single handler grew to absorb all tool-call mechanics including streaming and external bridge | 6 |
| `llm-agent-libs/src/skills/plugin-host/qdrant-store.ts` · 769 | 4 — Qdrant REST client + reader, Postgres catalog store, in-process catalog store, catalog generation lifecycle (upsert/sweep/carry-forward) | SRP: three storage backends + lifecycle management collocated | low | 1 | Multiple backends added to one file for convenience; no per-backend file discipline | 7 |
| `sap-aicore-llm/src/sap-core-ai-provider.ts` · 554 | 5 — SAP AI Core LLM provider (chat), SAP AI Core embedding provider, model-list retrieval, message format translation, HTTP client management | SRP: `ILlm` and `IEmbedder` are separate interfaces; provider mixes both plus client plumbing | low | 1 | SAP AI Core SDK exposes both LLM and embedding; both were implemented in one convenience class | 8 |
| `llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` · 536 | 3 — DAG step execution (topological sort + parallel dispatch), ancestor-context building, node output collection | SRP: mostly cohesive; ancestor-context helper is separable | low | 4 | DAG execution complexity grew organically; ancestor-context helper added inline | 9 |
| `llm-agent-libs/src/pipeline/default-pipeline.ts` · 542 | 3 — `DefaultPipeline` stage execution, session-registry resolution, stage + context construction | SRP: mild; session-registry resolution is separable from pipeline execution | low | 2 | Pipeline stage complexity grew as session handling was added directly | 10 |
| `llm-agent-libs/src/testing/index.ts` · 543 | 5 — mock LLM factories, mock RAG factories, mock MCP client, mock logging/tracing infra, mock session + deps builders | SRP: all test fixtures in one file (by design for convenience, not a production concern) | low | 0 | Test harness consolidated for ease of import; no production blast | 11 |
| `llm-agent-mcp/src/client.ts` · 507 | 4 — MCP connection lifecycle (connect/disconnect/retry), transport detection + setup (stdio/sse/stream-http/embedded), tool listing, tool calling (single + batch) | SRP: transport negotiation and tool operations are separable; otherwise cohesive | low | 3 | Natural growth of a single-class MCP client; just crossed the threshold | 12 |
| `llm-agent-server-libs/src/smart-agent/controller/plan-analysis.ts` · 509 | 2 — dev evaluation harness (live/stub LLM modes), plan-quality analysis runner | Wrong location: dev eval harness shipped in production source tree, not a library concern | low | 0 | Eval harness developed inline with the controller and never extracted to scripts/ | 13 |
