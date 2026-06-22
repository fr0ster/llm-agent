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

This makes the agent embeddable for **all** pipelines (bonus beyond controller),
and is the single seam the fluent builder delegates to.

### Component 2 — `ControllerSkillPipelineBuilder` (fluent façade, exported)

New file `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts`.
A small fluent builder that accumulates state and, on `.build()`, translates it
into a `SmartServerConfig` (pipeline `controller`, the skill-host source, rag,
mcp, llm) and delegates to `buildAgent`.

```ts
const { agent, close } = await new ControllerSkillPipelineBuilder()
  .withLlm({ provider: 'sap-ai-sdk', model: 'anthropic--claude-4.6-sonnet' })
  .withRoleLlm('planner', { provider: 'openai', model: 'gpt-4o' }) // optional override
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

const out = await agent.run('Review ABAP program ZDAZ_R_DELAYED_UPDATE, …');
await close();
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
- Config translation reuses the existing `parseSmartServerConfig` / pipeline
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

**Integration:**
- `buildAgent` no-listen path returns a runnable agent for the controller pipeline
  with skill recall wired, using stub `makeLlm`/embedder/skill-host (no network,
  no port). Assert `agent.run(...)` reaches the controller handler and `close()`
  disposes.
- Regression: `SmartServer.start()` still builds + listens + returns a working
  handle (the refactor is behaviour-preserving).

## Out of scope (YAGNI)

- A fluent builder for the other pipelines (flat/linear/dag/stepper) — only the
  controller+skills composition is requested. (`buildAgent` is generic, so they
  benefit from the no-listen path, but get no dedicated builder yet.)
- Multiple skill sources in the builder (single github source covers the need;
  the underlying config still supports more if hand-written).
- Hot-reconfigure / re-build of an already-built agent.
