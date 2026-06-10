# Pipelines

A **pipeline** decides which agent the server builds. It is selected by name in
YAML and resolved from a plugin registry. The server ships five built-in
pipelines; deployments can add their own as plugins.

```yaml
# smart-server.yaml
pipeline:
  name: stepper            # flat | linear | dag | stepper | controller | <plugin name>
  config:                  # the dialect of the chosen pipeline (see below)
    mode: planned-react
```

`pipeline: flat` (a bare string) is shorthand for `pipeline: { name: flat }`.
Omitting `pipeline:` defaults to `flat`.

> **Clean break (v19+).** The old `coordinator:` block and the legacy
> `pipeline: { mcp | rag | stages | llm }` overrides were removed; a config using
> them now fails loud at startup with a migration message. Top-level `llm:`,
> `mcp:`, `rag:`, `subagents:` are unchanged. Pin a version ≤ 18 for the old form.

## Built-in pipelines

Each built-in wraps the existing coordinator components; the `config:` block is
that variant's dialect.

| `name` | What it builds | `config:` keys |
|---|---|---|
| `flat` | Single ReAct tool-loop agent, no coordinator | *(none)* |
| `linear` | Ordered plan → dispatch coordinator | `planning` (`one-shot`/`replan-on-error`/`skill-steps`), `dispatch` (`self`/`subagent`/`hybrid`), `maxSteps`, `maxRetriesPerStep`, `failPolicy` |
| `dag` ⚠️ | _(legacy — see note below)_ Planner → parallel workers → finalizer | `planner`, `reviewer`, `finalizer`, `errorStrategy`, `stateOracle`, `maxRoundTrips` |
| `stepper` ⚠️ | _(legacy — see note below)_ Composition flow (planner/executor/evaluator/reviewer/finalizer) | `mode` (`cyclic-react`/`planned-react`/`deep-stepper`), `flow`, `knowledgeSeed`, `maxParallelSteps`, `maxDepth`, `evaluator`, `reviewer` |
| `controller` | Deterministic coordinator + three opaque subagent roles (evaluator/planner/executor); incremental loop, durable per-session bundle, stateless suspend/resume | `subagents.{evaluator,planner,executor}`, `targetState`, `sessionMemory`, `budgets` |

Stepper's `knowledgeSeed` (deployment-supplied tool guidance, seeded into a new
session's knowledge store) lives under `pipeline.config.knowledgeSeed`.

> **⚠️ `dag` and `stepper` are deprecated (legacy).** They keep running on their
> own legacy step-interpreter and remain selectable for backward compatibility,
> but they are no longer the active development path and will not receive the
> newer planner/replan/metering work. The `controller` pipeline (with its
> `incremental` or `adaptive` planner) is the maintained interpreter and the
> recommended choice for new deployments. The newer controller interpreter was
> **not** designed to drive the legacy DAG/stepper flows — do not migrate a
> `dag`/`stepper` config onto it; pick `controller` directly instead. These two
> pipelines may be removed in a future major version.

### `controller` config

```yaml
pipeline:
  name: controller
  config:
    subagents:                       # three roles, each a standalone LLM config
      evaluator:                     # formulates the target state (goal)
        provider: sap-ai-sdk
        model: anthropic--claude-4.6-sonnet
      planner:                       # returns the next step / done / rewind
        provider: sap-ai-sdk
        model: anthropic--claude-4.6-sonnet
      executor:                      # carries out a step; emits tool calls
        provider: sap-ai-sdk
        # hint: <operational steering>  # optional — mainly for weaker models
        model: anthropic--claude-4.6-sonnet
    targetState:                     # how the goal is confirmed
      strategy: auto                 # auto | semantic-distance | consumer-confirm
      distanceThreshold: 0.7         # (semantic-distance/auto) larger ⇒ ask to confirm
    sessionMemory: { collection: session-memory }
    budgets: { maxSteps: 20, maxRetries: 3, maxRewinds: 5, maxToolCalls: 10 }
```

- The three subagents are independent LLM endpoints — they can target different
  providers/models (e.g. a heavy planner + a light executor). The executor must
  be a **tool-capable** model the backend accepts (OpenAI function format);
  `anthropic--claude-3-haiku` cannot do tool calls via SAP AI Core orchestration.
- **Per-role hints (operational scaffolding for weaker models).** The engine's
  role system prompts are agnostic and concise. An optional `subagents.<role>.hint`
  is appended to that role's system prompt to give it extra **operational
  guidance** — how to build the plan, how to execute a step, what to be strict
  about. Its main purpose is to **scaffold weaker models**: a capable model
  (Opus / Sonnet) usually needs none, while a smaller executor/planner model
  (e.g. `gpt-4o-mini`) may need the steering. A hint is **not** a domain
  description and must **not** name tools — the self-describing tool catalog and
  the agnostic prompt cover those, and richer per-situation procedures belong to
  the **skills RAG** (a separate, dynamic mechanism, not wired via `hint`).
  `controller-mixed.yaml` carries an executor hint as a worked example.
- Internal (MCP) tools are surfaced to the executor by **semantic top-K** from
  the vectorized tool catalog (`toolsRag`); a distance-based `targetState`
  strategy therefore needs an embedder (`consumer-confirm` does not).
- `DEBUG_CONTROLLER=1` logs (stderr) the step instructions the planner delegates
  and per-role/total token spend. The HTTP response always carries total `usage`.
- Ready-to-run examples: [`pipelines/controller.yaml`](../pipelines/controller.yaml)
  (all-sonnet, no hints) and [`pipelines/controller-mixed.yaml`](../pipelines/controller-mixed.yaml)
  (sonnet deciders + light `gpt-4o-mini` executor, with an executor hint that
  scaffolds the smaller model).

## Adding a custom pipeline (plugin)

A pipeline is an `IPipelinePlugin` (from `@mcp-abap-adt/llm-agent`): it names
itself, parses its own `config`, and builds an `IPipelineInstance` (`{ agent,
close }`). Server-side plugins receive an `IServerPipelineContext` (from
`@mcp-abap-adt/llm-agent-server-libs`) whose `createAgentBuilder()` returns a
builder pre-wired with all shared infra (RAG/MCP/embedder/adapters/subagents) —
the plugin only registers its coordinator and builds.

Load custom pipelines into the server by module specifier:

```yaml
plugins:
  - '@acme/superpuper-pipeline'   # npm package exporting PluginExports.pipelinePlugins
pipeline:
  name: superpuper
  config: { ... }
```

The package exports its plugins via the standard plugin surface:

```ts
// @acme/superpuper-pipeline
export const pipelinePlugins = { superpuper: new SuperPuperPipelinePlugin() };
```

Specifiers resolve against the user's `cwd`. The host merges each module's full
`PluginExports` (so a pipeline package may also ship `embedderFactories`,
`mcpClients`, etc.). Duplicate pipeline names across sources fail fast.

## Embedding in code (no YAML)

Consumers embedding the runtime build agents directly from components. The old
coordinator components remain available under `legacy/*` subpath exports:

```ts
import { DagCoordinatorHandler } from '@mcp-abap-adt/llm-agent-server-libs/legacy/dag';
import { DagPipelinePlugin }    from '@mcp-abap-adt/llm-agent-server-libs/dag';
```

Each built-in plugin has a subpath export (`./flat`, `./linear`, `./dag`,
`./stepper`, `./controller`). Two ways to use a pipeline without YAML:

```ts
// (a) Use the plugin programmatically — parse a config object, build against a
//     server pipeline context (createServerPipelineContext wires the infra).
import { ControllerPipelinePlugin } from '@mcp-abap-adt/llm-agent-server-libs/controller';
const plugin = new ControllerPipelinePlugin();
const cfg = plugin.parseConfig({ subagents: { evaluator, planner, executor } });
const { agent, close } = await plugin.build(cfg, serverCtx);

// (b) Compose the coordinator onto your own SmartAgentBuilder via the
//     ControllerFactory — an IPipelineFactory (kind 'controller'), the
//     code-level counterpart to the Stepper *Factory classes. It resolves the
//     three role LLMs via makeRoleLlm, wraps them as subagent clients, validates
//     the embedder requirement, and returns { handler }.
import { ControllerFactory } from '@mcp-abap-adt/llm-agent-server-libs/controller';
const { handler } = await new ControllerFactory().build(config, {
  // role ∈ 'evaluator' | 'planner' | 'executor'
  makeRoleLlm: (role) => makeLlm(config.subagents[role]),
  callMcp, backend, knowledgeRagFor, embedder, selectTools,
  // model ids for usage attribution are derived from the resolved LLMs.
});
const handle = await builder.withStepperCoordinator(handler).build();
// (The lower-level `ControllerCoordinatorHandler` is also re-exported from the
//  same subpath if you prefer to construct it directly with `config` inline.)
```

See `docs/ARCHITECTURE.md` for the layered design and `docs/QUICK_START.md` for
end-to-end setup.
