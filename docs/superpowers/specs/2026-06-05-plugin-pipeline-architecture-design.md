# Plugin-Pipeline Architecture — Design

> Status: **design / in-review**, 2026-06-05.
> Supersedes the YAML-mode-driven coordinator selection. Companion baseline:
> [`docs/PIPELINES.md`](../../PIPELINES.md) (catalog of the variants this replaces).

## 1. Core idea

**A pipeline defines which agent we build.** A *pipeline plugin* is the
implementation of an agent variant — a wrapper around the component(s) that
actually realize that variant (flat / linear / dag / stepper / custom). The term
"pipeline" is kept deliberately: it is precisely the thing that determines the
agent's shape.

- `IPipelinePlugin.build(config, ctx)` returns an **`ISmartAgent`** (the existing
  public agent contract — `process` / `streamProcess`). It does **not** introduce
  a new `IPipeline`; the existing `IPipeline`/`DefaultPipeline` lives *inside* the
  agent a plugin builds, untouched.
- Each pipeline **owns its own flow**: how it uses RAG, how it threads a
  per-run **global context** (an accumulator that components write to and the
  finalizer reads), how its roles interact. The host does not prescribe the flow.
- The **plugin system exists for one purpose: dynamically loading agent variants
  into the server** (the default host). Code-embedders bypass it entirely and
  import components directly.

## 2. Motivation

The pipeline catalog ([`docs/PIPELINES.md`](../../PIPELINES.md)) established that:

1. **The flow is hardcoded, not described.** YAML supplies only component-variant
   selection + parameters + plan-node data; the orchestration lives in
   `Stepper.run` / `StepperInterpreter` and the coordinator handlers (which run as
   the `coordinator` *stage* inside `DefaultPipeline`). A consumer cannot describe
   a *different* role interaction — only tune knobs inside one baked schema.
2. **YAML is a millstone for anything non-trivial** — dependency graphs,
   per-component implementation choice, multi-process interaction. These are
   code-composition concerns, not declarative-config concerns.
3. **There are really ~4 flows + 1 leaf loop.** What looks like ~10 pipelines is
   parametric permutation over `flat`/`linear`/`dag`/`stepper` on one ReAct loop.

The execution engine is already agnostic (works through `IStepperPlanner` /
`IExecutor` / … interfaces); the build layer is a closed switch over enum strings.
The foundation is right; the *entry* is wrong. We replace the entry: each agent
variant becomes a pipeline plugin that owns its flow.

## 3. Goals / Non-goals

**Goals**

- A pipeline plugin = an agent-variant implementation, wrapping the component(s)
  that realize it, exposed as an `ISmartAgent`.
- The plugin system loads agent variants **dynamically into the server**; the
  server is the default host. Built-ins are statically present in it.
- **Two entry points into one library:** the plugin system (server, dynamic) and
  direct code import (embedders compose by hand, no plugin system).
- **Clean break:** no backward-compat for the old YAML dialect; old behavior stays
  on npm at versions ≤ 18.
- One launcher runs any pipeline — uniform, swap-by-name testing.

**Non-goals (this spec)**

- Composable orchestration *expressed in YAML* (flow is expressed in plugin code).
- External-tool suspend/resume (becomes a pipeline-internal concern, designed
  separately).
- Rewriting the ReAct executor or proven leaf components; rewriting `DefaultPipeline`.

## 4. Architecture

### 4.1 Layering (respects the existing dependency order)

```
llm-agent-server          DEFAULT HOST: parse YAML → resolve pipeline by name →
                          build(config, ctx) → ISmartAgent (once) → streamProcess
                          per request. Statically registers the built-ins; collects
                          dynamically-loaded ones from PluginExports.pipelinePlugins.
llm-agent-server-libs     PIPELINE PLUGINS: built-in IPipelinePlugin wrappers
                          (flat / linear / dag / stepper). Legacy components
                          relocated under the `legacy/*` subpath.
llm-agent-libs            Components: SmartAgent, DefaultPipeline, ReAct executor,
                          planner/reviewer/evaluator/finalizer, Stepper, coordinator
                          handlers — still exported for direct code use.
llm-agent (contracts)     IPipelinePlugin, IPipelineContext; reuses ISmartAgent.
```

### 4.2 Two entry points into one library

| Entry | Consumer | How |
|---|---|---|
| **Pipeline plugin (dynamic)** | server / deployment | `pipeline: { name, config }`; host resolves a built-in or dynamically-loaded plugin |
| **Direct import** | embedder composing in code | `import { Stepper, DagCoordinatorHandler, … }` (or `legacy/*`) and wire an agent by hand — no plugin system |

## 5. The contract (in `@mcp-abap-adt/llm-agent`)

```ts
/** Infra handles the host provides to a pipeline. NOT the flow — the pipeline
 *  owns its flow. This is the SmartAgentBuilder/PipelineDeps surface: the host
 *  builds these once and hands the same set to every pipeline. */
export interface IPipelineContext {
  // LLM (per-role)
  makeLlm(cfg: SmartServerLlmConfig): Promise<ILlm>;
  llmMap?: NormalizedLlmMap;
  pipelineFallback?: SmartServerLlmConfig;
  // RAG handles (the pipeline decides how to USE them; stores owned by the host)
  knowledgeRagFor(sessionId: string): IKnowledgeRagHandle;
  toolsRag: IToolsRagHandle;
  ragRegistry?: IRagRegistry;
  // MCP / tools
  callMcp(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  mcpClients?: IMcpClient[];
  // cross-cutting services (optional — present when the host configures them)
  sessionManager?: ISessionManager;
  tracer?: ITracer;
  metrics?: IMetrics;
  logger?: ILogger;
  toolCache?: IToolCache;
  toolPolicy?: IToolPolicy;
  outputValidator?: IOutputValidator;
  // composition helpers
  subagents?: ReadonlyArray<{ name: string; description?: string }>;
  mintStepperId(): string;
  logLlmCall?(entry: LlmCallEntry): void;
}

/** A pipeline plugin = the implementation of an agent variant. It names itself,
 *  validates its own config dialect, and builds the agent (a wrapper around the
 *  component that realizes the variant). */
export interface IPipelinePlugin<Config = unknown> {
  readonly name: string;                       // = YAML `pipeline.name`
  parseConfig(raw: unknown): Config;           // YAML block → typed (+ validation error)
  build(config: Config, ctx: IPipelineContext): Promise<ISmartAgent>;
}
```

**The agent a pipeline builds** is the existing `ISmartAgent`
(`process` / `streamProcess`). No new runnable interface, no `IPipeline` collision.

**Each pipeline owns its flow.** Inside `build`, a pipeline wires its own
orchestration over the `ctx` handles, including a **per-run global context** — an
accumulator that the flow's components write to and the finalizer consumes. The
built-ins reuse the existing pattern for this (knowledge-RAG entries carry rich
metadata; the finalizer queries by `turnId`) plus the shared token ledger. A
custom pipeline may implement its own accumulator. The host never sees it.

## 6. Built-in pipelines (in `llm-agent-server-libs`)

The four variants become **thin `IPipelinePlugin` wrappers** over the existing
components — orchestration is *not* rewritten, only re-packaged as agent builders.

```ts
// llm-agent-server-libs/src/pipelines/dag.ts
export class DagPipelinePlugin implements IPipelinePlugin<DagConfig> {
  readonly name = 'dag';
  parseConfig(raw: unknown): DagConfig { /* validate the dag dialect */ }
  async build(cfg: DagConfig, ctx: IPipelineContext): Promise<ISmartAgent> {
    // compose a SmartAgent whose pipeline uses the DAG coordinator over ctx handles
    return buildDagAgent(cfg, ctx);
  }
}
```

Built-ins: `flat`, `linear`, `dag`, `stepper`. New variants (e.g.
*planner+reviewer → controller+executor*) are new pipeline plugins added
alongside — composing existing or new components — without touching the host.

## 7. Dynamic loading & host (in `llm-agent-server`)

The plugin system's sole purpose is loading agent variants **into the server**.
It rides the existing plugin loader by adding one field to `PluginExports`:

```ts
// @mcp-abap-adt/llm-agent — PluginExports (existing) gains:
export interface PluginExports {
  // …existing: stageHandlers, adapters, embedderFactories, skillManager, …
  /** Agent-variant pipelines contributed by a dynamically-loaded plugin. */
  pipelinePlugins?: Record<string, IPipelinePlugin>;
}
```

- `PluginExports` (stageHandlers, adapters, skills) extends an agent's **internals**;
  `pipelinePlugins` contributes **whole agent variants**. The two levels compose:
  a built-in pipeline's internal `DefaultPipeline` still consumes
  `stageHandlers` from loaded plugins.
- The host builds the registry = built-ins (static) + every loaded
  `pipelinePlugins`. Duplicate name → fail-fast.

```ts
const reg = new Map<string, IPipelinePlugin>();        // built-ins + loaded pipelinePlugins
const plugin = reg.get(yaml.pipeline.name) ?? failUnknown(yaml.pipeline.name, [...reg.keys()]);
const cfg    = plugin.parseConfig(yaml.pipeline.config);  // throws → fail-fast (which field)
const agent  = await plugin.build(cfg, ctx);              // throws → server does not start
// per request:
for await (const chunk of agent.streamProcess(input, options)) yield chunk;  // signal cancels through
```

- **Resolution:** unknown name → error listing available names; `parseConfig`
  throw → fail-fast naming the field; `build` throw (e.g. LLM/RAG unavailable) →
  startup error, server does not come up with a broken pipeline.
- **Lifecycle:** `build` once (startup); requests via `streamProcess`. Config
  change → **recreate** the agent. Runtime LLM hot-swap uses the existing
  `SmartAgent.reconfigure()`; `rebuildStages?` / `reconfigure?` stay internal to
  the agent's `IPipeline` (unchanged). No new lifecycle surface on the plugin.
- **State ownership:** the **agent owns** its pipeline, its per-run global context,
  and uses the host-owned infra stores via handles (`knowledgeRagFor(sessionId)`,
  `toolsRag`, `ragRegistry`, `sessionManager`). The **host** holds only the
  pipeline registry and the infra stores; it keeps no per-request state.
  `identity.sessionId` is the key the agent uses against those handles.

## 8. Legacy namespace (`legacy/*` via subpath exports)

Old orchestration is **physically relocated** to `src/legacy/<flow>.ts` so the new
tree stays clean; exposed via ESM subpath exports. New code claims the root +
`./<flow>`; old code retreats to `./legacy/<flow>`.

```jsonc
// llm-agent-server-libs/package.json — "exports"
{
  ".":               "./dist/index.js",            // new pipeline plugins (barrel)
  "./dag":           "./dist/pipelines/dag.js",
  "./stepper":       "./dist/pipelines/stepper.js",
  "./linear":        "./dist/pipelines/linear.js",
  "./flat":          "./dist/pipelines/flat.js",
  "./legacy/dag":     "./dist/legacy/dag.js",
  "./legacy/stepper": "./dist/legacy/stepper.js",
  "./legacy/linear":  "./dist/legacy/linear.js",
  "./legacy/flat":    "./dist/legacy/flat.js"
}
```

```ts
import { DagPipelinePlugin }    from '@mcp-abap-adt/llm-agent-server-libs/dag';         // new
import { DagCoordinatorHandler } from '@mcp-abap-adt/llm-agent-server-libs/legacy/dag';  // old
```

- Same/identical class names do not collide — the subpath separates them.
- Each `legacy/<flow>` is a curated bundle re-exporting the low-level classes a
  consumer needs to reconstruct that flow by hand (the underlying classes in
  `llm-agent-libs` remain exported there for finer-grained use).

## 9. YAML shape + responsibility split

Thin envelope: server infra at the top (consumed by the host to build the
`IPipelineContext`), one `pipeline` block (selects the agent variant + its params).

```yaml
# server infra — the HOST consumes this to build IPipelineContext
llm:
  main:    { provider: deepseek,   model: deepseek-chat }
  planner: { provider: sap-ai-sdk, model: anthropic--claude-4-sonnet }
mcp:
  type: stream-http
  endpoint: http://localhost:4004/mcp/stream/http
rag:
  type: qdrant
  embedder: ollama
subagents:
  - { name: reviewer, description: "checks completeness" }

# the ONLY pipeline-facing block — defines which agent we build
pipeline:
  name: dag                 # resolved in the plugin registry (built-in or loaded)
  config:                   # handed verbatim to plugin.parseConfig()
    finalizer: llm
    maxParallelSteps: 4
```

| Block | Validated/consumed by | Becomes |
|---|---|---|
| `llm` / `mcp` / `rag` / `subagents` | **host** | `IPipelineContext` (LLM roles, RAG handles, MCP, sessions, …) |
| `pipeline.name` | **host** | registry lookup; unknown → fail-fast with available names |
| `pipeline.config` | **plugin** (`parseConfig`) | typed, flow-specific config owned by the pipeline |

## 10. Testing

- **Generic host = one launcher:** the same binary serves any pipeline — change
  `pipeline.name` in YAML, no rebuild. The existing `roundtrip.mjs` generalizes to
  a pipeline-name parameter.
- **Pipeline unit test without a server:** `ctx` is an interface, trivially
  stubbed. `plugin.parseConfig(fixture)` → `build(stubCtx)` → drive
  `streamProcess()` with fake LLM/MCP → assert the stream. No HTTP, no process.
- **Conformance test over the registry:** one test iterates every registered
  pipeline — each must `parseConfig` a minimal config, `build` an `ISmartAgent`,
  and `streamProcess` a trivial request producing a valid stream. New pipelines
  are covered automatically.

## 11. Migration (clean break)

- The old YAML `coordinator:` dialect and the structured-pipeline `StageDefinition`
  DSL are **removed** in the new major; no compat shim.
- Consumers needing the old behavior pin a version **≤ 18** on npm.
- The components that implemented the old flows **remain exported** (relocated to
  `legacy/*`); consumers import them **directly, in code, without YAML**.
- Removed: `coordinator:` parsing in `config.ts`; the handler-selection switch in
  `pipeline/handlers/index.ts`. Replaced by the pipeline registry in the host.
- Added: `IPipelinePlugin` / `IPipelineContext` in `llm-agent` + `pipelinePlugins`
  on `PluginExports`; built-in pipelines + `legacy/*` exports in
  `llm-agent-server-libs`; registry + dynamic-load wiring in `llm-agent-server`.
- This is a **major** lockstep bump.

## 12. Future (out of scope here)

- **Novel flows as pipeline plugins** — the *planner+reviewer → controller+executor*
  "node = process" idea is realized as a new pipeline plugin, validating that the
  contract is expressive enough beyond the four built-ins.
- **External-tool suspend/resume** — revisited as a pipeline-internal concern (a
  pipeline may hold a live continuation across a consumer round-trip), not a
  cross-cutting feature.
```
