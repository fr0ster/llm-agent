# Pipelines

A **pipeline** decides which agent the server builds. It is selected by name in
YAML and resolved from a plugin registry. The server ships four built-in
pipelines; deployments can add their own as plugins.

```yaml
# smart-server.yaml
pipeline:
  name: stepper            # flat | linear | dag | stepper | <plugin name>
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
| `dag` | Planner → parallel workers → finalizer | `planner`, `reviewer`, `finalizer`, `errorStrategy`, `stateOracle`, `maxRoundTrips` |
| `stepper` | Composition flow (planner/executor/evaluator/reviewer/finalizer) | `mode` (`cyclic-react`/`planned-react`/`deep-stepper`), `flow`, `knowledgeSeed`, `maxParallelSteps`, `maxDepth`, `evaluator`, `reviewer` |

Stepper's `knowledgeSeed` (deployment-supplied tool guidance, seeded into a new
session's knowledge store) lives under `pipeline.config.knowledgeSeed`.

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

See `docs/ARCHITECTURE.md` for the layered design and `docs/QUICK_START.md` for
end-to-end setup.
