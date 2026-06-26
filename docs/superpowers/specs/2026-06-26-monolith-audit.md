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
