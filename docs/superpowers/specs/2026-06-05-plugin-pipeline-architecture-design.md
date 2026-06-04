# Plugin-Pipeline Architecture — Design

> Status: **design / approved-in-brainstorm**, 2026-06-05.
> Supersedes the YAML-mode-driven coordinator selection. Companion baseline:
> [`docs/PIPELINES.md`](../../PIPELINES.md) (catalog of the variants this replaces).

## 1. Motivation

The pipeline catalog established three structural ceilings shared by every
current variant:

1. **The flow is hardcoded, not described.** YAML supplies only component-variant
   selection + parameters + plan-node data; the orchestration algorithm
   (`evaluate → plan → review → walk-DAG → finalize`) lives in `Stepper.run` /
   `StepperInterpreter` and the coordinator handlers. A consumer cannot describe
   a *different* interaction of roles — only tune knobs inside one baked schema.
2. **YAML is a millstone for anything non-trivial** — dependency graphs,
   per-component implementation choice, multi-process interaction, suspend/resume
   all fight the declarative surface. These are code-composition concerns.
3. **There are really only ~4 orchestration flows + 1 leaf loop.** What looks
   like ~10 pipelines is mostly parametric permutation over `flat`, `linear`,
   `dag`, `stepper`, all sitting on one ReAct tool-loop. The proliferation is
   config masquerading as architecture.

The build layer (`build-stepper-root`) is a **closed switch** over enum strings
that maps to hardcoded classes — so YAML can only *select among built-in*
implementations, never bring its own. The execution engine, however, is already
agnostic (it works purely through `IStepperPlanner`/`IExecutor`/… interfaces).

**Conclusion:** the foundation (agnostic engine behind interfaces) is right; the
*entry* is wrong. We replace the entry with a plugin model.

## 2. Goals / Non-goals

**Goals**

- A **pipeline is a plugin**: one named component owning its entire flow and its
  own config dialect.
- The **host is generic**: it parses YAML, resolves a plugin by name, builds it
  once with a dependency container, and streams it per request. The host knows
  nothing about steps, nodes, or modes.
- **Two entry points into one library:** declarative (YAML → plugin) for the
  server; direct code import for embedders who compose by hand.
- **Clean break:** no backward-compat for the old YAML dialect. The old behavior
  remains available on npm at versions ≤ 18.
- **One launcher** runs any pipeline — uniform, swap-by-name testing.

**Non-goals (this spec)**

- Composable orchestration *expressed in YAML* (explicitly rejected — flow is
  expressed in plugin code).
- External-tool suspend/resume. It becomes a concern *internal to a plugin*, not
  a cross-cutting pipeline feature; designed separately if/when needed.
- Rewriting the ReAct executor or the proven leaf components.

## 3. Architecture

### 3.1 Layering (respects the existing dependency order)

```
llm-agent-server          HOST: parse YAML → resolve plugin by name →
                          build(config, ctx) once → stream run(req) per request.
                          Registers the 4 built-ins at startup.
llm-agent-server-libs     PLUGINS: 4 built-in IPipelinePlugin adapters
                          (flat / linear / dag / stepper). Legacy components
                          relocated under the `legacy/*` subpath.
llm-agent-libs            Execution components (ReAct executor, planner,
                          reviewer, evaluator, finalizer, Stepper, handlers) —
                          still exported for fine-grained direct use.
llm-agent (contracts)     IPipelinePlugin, IPipeline, IPipelineContext,
                          IPipelineRequest — pure interfaces.
```

### 3.2 Two entry points into one library

| Entry | Consumer | How |
|---|---|---|
| **YAML → plugin** | server / typical deployment | `pipeline: { name, config }` → host resolves a registered plugin |
| **Direct import** | embedder composing in code | `import { DagCoordinatorHandler, CyclicReActExecutor } from '…'` and wire by hand, no YAML |

## 4. The contract (in `@mcp-abap-adt/llm-agent`)

Two-phase: **build once** (startup, from config + deps) → **run per request**
(stream). Generalizes the existing handler I/O and `BuildStepperRootInput`.

```ts
/** Runtime DI container — everything a plugin needs to build itself.
 *  This is today's BuildStepperRootInput, generalized and without coordCfg. */
export interface IPipelineContext {
  makeLlm(cfg: SmartServerLlmConfig): Promise<ILlm>;
  llmMap?: NormalizedLlmMap;                 // per-role LLM
  pipelineFallback?: SmartServerLlmConfig;
  knowledgeRagFor(sessionId: string): IKnowledgeRagHandle;
  toolsRag: IToolsRagHandle;
  callMcp(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  subagents?: ReadonlyArray<{ name: string; description?: string }>;
  mintStepperId(): string;
  logLlmCall?(entry: LlmCallEntry): void;
}

/** One request through the pipeline — today's handler input. */
export interface IPipelineRequest {
  messages: Message[];
  externalTools?: ExternalToolDef[];
  identity: { sessionId: string; stepperId: string };
  budget?: BudgetInput;
  signal?: AbortSignal;
  sessionLogger?: ISessionLogger;
  onProgress?: (event: StreamChunk) => void;
}

/** A built, runnable pipeline — one per server config. */
export interface IPipeline {
  run(req: IPipelineRequest): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>;
}

/** The plugin: names itself, validates its own config, builds the pipeline. */
export interface IPipelinePlugin<Config = unknown> {
  readonly name: string;                       // = YAML `pipeline.name`
  parseConfig(raw: unknown): Config;           // YAML block → typed (+ validation error)
  build(config: Config, ctx: IPipelineContext): Promise<IPipeline>;
}
```

**Key properties**

- A plugin *fully owns* its flow and its config; the host knows neither.
- `parseConfig` keeps flow-specific validation **inside** the plugin; the host
  stays agnostic of every flow's YAML dialect.
- `build`/`run` are separate → one build, many requests; streaming uses the
  existing type.

## 5. Built-in plugins (in `llm-agent-server-libs`)

The four flows become **thin `IPipelinePlugin` adapters** over the existing
handlers — orchestration is *not* rewritten, only re-packaged at the entry.

```ts
// llm-agent-server-libs/src/pipelines/dag.ts
export class DagPipelinePlugin implements IPipelinePlugin<DagConfig> {
  readonly name = 'dag';
  parseConfig(raw: unknown): DagConfig { /* validate the dag dialect */ }
  async build(cfg: DagConfig, ctx: IPipelineContext): Promise<IPipeline> {
    const handler = new DagCoordinatorHandler(/* assembled from cfg + ctx */);
    return { run: (req) => handler.handle(req) };   // delegate to the handler
  }
}
```

Built-ins: `flat`, `linear`, `dag`, `stepper`. Each is registered at host
startup. New flows (e.g. *planner+reviewer → controller+executor*) are new
plugins added alongside — composing existing or new components — without
touching the host.

## 6. Legacy namespace (`legacy/*` via subpath exports)

Old orchestration is **physically relocated** to `src/legacy/<flow>.ts` so the
new tree stays clean; exposed via ESM subpath exports. New code claims the root
+ `./<flow>`; old code retreats to `./legacy/<flow>`.

```jsonc
// llm-agent-server-libs/package.json — "exports"
{
  ".":              "./dist/index.js",            // new plugins (barrel)
  "./dag":          "./dist/pipelines/dag.js",
  "./stepper":      "./dist/pipelines/stepper.js",
  "./linear":       "./dist/pipelines/linear.js",
  "./flat":         "./dist/pipelines/flat.js",
  "./legacy/dag":     "./dist/legacy/dag.js",
  "./legacy/stepper": "./dist/legacy/stepper.js",
  "./legacy/linear":  "./dist/legacy/linear.js",
  "./legacy/flat":    "./dist/legacy/flat.js"
}
```

```ts
import { Dag }                   from '@mcp-abap-adt/llm-agent-server-libs/dag';         // new
import { DagCoordinatorHandler } from '@mcp-abap-adt/llm-agent-server-libs/legacy/dag';  // old
```

- Same/identical class names do not collide — the subpath separates them.
- Each `legacy/<flow>` is a **curated bundle**: it re-exports the low-level
  classes a consumer needs to reconstruct that flow by hand (the underlying
  classes in `llm-agent-libs` remain exported there for finer-grained use).

## 7. YAML shape + responsibility split

Thin envelope: server infra at the top (consumed by the host), one `pipeline`
block (plugin selection + its params).

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

# the ONLY pipeline-facing block
pipeline:
  name: dag                 # resolved in the plugin registry
  config:                   # handed verbatim to plugin.parseConfig()
    finalizer: llm
    maxParallelSteps: 4
```

```yaml
pipeline:
  name: stepper
  config:
    planner:   { type: llm, granularity: detailed }
    executor:  { type: cyclic-react }
    evaluator: { enabled: true, atDepths: [0] }
    reviewer:  { atDepths: [0] }
    finalizer: { type: llm }
```

| Block | Validated/consumed by | Becomes |
|---|---|---|
| `llm` / `mcp` / `rag` / `subagents` | **host** | `IPipelineContext` (makeLlm, callMcp, knowledgeRagFor, toolsRag, subagents) |
| `pipeline.name` | **host** | registry lookup; unknown → fail-fast with available names |
| `pipeline.config` | **plugin** (`parseConfig`) | typed, flow-specific config |

The host validates shared infra **once** and hands every plugin the same `ctx`;
a plugin never learns where the LLM/RAG came from. Flow-specific keys are owned
entirely by the plugin.

## 8. Host behavior & errors (in `llm-agent-server`)

```ts
const reg = new Map<string, IPipelinePlugin>();    // built-ins registered at startup
register(reg, new FlatPipelinePlugin());
register(reg, new LinearPipelinePlugin());
register(reg, new DagPipelinePlugin());
register(reg, new StepperPipelinePlugin());

const plugin = reg.get(yaml.pipeline.name) ?? failUnknown(yaml.pipeline.name, [...reg.keys()]);
const cfg    = plugin.parseConfig(yaml.pipeline.config);   // throws → fail-fast (which field)
const pipe   = await plugin.build(cfg, ctx);               // throws → server does not start
// per request:
for await (const chunk of pipe.run(req)) yield chunk;      // req.signal cancels through
```

- **Registry:** built-ins registered at startup; embedders register custom
  plugins *before* startup; duplicate name on register → fail-fast.
- **Resolution:** missing name → error listing available names; `parseConfig`
  throw → fail-fast naming the field; `build` throw (e.g. LLM/RAG unavailable) →
  startup error, server does not come up with a broken pipeline.
- **Lifecycle:** `build` once (startup); `run` per request; cancellation via
  `req.signal` end-to-end. The host holds no inter-request state.

## 9. Testing

- **Generic host = one launcher:** the same binary serves any plugin — change
  `pipeline.name` in YAML, no rebuild. The existing `roundtrip.mjs` generalizes
  to a pipeline-name parameter.
- **Plugin unit test without a server:** `ctx` is an interface, trivially
  stubbed. `plugin.parseConfig(fixture)` → `build(stubCtx)` → drive `run()` with
  fake LLM/MCP → assert the stream. No HTTP, no process.
- **Conformance test over the registry:** one test iterates every registered
  plugin — each must `parseConfig` a minimal config, `build`, and `run` a trivial
  request producing a valid stream. New plugins are covered automatically.

## 10. Migration (clean break)

- The old YAML `coordinator:` dialect is **removed** in the new major; no compat
  shim ("a wrapper would be a suitcase without a handle").
- Consumers needing the old behavior pin a version **≤ 18** on npm.
- The components that implemented the old flows **remain exported** (relocated to
  `legacy/*`); consumers who want them import them **directly, in code, without
  YAML**.
- Removed: `coordinator:` parsing in `config.ts`; the handler-selection switch in
  `pipeline/handlers/index.ts`. Replaced by the plugin registry in the binary.
- Added: the contract in `llm-agent`; 4 built-in plugins + `legacy/*` exports in
  `llm-agent-server-libs`; registry + host loop in `llm-agent-server`.
- This is a **major** lockstep bump.

## 11. Future (out of scope here)

- **Composable orchestration as a first-class plugin pattern** — the
  *planner+reviewer → controller+executor* "node = process" idea is realized as
  *a new plugin*, validating that the contract is expressive enough for flows
  beyond the four built-ins.
- **External-tool suspend/resume** — revisited as a plugin-internal concern (a
  plugin may hold a live continuation), not a pipeline-wide feature.
