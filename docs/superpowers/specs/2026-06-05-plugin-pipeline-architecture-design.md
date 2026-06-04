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

- `IPipelinePlugin.build(config, ctx)` returns an **`IPipelineInstance`** — the
  runnable `ISmartAgent` (`process` / `streamProcess`) plus a `close()` disposal
  contract. It does **not** introduce a new `IPipeline`; the existing
  `IPipeline`/`DefaultPipeline` lives *inside* the
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
  that realize it, exposed as an `IPipelineInstance` (the `ISmartAgent` + `close()`).
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
                          build(config, ctx) → IPipelineInstance (once) → streamProcess
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

The contract lives in core `@mcp-abap-adt/llm-agent` (so the existing plugin
loader, `PluginExports` and `LoadedPlugins` — all core — can carry it; see §7).
Therefore it must reference **only core types**. Server-specific config
(`SmartServerLlmConfig`, `NormalizedLlmMap`) and libs-only services
(`IToolPolicy`, `ISessionManager`, `ITracer`, …) **must not** leak into core. LLM
provisioning is exposed as an **opaque per-role resolver**; the server hides its
config behind it.

```ts
/** Infra handles the host provides to a pipeline. NOT the flow — the pipeline
 *  owns its flow. Core-only types; the server hides its config behind resolveLlm. */
export type MaybePromise<T> = T | Promise<T>;   // NEW core export (see §11)

export interface IPipelineContext {
  // LLM — opaque, per role. The server closes over SmartServerLlmConfig/llmMap.
  resolveLlm(role: string): Promise<ILlm>;
  // RAG handles (the pipeline decides how to USE them; stores owned by the host).
  // MaybePromise: a session-scoped store may need async init (see F4).
  knowledgeRagFor(sessionId: string): MaybePromise<IKnowledgeRagHandle>;
  // Always present: the host supplies an EMPTY IToolsRagHandle when no tools RAG
  // is configured, so the contract stays stable for no-RAG/no-MCP deployments.
  toolsRag: IToolsRagHandle;
  ragRegistry?: IRagRegistry;
  // MCP / tools
  callMcp(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  mcpClients?: IMcpClient[];
  // composition helpers (core types only)
  subagents?: ReadonlyArray<{ name: string; description?: string }>;
  mintStepperId(): string;
  logger?: ILogger;
  logLlmCall?(entry: LlmCallEntry): void;
}

/** A pipeline plugin = the implementation of an agent variant. It names itself,
 *  validates its own config dialect, and builds the agent (a wrapper around the
 *  component that realizes the variant). */
export interface IPipelinePlugin<Config = unknown> {
  readonly name: string;                       // = YAML `pipeline.name`
  parseConfig(raw: unknown): Config;           // YAML block → typed (+ validation error)
  build(config: Config, ctx: IPipelineContext): Promise<IPipelineInstance>;
}

/** What build() hands back: the runnable agent + a disposal contract so the host
 *  can free MCP / RAG / session resources on recreate or shutdown (F2). */
export interface IPipelineInstance {
  readonly agent: ISmartAgent;
  close(): Promise<void>;                       // may be a no-op; required so recreate never leaks
}
```

**Server-side richer context (in `llm-agent-server-libs`).** Built-in pipelines
need libs/server services beyond the core set. The host passes a subtype; a
third-party plugin codes against the portable core `IPipelineContext`, while
built-ins downcast to use the extras:

```ts
// llm-agent-server-libs
export interface IServerPipelineContext extends IPipelineContext {
  sessionManager?: ISessionManager;
  tracer?: ITracer;
  metrics?: IMetrics;
  toolCache?: IToolCache;
  toolPolicy?: IToolPolicy;
  outputValidator?: IOutputValidator;
  /**
   * A SmartAgentBuilder PRE-WIRED with all shared infra (RAG, MCP, embedder,
   * adapters, request-logger, subagents, options, hot-reload) — everything
   * EXCEPT the coordinator. The pipeline only registers its coordinator and
   * builds. This is the host-owns-assembly decision: a built-in variant differs
   * from another ONLY by which coordinator stage handler it wires, so the host
   * assembles everything else once and hands it over, avoiding per-plugin
   * duplication (and the resulting loss of RAG/adapters/logger/subagents).
   */
  createAgentBuilder(): Promise<SmartAgentBuilder>;
}
```

`SmartAgentBuilder` lives in `llm-agent-libs`, so `createAgentBuilder` sits on the
server-libs `IServerPipelineContext`, not the core `IPipelineContext` — keeping
core free of libs types. Every pipeline plugin builds a `SmartAgent`, so it
depends on server-libs and uses `IServerPipelineContext` anyway.

**The agent inside the instance** is the existing `ISmartAgent`
(`process` / `streamProcess`). No new runnable interface, no `IPipeline` collision.
The built-ins wrap their `SmartAgentHandle` — `{ agent: handle.agent, close:
handle.close }` — so `close()` reuses the handle's existing graceful MCP shutdown.

**Runtime hot-swap is optional (F1).** `ISmartAgent` exposes only `process`/
`streamProcess`; `reconfigure()` lives on the concrete `SmartAgent`. A host typed
on the contract cannot call it without a cast. Resolution: a small core interface

```ts
export interface IReconfigurableSmartAgent extends ISmartAgent {
  reconfigure(update: { mainLlm?: ILlm; helperLlm?: ILlm; classifierLlm?: ILlm }): void;
}
```

On LLM hot-swap the host feature-detects `instance.agent`: if it satisfies
`IReconfigurableSmartAgent`, it calls `reconfigure()`; otherwise it calls
`instance.close()` and **recreates** (the lifecycle fallback in §7). The built-ins
return the concrete `SmartAgent`, which already satisfies it; custom plugins that
do not implement it simply get close-then-recreate.

**Each pipeline owns its flow.** Inside `build`, a pipeline wires its own
orchestration over the `ctx` handles, including a **per-run global context** — an
accumulator that the flow's components write to and the finalizer consumes. The
built-ins reuse the existing pattern for this (knowledge-RAG entries carry rich
metadata; the finalizer queries by `turnId`) plus the shared token ledger. A
custom pipeline may implement its own accumulator. The host never sees it.

## 6. Built-in pipelines (in `llm-agent-server-libs`)

The four variants become **thin `IPipelinePlugin` wrappers** over the existing
components — orchestration is *not* rewritten, only re-packaged as agent builders.

Each built-in wraps the EXISTING `IPipelineFactory` (in `src/factories/`), which
produces a `BuiltCoordinator { handler }` — the coordinator stage handler. The
plugin gets the pre-wired builder from `ctx.createAgentBuilder()`, registers that
handler, and builds:

```ts
// llm-agent-server-libs/src/pipelines/dag.ts
export class DagPipelinePlugin implements IPipelinePlugin<DagCoordinatorHandlerDeps> {
  readonly name = 'dag';
  parseConfig(raw: unknown): DagCoordinatorHandlerDeps { /* validate the dag dialect */ }
  async build(cfg: DagCoordinatorHandlerDeps, ctx: IServerPipelineContext): Promise<IPipelineInstance> {
    const { handler } = await new DagFactory().build(cfg, {
      makeRoleLlm: ctx.resolveLlm,
      callMcp: ctx.callMcp as never,   // factory wants Promise<string>; host adapts
    });
    const builder = await ctx.createAgentBuilder();          // pre-wired infra
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
```

(`withStepperCoordinator(handler: IStageHandler)` is the builder's generic
"register the coordinator stage handler" path — highest precedence — so any
factory's `BuiltCoordinator.handler` registers through it. Stepper variants pass
the richer `StepperFactoryDeps` from `ctx`; see the factories.)

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

The existing loader (`packages/llm-agent-libs/src/plugins/loader.ts`) dynamic-imports
each file and merges its `PluginExports` into a **`LoadedPlugins`** result — it does
**not** hand back raw module exports. So adding the field to `PluginExports` alone is
not enough (F2): the loader plumbing must carry it through too:

```ts
// @mcp-abap-adt/llm-agent — LoadedPlugins gains the resolved registry + source map:
export interface LoadedPlugins {
  stageHandlers: Map<string, IStageHandler>;
  // …existing maps…
  pipelinePlugins: Map<string, IPipelinePlugin>;        // NEW
  pipelinePluginSources: Map<string, string>;           // NEW: name → first-seen source
}
```

- `emptyLoadedPlugins()` must initialise both `pipelinePlugins: new Map()` and
  `pipelinePluginSources: new Map()`.
- `mergePluginExports()` copies `mod.pipelinePlugins` entries into
  `result.pipelinePlugins`, returning `true` when any were registered — but with a
  **different rule than `stageHandlers`** (F1). `stageHandlers` is *last-wins*
  (`.set()` overwrites); pipeline names must instead **reject duplicates**: if
  `result.pipelinePlugins.has(name)`, record a duplicate-name error naming **both
  sources** — the prior one from `pipelinePluginSources.get(name)` and the current
  `source` param — in the loader's `errors`, and keep the first. On first insert it
  also records `pipelinePluginSources.set(name, source)`. (The source map exists
  precisely because a bare `Map<string, IPipelinePlugin>` loses the prior source.)
  The host then fails fast
  at startup on any collision, which silent last-wins would hide.

- `PluginExports` (stageHandlers, adapters, skills) extends an agent's **internals**;
  `pipelinePlugins` contributes **whole agent variants**. The two levels compose:
  a built-in pipeline's internal `DefaultPipeline` still consumes
  `stageHandlers` from loaded plugins.
- The host builds the registry from **three sources**, in order; duplicate name
  → fail-fast:
  1. **Built-ins** — `flat`/`linear`/`dag`/`stepper`, statically registered (they
     ship in `@mcp-abap-adt/llm-agent-server-libs`, a dependency of the server, so
     they are always present — no import needed even on a global install).
  2. **`pluginDir`** (existing) — the loader scans the directory and dynamic-imports
     `.js`/`.mjs`/`.ts` files, reading each file's `PluginExports`.
  3. **`plugins: [<module-specifier>]`** (new) — the host `await import(specifier)`
     for each entry and feeds the module's **full `PluginExports` through the same
     `mergePluginExports()`** as `pluginDir` (F3) — not only `pipelinePlugins`. So a
     pipeline package may also ship `stageHandlers` / `embedderFactories` /
     `mcpClients` / `apiAdapters`, and they register and compose with the built-ins
     exactly as directory-loaded plugins do. The package self-declares its pipeline
     names via the `pipelinePlugins` map; YAML needs no per-export import syntax.

**Startup order matters (F2).** Because module plugins can register
`embedderFactories` / `mcpClients` that the infra (RAG/embedder, MCP) needs, all
`PluginExports` must be merged **before** the infra context is built. The host
sequence is fixed:

1. parse YAML;
2. load **both** `pluginDir` **and** `plugins: [<specifier>]` through
   `mergePluginExports()` → one `LoadedPlugins` (this is also where duplicate
   pipeline names fail fast);
3. build infra / `IPipelineContext` (RAG, embedders, MCP) — now able to see
   plugin-contributed `embedderFactories` / `mcpClients`;
4. resolve `pipeline.name` in the registry (built-ins + `LoadedPlugins.pipelinePlugins`)
   and `build()` the instance.

This mirrors the current server, which pre-loads plugins before RAG precisely so
embedder factories are available.

### 7.1 Loading a pipeline by module specifier

```yaml
plugins:
  - '@acme/superpuper-pipeline'      # npm package exporting PluginExports.pipelinePlugins
pipeline:
  name: superpuper                   # a name from that package's pipelinePlugins map
  config: { ... }
```

```ts
// @acme/superpuper-pipeline (entry)
export const pipelinePlugins = { superpuper: new SuperPuperPipelinePlugin() };
```

**Global-install resolution.** When `llm-agent-server` is installed `-g`, a bare
specifier resolves relative to the *server's* location, not the user's cwd:

- A pipeline bundled as a server dependency (e.g. the built-ins in
  `@mcp-abap-adt/llm-agent-server-libs`) is already on the global `node_modules`
  path → resolves out of the box (and, being a built-in, needs no `plugins:` entry
  at all).
- A separately-installed third-party package (`@acme/…`) may not resolve from the
  global server. The host therefore resolves `plugins:` specifiers **against the
  user's project / cwd** (`createRequire(process.cwd())` or `import.meta.resolve`
  with a cwd base), and accepts absolute paths. This is the one resolution rule
  the host must implement deliberately.

```ts
const reg = new Map<string, IPipelinePlugin>();        // built-ins + loaded pipelinePlugins
const plugin = reg.get(yaml.pipeline.name) ?? failUnknown(yaml.pipeline.name, [...reg.keys()]);
const cfg    = plugin.parseConfig(yaml.pipeline.config);  // throws → fail-fast (which field)
const inst   = await plugin.build(cfg, ctx);              // throws → server does not start
// per request:
for await (const chunk of inst.agent.streamProcess(input, options)) yield chunk;  // signal cancels through
// on shutdown / before recreate:
await inst.close();
```

- **Resolution:** unknown name → error listing available names; duplicate pipeline
  name across sources → fail-fast (see §7 merge rule); `parseConfig` throw →
  fail-fast naming the field; `build` throw (e.g. LLM/RAG unavailable) → startup
  error, server does not come up with a broken pipeline.
- **Lifecycle:** `build(cfg, ctx)` produces one `IPipelineInstance`. The host calls
  it wherever it builds an agent today — including **per session** (the existing
  `buildSessionAgent` path, smart-server.ts ~2098): `ctx.createAgentBuilder()`
  returns a builder wired with that session's infra (fresh subagent registry,
  session MCP/logger), the plugin registers its coordinator and builds, and the
  host disposes the session instance via `inst.close()`. This replaces today's
  per-session coordinator re-wire (`withStepperCoordinator`/`withDagCoordinator`
  inside `buildSessionAgent`) with a single `plugin.build(sessionCtx)` call. Config
  change → `inst.close()` then **recreate**. Runtime LLM hot-swap uses the existing
  `SmartAgent.reconfigure()` when `inst.agent` is reconfigurable, else
  close-then-recreate; `rebuildStages?` / `reconfigure?` stay internal to the
  agent's `IPipeline` (unchanged). No new lifecycle surface on the plugin beyond
  `IPipelineInstance.close()`.
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

# optional — dynamically load additional agent variants (built-ins need no entry)
plugins:
  - '@acme/superpuper-pipeline'

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
| `plugins` | **host** | dynamic `import()` (resolved against cwd) → merge **full `PluginExports`** via `mergePluginExports()`; `pipelinePlugins` enter the registry |
| `pipeline.name` | **host** | registry lookup; unknown → fail-fast with available names |
| `pipeline.config` | **plugin** (`parseConfig`) | typed, flow-specific config owned by the pipeline |

## 10. Testing

- **Generic host = one launcher:** the same binary serves any pipeline — change
  `pipeline.name` in YAML, no rebuild. The existing `roundtrip.mjs` generalizes to
  a pipeline-name parameter.
- **Pipeline unit test without a server:** `ctx` is an interface, trivially
  stubbed. `plugin.parseConfig(fixture)` → `build(stubCtx)` → drive
  `inst.agent.streamProcess()` with fake LLM/MCP → assert the stream → `inst.close()`.
  No HTTP, no process.
- **Conformance test over the registry:** one test iterates every registered
  pipeline — each must `parseConfig` a minimal config, `build` an `IPipelineInstance`,
  `streamProcess` a trivial request producing a valid stream, and `close()` cleanly.
  New pipelines are covered automatically. A negative case asserts duplicate pipeline
  names across sources fail-fast.

## 11. Migration (clean break)

- The old YAML `coordinator:` dialect and the **YAML `pipeline.stages` authoring**
  (the user-facing structured-pipeline DSL) are **removed** in the new major; no
  compat shim. **The internal `StageDefinition` type and `DefaultPipeline` stage
  executor STAY** — they are how every agent's request pipeline runs (classify →
  rag → assemble → tool-loop → coordinator). We remove only the YAML parsing /
  docs / examples that let users hand-author a stage tree, not the engine.
- Consumers needing the old behavior pin a version **≤ 18** on npm.
- The components that implemented the old flows **remain exported** (relocated to
  `legacy/*`); consumers import them **directly, in code, without YAML**.
- Removed: `coordinator:` parsing in `config.ts` (`parseStepperCoordinatorConfig`,
  `MODE_FLOW_PRESET`, `assertCoordinatorConfigShape`, `YamlCoordinator`); the
  per-session coordinator re-wire and the 3-way coordinator gate in
  `smart-server.ts` (~1267–1628); YAML `pipeline.stages` parsing. Replaced by the
  pipeline registry + `plugin.build(ctx)` in the host.
- Added in core `llm-agent`: `IPipelinePlugin`, `IPipelineInstance` (agent +
  `close()`), `IPipelineContext` (core-only, opaque `resolveLlm`),
  `IReconfigurableSmartAgent`, `MaybePromise<T>`; `pipelinePlugins` on `PluginExports` **and** on
  `LoadedPlugins` (+ `pipelinePluginSources` map, `emptyLoadedPlugins`/
  `mergePluginExports` plumbing, with **reject-duplicate** merge for pipeline names
  naming both sources, unlike last-wins `stageHandlers`).
- Added in `llm-agent-server-libs`: `IServerPipelineContext` (libs/server-service
  extension + `createAgentBuilder()` returning the pre-wired builder); built-in
  pipelines wrapping the existing factories; `legacy/*` exports.
- Added in `llm-agent-server`: registry + dynamic-load wiring, including the
  `plugins: [<specifier>]` loader (cwd-based resolution, routed through
  `mergePluginExports` like `pluginDir`) alongside the existing `pluginDir` scan;
  feature-detected `reconfigure()` else `close()`-then-recreate.
- This is a **major** lockstep bump.

## 12. Future (out of scope here)

- **Novel flows as pipeline plugins** — the *planner+reviewer → controller+executor*
  "node = process" idea is realized as a new pipeline plugin, validating that the
  contract is expressive enough beyond the four built-ins.
- **External-tool suspend/resume** — revisited as a pipeline-internal concern (a
  pipeline may hold a live continuation across a consumer round-trip), not a
  cross-cutting feature.
```
