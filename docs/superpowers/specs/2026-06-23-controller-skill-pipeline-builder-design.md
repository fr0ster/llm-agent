# Controller + Skills Pipeline Builder — Design

**Date:** 2026-06-23
**Status:** REVISED after PR #196 code review — pending re-review.

**Revision (2026-06-23, post-#196 review):**
- **P1a** — `buildAgent()` must return the agent that runs the **configured
  pipeline** (the coordinated one), NOT the startup/infra passthrough agent. In
  `SmartServer` the coordinated agent is the **per-session pipeline instance**
  (`buildSessionAgent` → `buildPipelineInstance` → `plugin.build()` →
  `IPipelineInstance.agent`); the startup `smartAgent` is infra-only and is never
  dispatched to. So `buildAgent` builds a pipeline instance and returns
  `inst.agent`.
- **P1b + dependency-injection philosophy** — the library does NOT decide how MCP
  is provided (one/many, in-process/external, static/dynamic). It exposes
  **interface/strategy seams**; the consumer injects ready `IMcpClient`s, an
  `IMcpConnectionStrategy`, or a URL config — or supplies their own. Same for LLM
  (`ILlm`), embedder (`IEmbedder`), and skills. The builder is a composition root
  with overridable defaults, not a policy.

## Problem

Embedding the controller pipeline (with a skill plugin-host) into another project
is awkward today. A consumer must either run the full `SmartServer` (which always
binds an HTTP port) or hand-assemble the heavy `IControllerServerPipelineContext`
(MCP clients, `toolsRag` with its post-`build()` vectorization, skill-host,
embedder, `makeLlm`, agent builder, knowledge backend) and feed a parsed config
object. Both are ergonomically wrong for "import a component and use it".

We want a **partially-configured pipeline as a single importable component**,
realized through a builder: the composition (controller pipeline + skill-host) is
baked in; the things that change often are supplied **sequentially through fluent
builder methods**, not as a config blob handed to a generic plugin.

## Guiding principle

**We export components; `SmartServer` is the default implementation on top of
them.** The pipeline composition and the no-listen agent build are first-class
exported capabilities of `@mcp-abap-adt/llm-agent-server-libs`. `SmartServer`
remains the default assembly that adds the HTTP transport (`listen`) over those
components — it is one consumer, not the center.

**Dependencies are injected through interfaces and strategies; the library does
not hard-code implementation choices.** Whether MCP is one server or many,
in-process or external, fixed or swapped per task — that is the consumer's choice,
expressed by injecting an implementation (`IMcpClient[]`, `IMcpConnectionStrategy`,
or a URL config). Likewise the LLM provider (`ILlm`), embedder (`IEmbedder`), and
skill source. The builder ships sensible defaults and lets every dependency be
overridden or replaced. We do NOT bake these decisions into the library at design
time (consistent with the engine's existing seams: `withMcpClients`,
`withMcpConnectionStrategy`, consumer-implementable `ILlm`, the MCP-agnostic
engine).

## Constraints (decided)

1. **`buildAgent` returns the PIPELINE agent.** Not the infra startup agent — the
   coordinated `IPipelineInstance.agent` for `cfg.pipeline` (see P1a above).
2. **MCP is injected, not decided.** The builder exposes `.withMcpClients(IMcpClient[])`,
   `.withMcpConnectionStrategy(IMcpConnectionStrategy)`, and `.withMcp({url})` —
   the consumer picks. Injected clients/strategy mean the builder never forces a
   real connect (closes P1b and covers in-process / many / dynamic MCP).
3. **Fluent builder, not a config blob.** Variable parts (LLM, MCP, skill source,
   embedder, optional budgets/targetState/planner) are set via chained `.withX()`
   methods. An internal config object is an implementation detail the consumer
   never authors.
4. **Keep the current behaviour model** (no change to controller semantics):
   - Subagent LLMs are **per-role** (`evaluator`/`planner`/`executor`). The
     builder offers a shared `.withLlm()` (sets all three) plus a per-role
     `.withRoleLlm(role, cfg)` override.
   - `budgets` / `targetState` / `sessionMemory` keep their baked defaults
     (from `ControllerPipelinePlugin.parseConfig`) and are overridable.
   - `plannerKind` is baked `smart-executor`; `.withPlanner(kind)` overrides.
5. **DRY — no duplication of orchestration.** The builder must reuse the existing
   composition machinery (infra assembly, `toolsRag` vectorization, skill-host
   init, `buildPipelineInstance`) rather than re-implement `SmartServer.start()`.
6. **No new HTTP coupling.** Building an embeddable agent must not require binding
   a port.

## Architecture

```
        consumer code
   fluent .withLlm()/.withMcpClients()|.withMcpConnectionStrategy()|.withMcp()/.withSkillSource()/…
             ▼
  ControllerSkillPipelineBuilder        (NEW, exported)
             │  .build(deps?):  accumulated state ──► SmartServerConfig + BuildAgentDeps (internal)
             ▼
  buildAgent(config, deps?): { agent, close }   (NEW exported fn — no-listen)
             │  assemble infra (LLM/embedder/skill-host/MCP via injected seams)
             ▼
  buildPipelineInstance({sessionId:'embedded', parts})           (the SAME path a
             │  → buildServerCtx → plugin.build(cfg, ctx)         session uses)
             ▼
  IPipelineInstance { agent, close }   ← agent = the COORDINATED pipeline agent
             │
  buildAgent returns { agent: inst.agent, close: inst.close + infra close }

  SmartServer.start() = (infra build + per-session graph.agent via the SAME
                         buildPipelineInstance) + server.listen(...)   (default impl)
```

Note: the startup `smartAgent` from `builder.build()` is INFRA/passthrough only
(no coordinator) — the HTTP path dispatches to the per-session `graph.agent`
(= `buildPipelineInstance(...).agent`). `buildAgent` must therefore build a
pipeline instance and return ITS agent, not the startup agent.

### Component 1 — `buildAgent` (no-listen build of the PIPELINE agent, exported)

`buildAgent` does two things, in order:

1. **Assemble the global infra** — the same pre-listen work `SmartServer._start()`
   already does (LLM globals, embedder, `toolsRag` + vectorization, skill-host
   init, MCP clients). This is extracted into a private `_buildInfra()` so both
   `start()` and `buildAgent` share it (DRY).
2. **Build ONE pipeline instance** for `cfg.pipeline` via the existing
   `buildPipelineInstance({ sessionId: 'embedded', parts })` — the SAME path a
   session uses (`buildSessionAgent` → `buildPipelineInstance` →
   `plugin.build(cfg, buildServerCtx(scope))`). The `parts` (`SessionAgentParts`)
   are assembled from the infra globals (the same shape the session manager
   passes). This yields `IPipelineInstance { agent, close }` where **`agent` is the
   coordinated pipeline agent** (the controller coordinator). Return
   `{ agent: inst.agent, close: <inst.close + infra close> }`.

> Why not return `builder.build().agent`? That startup `smartAgent` is
> INFRA/passthrough only (no coordinator) — the HTTP path never dispatches to it;
> it dispatches to the per-session `graph.agent` = `buildPipelineInstance(...).agent`.
> Returning the startup agent (the original draft's mistake, P1a) would NOT run the
> controller pipeline.

`SmartServer.start()` is refactored to call the SAME `_buildInfra()` and reuse the
existing per-session `buildPipelineInstance` path it already has, then
`server.listen(...)`; the returned `SmartServerHandle.close()` composes the infra
close with the server shutdown. **Net behaviour of `start()` is unchanged.**

Expose the no-listen result as a public, exported free function:
`export async function buildAgent(cfg: SmartServerConfig, deps?: BuildAgentDeps):
Promise<{ agent: ISmartAgent; close: () => Promise<void> }>` — constructs the
`SmartServer` internally, runs `_buildInfra()` + a single `buildPipelineInstance`,
binds NO port.

**MCP (P1b) via the injected seam:** `buildAgent` resolves MCP clients through the
consumer's choice and passes them as the infra `mcpClients` so the builder does
NOT self-connect from `cfg.mcp`:
- `deps.mcpClients` (ready `IMcpClient[]`) → used directly (in-process / many / test stubs);
- else `deps.connectMcp(cfg.mcp)` (a strategy/function; default
  `connectMcpClientsFromConfig`) → connected clients;
- the builder-level `withMcpClients` / `withMcpConnectionStrategy` seams remain
  available for the SmartAgentBuilder path.
Injected clients/strategy mean **no forced real connect** — closing P1b and
covering in-process, multiple, and dynamic MCP without the library deciding.

#### `BuildAgentDeps` — the DI seam (required for I/O-free tests)

`SmartServer` today takes only `config` (constructor at `smart-server.ts:1028`)
and constructs its LLMs, embedder, and skill-host via **direct imports/internal
calls** — `makeLlm` (`:1077/1092/1109/1917`), `resolveEmbedder` (`:84`, used at
`:1251`), and `buildSkillHostFromConfig` (`:1245`). With no seam, a `buildAgent`
integration test would reach real providers and GitHub. So `buildAgent` accepts
an **optional, fully-defaulted** deps object, and `SmartServer` routes the same
constructions through it:

All signatures below are the REAL exported types (no invented aliases):
`SmartServerLlmConfig`, `SmartServerMcpConfig`, `connectMcpClientsFromConfig`,
`buildSkillHostFromConfig`, `BuildSkillHostDeps`, `SkillPluginsConfig`,
`ISkillPluginHost` from `@mcp-abap-adt/llm-agent-server-libs`; `resolveEmbedder`,
`EmbedderResolutionConfig`, `EmbedderResolutionOptions`,
`prefetchEmbedderFactories` from `@mcp-abap-adt/llm-agent-rag`; `ILlm`,
`IEmbedder`, `IMcpClient` from `@mcp-abap-adt/llm-agent`.

```ts
export interface BuildAgentDeps {
  /** LLM factory at the SmartServer level (mirrors the private `_makeLlm`
   *  seam, `smart-server.ts:1917`). Default: the real `_makeLlm`. */
  makeLlm?: (cfg: SmartServerLlmConfig) => Promise<ILlm>;
  /** Embedder resolver (results + MCP-tool RAG + skill-host). Default:
   *  `resolveEmbedder` (`rag-factories.ts:138`). NOTE: the simplest stub path is
   *  to pass `options.injectedEmbedder` — that field already short-circuits
   *  resolution to a supplied IEmbedder, so a test need not replace the fn. */
  resolveEmbedder?: (
    cfg: EmbedderResolutionConfig,
    options?: EmbedderResolutionOptions,
  ) => IEmbedder;
  /** One-time embedder-factory prefetch. Default: `prefetchEmbedderFactories`. */
  prefetchEmbedderFactories?: typeof import('@mcp-abap-adt/llm-agent-rag').prefetchEmbedderFactories;
  /** Skill-host builder. Default: `buildSkillHostFromConfig`
   *  (`skill-plugins-host-factory.ts:236`). */
  buildSkillHost?: (
    cfg: SkillPluginsConfig,
    deps: BuildSkillHostDeps,
  ) => Promise<ISkillPluginHost>;
  /** Escape hatch: a PREBUILT skill host (skips building entirely). */
  skillHost?: ISkillPluginHost;
  /** MCP connection STRATEGY (function form). Default: `connectMcpClientsFromConfig`
   *  (`smart-server.ts:876`), accepting the single|array|nullish union → connected
   *  clients. A consumer injects their own to provision MCP however they want
   *  (e.g. per-task / dynamic). */
  connectMcp?: (
    mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
  ) => Promise<IMcpClient[]>;
  /** Escape hatch: READY `IMcpClient`s (in-process / external / test stubs). When
   *  present, used directly as the infra `mcpClients` — NO connect runs (the
   *  builder never self-connects from `cfg.mcp`). Parallels `skillHost`. */
  mcpClients?: IMcpClient[];
}
```

- Every field is optional; omitting `deps` (production / `SmartServer.start()`)
  uses the real implementations exactly as today → **behaviour-preserving**.
- The refactor threads `this._deps` (defaulted in the constructor) through the
  LLM / embedder / skill-host / MCP construction points so both `start()` and
  `buildAgent()` honour injected stubs.
- Integration tests inject: a stub `makeLlm` returning a canned `ILlm`, a stub
  embedder (either a `resolveEmbedder` override or, simpler, the existing
  `EmbedderResolutionOptions.injectedEmbedder` field with a deterministic-vector
  embedder), and a **prebuilt in-memory `skillHost`** — no network, no port, no
  GitHub.

This makes the agent embeddable for **all** pipelines (bonus beyond controller),
and is the single seam the fluent builder delegates to. The fluent builder may
forward a `BuildAgentDeps` (e.g. `.withDeps(deps)` or a `build(deps?)` argument)
so the same stubs reach `buildAgent`.

### Component 2 — `ControllerSkillPipelineBuilder` (fluent façade, exported)

New file `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts`.
A small fluent builder that accumulates state and, on `.build()`, translates it
into a `SmartServerConfig` (pipeline `controller`, the skill-host source, rag,
mcp, llm) and delegates to `buildAgent`.

```ts
const { agent, close } = await new ControllerSkillPipelineBuilder()
  .withLlm({ provider: 'sap-ai-sdk', model: 'anthropic--claude-4.6-sonnet' }) // keyless
  .withRoleLlm('planner', { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o' })
  .withMcp({ url: 'http://localhost:3001/mcp/stream/http' })       // EXTERNAL by URL (repeatable)
  // OR inject the consumer's OWN in-process MCP (no URL, no connect):
  //   .withMcpClients([myInProcessMcpClient, anotherClient])
  // OR a custom provisioning strategy (dynamic / per-task):
  //   .withMcpConnectionStrategy(myStrategy)
  .withSkillSource({
    github: 'https://github.com/secondsky/sap-skills.git',
    enabled: ['sap-abap', 'sap-abap-cds', 'sap-btp-developer-guide', 'sap-btp-best-practices'],
    collection: 'sap',          // → controllerSkillGroup + single-collection group
    // ref, token optional
  })
  .withEmbedder({ provider: 'sap-ai-core', model: 'text-embedding-3-small',
                  scenario: 'foundation-models', resourceGroup: 'default' })
  .withBudgets({ maxToolCalls: 30 })       // optional; merged over baked defaults
  .withTargetState({ distanceThreshold: 0.7 })  // optional
  .withPlanner('smart-executor')           // optional; default smart-executor
  .build();

// `agent` is a SmartAgent — its public entry point is `process()`
// (string | Message[]) → Promise<Result<SmartAgentResponse, OrchestratorError>>.
const res = await agent.process('Review ABAP program ZDAZ_R_DELAYED_UPDATE, …');
if (res.ok) console.log(res.value.content);
await close();
```

#### Builder input types (apiKey is OPTIONAL — per-provider semantics)

`SmartServerLlmConfig.apiKey` is a required `string` at the type level
(`smart-server.ts:94`), but the config parser already tolerates a missing key for
**keyless** providers (`config.ts:543` handles Ollama / SAP AI Core, which omit
`apiKey`). The builder therefore exposes its OWN input type with an **optional**
`apiKey`, and fills the value when translating to `SmartServerLlmConfig`:

```ts
export interface BuilderLlmInput {
  provider: 'sap-ai-sdk' | 'openai' | 'anthropic' | 'deepseek' | 'ollama';
  model?: string;
  apiKey?: string;     // OPTIONAL here (see semantics below)
  url?: string;        // OpenAI-compatible base URL (Ollama/Azure/vLLM)
  temperature?: number;
  maxTokens?: number;
}
```

Translation/validation at `.build()`:
- **Keyless** (`sap-ai-sdk`, `ollama`): `apiKey` omitted; the builder supplies the
  empty-string placeholder the parser accepts. Credentials come from the
  environment out-of-band — SAP AI Core via `AICORE_SERVICE_KEY` (+ `SAP_AI_MODEL`
  / resource group), Ollama via `url`. No token is read or logged by the builder.
- **Keyed** (`openai`, `anthropic`, `deepseek`): `apiKey` required. If omitted, the
  builder falls back to the conventional env var (`OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY`); if still empty, `.build()` throws
  naming the missing key. The example passes `process.env.OPENAI_API_KEY`
  explicitly for the `openai` role override.

`withSkillSource` input mirrors the config's github source variant:
```ts
export interface BuilderSkillSourceInput {
  github: string;                 // repo URL or owner/repo
  enabled: readonly string[];     // plugin names; ['*'] = all
  collection?: string;            // default 'sap' → controllerSkillGroup + group name
  ref?: string;                   // default = repo default_branch
  token?: string;                 // optional; or via env
}
```

**Baked (not in the fluent surface):** pipeline name `controller`; skill-host
`store: in-memory`; `controllerSkillGroup` derived from the skill source's
`collection` (default `sap`); `strategy: single-collection`; the controller
default `budgets`/`targetState`/`sessionMemory`.

**Method semantics:**

| Method | Effect |
|--------|--------|
| `withLlm(cfg)` | sets `subagents.{evaluator,planner,executor}` all to `cfg`, and the base `llm.main` |
| `withRoleLlm(role, cfg)` | overrides one subagent role (applied after `withLlm`) |
| `withMcp(cfg)` | EXTERNAL MCP by URL config (repeatable → array); built on the default connect strategy |
| `withMcpClients(clients)` | inject READY `IMcpClient[]` (in-process MCP that's part of the consumer's app, many servers, or test stubs) → `deps.mcpClients`; no connect runs |
| `withMcpConnectionStrategy(strategy)` | inject an `IMcpConnectionStrategy` → the consumer owns provisioning (e.g. dynamic / per-task) |
| `withSkillSource(cfg)` | sets the single github skill source + derives `controllerSkillGroup`/collection |
| `withEmbedder(cfg)` | sets `rag.embedder` (results + MCP-tool RAG) and the skill-host embedder |
| `withBudgets(partial)` | shallow-merges over baked `budgets` |
| `withTargetState(partial)` | shallow-merges over baked `targetState` |
| `withPlanner(kind)` | selects `controller` vs `controller-weak` pipeline (smart/weak) |

`withPlanner('weak-executor')` sets the internal pipeline name to
`controller-weak` (the existing preset), so capability stays preset-encoded — no
`planner:` key is introduced.

### Data flow (build)

`.build(deps?)` → assemble the RAW `SmartServerConfig` (pipeline
`controller`/`controller-weak` + `config.subagents/budgets/targetState/sessionMemory`,
`rag`, optional `mcp[]`, `skillPlugins` with the github source) + a `BuildAgentDeps`
(from any injected MCP clients/strategy) → normalize via `resolveSmartServerConfig`
→ `buildAgent(cfg, deps)` → `_buildInfra()` (LLM/embedder/skill-host/MCP via the
injected seams) → `buildPipelineInstance({ sessionId:'embedded', parts })` →
`ControllerPipelinePlugin.build(cfg, ctx)` → `IPipelineInstance { agent, close }` →
return `{ agent: inst.agent, close: inst.close + infra close }`. **No port bound;
no forced MCP connect when clients/strategy are injected.**

## Validation & error handling

- The builder fails loud on `.build()` if a required piece is missing: no LLM
  (`withLlm`/`withRoleLlm` never called), no embedder when a skill source is set
  (skills need an embedder), or no skill source (the whole point — at least one
  required). Messages name the missing `.withX()` call.
- Config translation reuses the existing `resolveSmartServerConfig` / pipeline
  `parseConfig`, so the same fail-loud rules (e.g. `github` XOR `registry`) apply
  to the generated config — one validation path, no divergence.
- `buildAgent` surfaces composition errors (bad creds, unreachable MCP at
  connect, skill-host load failure) exactly as `start()` does today.

## Testing

**Unit (no I/O):**
- Fluent accumulation → generated `SmartServerConfig`: `withLlm` fills all three
  roles + `llm.main`; `withRoleLlm` overrides one; `withMcp` appends; `withSkillSource`
  sets the github source + derives `controllerSkillGroup`/collection; `withPlanner`
  flips the pipeline name; `withBudgets`/`withTargetState` shallow-merge over defaults.
- Missing-piece guards throw with the naming the spec requires.

**Integration (via the `BuildAgentDeps` seam — no network, no port):**
- `buildAgent(cfg, deps)` returns a runnable agent for the controller pipeline with
  skill recall wired, injecting stubs through `BuildAgentDeps`: a stub `makeLlm`
  (canned `ILlm`), an injected `embedder` (deterministic-vector — covers agent-RAG
  + skill-host, skips prefetch), and a **prebuilt in-memory `skillHost`**.
- **P1a — the COORDINATED pipeline agent runs (not the infra passthrough):** the
  stubbed planner/executor `makeLlm` records that it was invoked through the
  controller coordinator (e.g. the planner LLM receives the create-plan prompt).
  Assert the controller handler is actually exercised — NOT just `typeof
  agent.process === 'function'`. (The original draft test only checked the latter
  and would pass even with the wrong agent.)
- **P1b — injected MCP clients ⇒ no real connect:** with `mcp` set in the config
  AND `deps.connectMcp` a stub that THROWS on call (or `deps.mcpClients` injected),
  `buildAgent` builds successfully — proving the embeddable path never performs a
  real MCP connect. (A second variant injects ready `IMcpClient` stubs via
  `.withMcpClients(...)` and asserts those exact clients reach the pipeline.)
- The fluent builder end-to-end: `new ControllerSkillPipelineBuilder().withLlm(…)
  …​.build(deps)` produces the same wired coordinated agent (façade → config →
  `buildAgent`), with stubs forwarded via the builder's deps argument.
- Regression: `SmartServer.start()` still builds + listens + serves the per-session
  coordinated agent with `deps` omitted (the refactor is behaviour-preserving).

## Explicitly SUPPORTED via injection (not the library's decision)

- **Multiple / different MCP servers** — inject several `IMcpClient`s
  (`.withMcpClients`) or repeat `.withMcp`. Tools from all feed the tool-RAG;
  selection is semantic per query.
- **In-process MCP that's part of the consumer's app** — `.withMcpClients([...])`
  with the consumer's own client(s), or an `embedded`-transport config. No URL, no
  external connect.
- **Dynamic / per-task MCP provisioning** — inject an `IMcpConnectionStrategy`
  (`.withMcpConnectionStrategy`); the consumer's strategy decides what to provide
  and when.

## Out of scope (YAGNI)

- A fluent builder for the other pipelines (flat/linear/dag/stepper) — only the
  controller+skills composition is requested. (`buildAgent` is generic, so they
  benefit from the no-listen path, but get no dedicated builder yet.)
- Multiple skill *sources* in the fluent builder (single github source covers the
  need; the underlying config still supports more if hand-written).
- **Mutating an already-built agent's MCP/models at runtime** (hot-reconfigure of a
  live instance). Per-task variation is handled by an injected MCP strategy or by
  building a separate agent — NOT by reconfiguring one returned instance.
