# @mcp-abap-adt/llm-agent-server-libs

The SmartServer composition runtime as an **importable library**. It sits between the binary `@mcp-abap-adt/llm-agent-server` and the core `@mcp-abap-adt/llm-agent-libs`, so the SmartServer/coordinator composition can be reused in other projects without depending on the CLI/HTTP binary.

## Top-level exports

- `SmartServer` — HTTP-less SmartServer composition (config → built agent/coordinator).
- `buildStepperRoot` / `buildFromComposition` — build a Stepper coordinator tree from a composition spec; `buildFromComposition` accepts a `makeRoleLlm(role)` callback so it is decoupled from the server's YAML LLM-map.
- `StepperCoordinatorHandler` — the `coordinator` stage handler for the Stepper runtime.
- Coordinator config parsing (`parseStepperCoordinatorConfig`, `StepperCompositionSpec`, `CompositionNode`, …), session stores, and `pipeline` wiring.

### Pipeline builder-factories

Each pipeline variant is a standalone, exportable factory implementing `IPipelineFactory<TConfig>` (from `@mcp-abap-adt/llm-agent`). `build(config, deps)` returns a `{ handler }` you register as the `coordinator` stage.

| Factory | `kind` | Pipeline |
|---|---|---|
| `LinearFactory` | `linear` | linear tool-loop coordinator |
| `DagFactory` | `dag` | DAG coordinator (parallel workers) |
| `CyclicFactory` | `cyclic` | Stepper — planner `none` + cyclic-react executor |
| `PlannedFactory` | `planned` | Stepper — LLM planner + cyclic-react executor |
| `DeepStepperFactory` | `deep-stepper` | Stepper — LLM planner + recursive executor |

```ts
import { CyclicFactory } from '@mcp-abap-adt/llm-agent-server-libs';

const { handler } = await new CyclicFactory().build(stepperConfig, {
  makeRoleLlm: async (role) => myLlm, // 'planner' | 'executor' | 'finalizer' | 'reviewer' | 'evaluator' | 'classifier'
  callMcp,
  knowledgeRagFor,
  toolsRag,
  mintStepperId: () => crypto.randomUUID(),
  mintTurnId: () => crypto.randomUUID(),
});
registry.set('coordinator', handler);
```

See `docs/INTEGRATION.md` (“Reusing pipeline builder-factories”) for the full example.

## Dependencies

Depends on `@mcp-abap-adt/llm-agent`, `@mcp-abap-adt/llm-agent-libs`, `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`. The binary `@mcp-abap-adt/llm-agent-server` depends on this package.
