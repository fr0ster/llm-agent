# Controller + Skills Pipeline Builder — Design

**Date:** 2026-06-23
**Status:** Approved (design); pending spec review → implementation plan.

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

## Constraints (decided)

1. **Fluent builder, not a config blob.** Variable parts (LLM, MCP, skill source,
   embedder, optional budgets/targetState/planner) are set via chained `.withX()`
   methods. An internal config object is an implementation detail the consumer
   never authors.
2. **Keep the current behaviour model** (no change to controller semantics):
   - Subagent LLMs are **per-role** (`evaluator`/`planner`/`executor`). The
     builder offers a shared `.withLlm()` (sets all three) plus a per-role
     `.withRoleLlm(role, cfg)` override.
   - `budgets` / `targetState` / `sessionMemory` keep their baked defaults
     (from `ControllerPipelinePlugin.parseConfig`) and are overridable.
   - `plannerKind` is baked `smart-executor`; `.withPlanner(kind)` overrides.
3. **DRY — no duplication of orchestration.** The builder must reuse the existing
   composition machinery (ctx assembly, `toolsRag` vectorization, skill-host init)
   rather than re-implement `SmartServer.start()`.
4. **No new HTTP coupling.** Building an embeddable agent must not require binding
   a port.

## Architecture

```
        consumer code
             │  fluent .withLlm()/.withMcp()/.withSkillSource()/…
             ▼
  ControllerSkillPipelineBuilder        (NEW, exported)
             │  .build():  accumulated state ──► SmartServerConfig (internal)
             ▼
  buildAgent(config): { agent, close }  (NEW exported fn — the no-listen build)
             │  (extracted from SmartServer.start(), shared)
             ▼
  existing composition: buildServerCtx → buildPipelineInstance
        → ControllerPipelinePlugin.build(cfg, ctx) → SmartAgentBuilder

  SmartServer.start() = buildAgent(config) + server.listen(...)   (default impl)
```

### Component 1 — `buildAgent` (no-listen build, exported)

Refactor `SmartServer.start()` to split the build from the listen:

- Extract everything `start()` does **before** `server.listen(...)` — context
  assembly, `toolsRag` vectorization, skill-host init, pipeline-instance build —
  into a path that returns `{ agent, close }` (the same `agent`/`close` `start()`
  already assembles before listening).
- `start()` becomes: `const built = await this.buildAgent(); server.listen(...)`,
  and the returned `SmartServerHandle.close()` composes `built.close()` with the
  server shutdown. **Net behaviour of `start()` is unchanged.**
- Expose the no-listen result as a public, exported capability. Preferred shape:
  a module-level `export async function buildAgent(cfg: SmartServerConfig, deps?):
  Promise<{ agent: ISmartAgent; close: () => Promise<void> }>` that constructs the
  `SmartServer` internally and runs its build-without-listen path. (If a method on
  `SmartServer` is cleaner given private state, export a thin free function that
  wraps `new SmartServer(cfg).buildAgent()`.)

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
  /** MCP connector. Default: `connectMcpClientsFromConfig` (`smart-server.ts:876`),
   *  whose real signature accepts the single|array|nullish union and returns
   *  connected clients. */
  connectMcp?: (
    mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
  ) => Promise<IMcpClient[]>;
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
  .withMcp({ url: 'http://localhost:3001/mcp/stream/http' })       // repeatable
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
| `withMcp(cfg)` | appends an MCP endpoint (repeatable → array) |
| `withSkillSource(cfg)` | sets the single github skill source + derives `controllerSkillGroup`/collection |
| `withEmbedder(cfg)` | sets `rag.embedder` (results + MCP-tool RAG) and the skill-host embedder |
| `withBudgets(partial)` | shallow-merges over baked `budgets` |
| `withTargetState(partial)` | shallow-merges over baked `targetState` |
| `withPlanner(kind)` | selects `controller` vs `controller-weak` pipeline (smart/weak) |

`withPlanner('weak-executor')` sets the internal pipeline name to
`controller-weak` (the existing preset), so capability stays preset-encoded — no
`planner:` key is introduced.

### Data flow (build)

`.build()` → assemble `SmartServerConfig` (pipeline `controller`/`controller-weak`
+ `config.subagents/budgets/targetState/sessionMemory`, `rag`, `mcp[]`,
`skillPlugins` with the github source) → `buildAgent(cfg)` → existing
`buildServerCtx` + `buildPipelineInstance` → `ControllerPipelinePlugin.build` →
`SmartAgentBuilder` → `{ agent, close }`. No port is bound.

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
  (canned `ILlm`), a stub `resolveEmbedder` (deterministic-vector embedder), and a
  **prebuilt in-memory `skillHost`**. Assert `agent.process(...)` reaches the
  controller handler (skill recall block present) and `close()` disposes cleanly.
- The fluent builder end-to-end: `new ControllerSkillPipelineBuilder().withLlm(…)
  …​.build(deps)` produces the same wired agent (asserts the façade → config →
  `buildAgent` path), with the stubs forwarded via the builder's deps argument.
- Regression: `SmartServer.start()` still builds + listens + returns a working
  handle with `deps` omitted (the refactor is behaviour-preserving).

## Out of scope (YAGNI)

- A fluent builder for the other pipelines (flat/linear/dag/stepper) — only the
  controller+skills composition is requested. (`buildAgent` is generic, so they
  benefit from the no-listen path, but get no dedicated builder yet.)
- Multiple skill sources in the builder (single github source covers the need;
  the underlying config still supports more if hand-written).
- Hot-reconfigure / re-build of an already-built agent.
