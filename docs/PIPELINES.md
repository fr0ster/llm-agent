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
        hint: The target system is a live SAP/ABAP system.   # optional, see below
      planner:                       # returns the next step / done / rewind
        provider: sap-ai-sdk
        model: anthropic--claude-4.6-sonnet
      executor:                      # carries out a step; emits tool calls
        provider: sap-ai-sdk
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
- **Domain hints (agnostic engine, gnostic config).** The engine's role system
  prompts are **domain-agnostic** — they say "the live target system", never
  "SAP"/"ABAP". A deployment re-specialises a role by setting an optional
  `subagents.<role>.hint`: a short domain preamble appended to that role's system
  prompt (e.g. naming the SAP/ABAP target and the kinds of facts to fetch). Omit
  the hints for a generic, domain-neutral controller. This is the **static**
  gnosticization channel; the **dynamic** one — procedural skills retrieved from
  a RAG collection at the right moment — is a separate mechanism (not wired via
  `hint`). The shipped `pipelines/controller*.yaml` carry SAP/ABAP hints as a
  worked example.
- Internal (MCP) tools are surfaced to the executor by **semantic top-K** from
  the vectorized tool catalog (`toolsRag`); a distance-based `targetState`
  strategy therefore needs an embedder (`consumer-confirm` does not).
- `DEBUG_CONTROLLER=1` logs (stderr) the step instructions the planner delegates
  and per-role/total token spend. The HTTP response always carries total `usage`.
- Ready-to-run examples: [`pipelines/controller.yaml`](../pipelines/controller.yaml)
  (agnostic, all-sonnet, no domain hints), [`pipelines/controller-sap.yaml`](../pipelines/controller-sap.yaml)
  (SAP/ABAP-specialised via per-role hints), and [`pipelines/controller-sap-mixed.yaml`](../pipelines/controller-sap-mixed.yaml)
  (SAP/ABAP, sonnet decider + light `gpt-4o-mini` executor). Gnostic configs are
  named for their specialization (`-sap`); the bare `controller.yaml` is the
  neutral template.

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

// (b) Compose the coordinator directly onto your own SmartAgentBuilder. The
//     controller's building blocks are re-exported from the same subpath.
import {
  ControllerCoordinatorHandler,
  makeSubagentClient,
} from '@mcp-abap-adt/llm-agent-server-libs/controller';
const handler = new ControllerCoordinatorHandler({
  evaluator: makeSubagentClient(evaluatorLlm),   // ISubagentClient over any ILlm
  planner:   makeSubagentClient(plannerLlm),
  executor:  makeSubagentClient(executorLlm),
  backend, knowledgeRagFor, embedder, callMcp, selectTools, config,
});
const handle = await builder.withStepperCoordinator(handler).build();
```

See `docs/ARCHITECTURE.md` for the layered design and `docs/QUICK_START.md` for
end-to-end setup.
