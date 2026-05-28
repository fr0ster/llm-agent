# DAG Coordinator Role Completion — Design

**Status:** active (design approved 2026-05-28)
**Scope:** session-scoped-infrastructure epic (PR #163) — additive enhancement to the DAG coordinator.

## Goal

Close two architectural gaps in the DAG coordinator surfaced by live-testing the session-scoped infrastructure:

1. **No structural guarantee that the response is synthesized.** Today the DAG coordinator yields the output of the last executed DAG node as the user-facing answer. Whether that output is a clean review or mid-tool-loop narration depends entirely on how the worker LLM behaves under its iteration budget. The architecture leaves quality to model behaviour; a strong model (Sonnet 4.6) handles it, a weaker one (DeepSeek) does not.
2. **The state oracle is an untyped role.** The handler dispatches it as a raw `ISubAgent.run(...)`, with the meaning of `task`/`output` only conveyed by the call-site code. Every other DAG role (`IPlanner`, `IReviewStrategy`, `IInterpreter`, `IErrorStrategy`, `IActivationStrategy`) is a typed role with a clear contract.

The epic also showed that DAG roles should not all share one LLM: planning + synthesis benefit from a stronger model (cost ~2.4M tokens for a single Sonnet-driven review), while worker tool-loop runs fine on a cheaper one. The current YAML schema only supports one top-level `llm:` block and a single `plannerLlm: main` reference, which forces one model across the whole coordinator.

This design adds:

- **`IFinalizer`** — a new typed DAG role that produces the user-facing answer after the DAG completes, independent of worker behaviour.
- **`IStateOracle`** — a typed view over the existing raw-`ISubAgent` oracle, with a thin domain-neutral contract.
- **Per-role LLM selection** via extending `llm:` from a flat block into a named map (`llm.main`, `llm.planner`, `llm.finalizer`, …), with a backward-compatible shim so existing flat-`llm:` configs keep working as `llm.main`.

## A. `IFinalizer`

### A.1 Interface

`packages/llm-agent/src/interfaces/finalizer.ts`:

```ts
export interface FinalizerInput {
  prompt: string;                       // the original user request
  objective: string;                    // plan.objective from the planner
  ancestorContext?: ContextPath;        // inherited clarifications + oracle observations
  executionTrace: ReadonlyArray<{       // ordered DAG execution outputs
    nodeId: string;
    goal: string;
    output: string;
  }>;
  sessionId?: string;
  signal?: AbortSignal;
  trace?: { traceId: string };          // request trace context (for usage attribution)
}

export interface FinalizerResult {
  output: string;                       // user-facing answer
  usage?: LlmUsage;                     // surface to logRoleUsage()
}

export interface IFinalizer {
  readonly name: string;
  readonly model?: string;              // best-effort, for logger attribution
  finalize(input: FinalizerInput): Promise<FinalizerResult>;
}
```

`LlmComponent` gains `'finalizer'`. `CATEGORY_MAP` maps it to `auxiliary` (same as planner/reviewer/classifier/translate/helper).

### A.2 Implementations

| Impl | LLM cost | When |
|---|---|---|
| **`PassthroughFinalizer`** (default) | none | Backward-compat: returns `trace[trace.length-1].output`. Equivalent to the current behaviour. |
| **`LlmFinalizer`** | one LLM call | DirectLlmSubAgent under the hood, with a `FINALIZER_SYSTEM` prompt and **no tools wired**. The LLM cannot tool-call; it can only write text from the trace context. |
| **`TemplateFinalizer`** | none | Deterministic join: `# Node {nodeId} — {goal}\n{output}` over the trace. Useful when the agent's plan is already shaped per-section. |

`FINALIZER_SYSTEM` (initial):

> You synthesize the final user-facing answer for a DAG-coordinated task. You will receive: (1) the user prompt, (2) the plan objective, (3) an ordered execution trace of completed DAG nodes (each with its goal and output). Produce the answer using ONLY the trace outputs. Do NOT propose new data collection. Do NOT include the trace structure in your reply unless the user asked for it. Address every part of the user's prompt.

### A.3 Handler integration (`DagCoordinatorHandler`)

`DagCoordinatorHandlerDeps` gains `finalizer?: IFinalizer` (optional). Server-side default is `PassthroughFinalizer` — existing configs see no behaviour change.

After `result = await interpreter.interpret(plan, ...)` returns `ok === true`, the handler invokes the finalizer via the existing `runRole(component, model, thunk)` (which already handles usage logging on happy-path + clarify/needInfo signal paths + parse-error paths):

```ts
const executionTrace = (plan.nodes ?? []).map((n) => ({
  nodeId: n.id,
  goal: n.goal,
  output: result.nodeResults[n.id]?.output ?? '',
}));
const finalRes = await runRole('finalizer', this.deps.finalizer.model, () =>
  this.deps.finalizer.finalize({
    prompt: ctx.inputText,
    objective: plan.objective,
    ancestorContext,
    executionTrace,
    sessionId: ctx.sessionId,
    signal: ctx.options?.signal,
    trace: ctx.options?.trace,
  }),
);
if ('ended' in finalRes) return true;       // clarify/needInfo from the finalizer
const finalText = finalRes.value.output;
ctx.yield({ ok: true, value: { content: finalText } });
// terminal stop chunk with usage from getSummary(traceId) — already in dag-coordinator
```

The terminal `finishReason:'stop'` yield's `usage` (added in commit `9275850` / Fix #12) automatically picks up finalizer tokens because they were logged via `logRoleUsage`.

### A.4 YAML

```yaml
coordinator:
  finalizer:
    type: passthrough         # passthrough | llm | template (default: passthrough)
    # for type=llm:
    # finalizerLlm: finalizer  # name of an llm.* key; defaults to 'main'
    # systemPrompt: ...        # override FINALIZER_SYSTEM
```

When `finalizer:` block is absent → `PassthroughFinalizer`. Existing configs continue working unchanged.

## B. `IStateOracle`

### B.1 Interface

`packages/llm-agent/src/interfaces/state-oracle.ts`:

```ts
export interface StateOracleInput {
  query: string;                        // domain-neutral question
  sessionId?: string;
  signal?: AbortSignal;
  trace?: { traceId: string };
  sessionLogger?: { logStep(name: string, data: unknown): void };
}

export interface StateOracleResult {
  answer: string;
  usage?: LlmUsage;
}

export interface IStateOracle {
  readonly name: string;
  readonly model?: string;
  query(input: StateOracleInput): Promise<StateOracleResult>;
}
```

`LlmComponent` gains `'oracle'`. `CATEGORY_MAP` maps it to `auxiliary`.

### B.2 Backward-compat adapter

Most existing configs reference the oracle by subagent name (`coordinator.stateOracle: <name>`); the server resolves the name to an `ISubAgent` instance. To keep these configs working unchanged, the server **automatically wraps** the resolved `ISubAgent` in a `SubAgentStateOracle` adapter before passing it to the handler:

```ts
// packages/llm-agent-libs/src/coordinator/dag/subagent-state-oracle.ts
export class SubAgentStateOracle implements IStateOracle {
  constructor(private readonly inner: ISubAgent) {}
  get name() { return this.inner.name; }
  // no model exposed — inner ISubAgent doesn't expose one
  async query(input: StateOracleInput): Promise<StateOracleResult> {
    const res = await this.inner.run({
      task: input.query,
      sessionId: input.sessionId,
      signal: input.signal,
      trace: input.trace,
      sessionLogger: input.sessionLogger,
    });
    return { answer: res.output, usage: res.usage };
  }
}
```

`DagCoordinatorHandlerDeps.stateOracle` type changes from `ISubAgent | undefined` to `IStateOracle | undefined`. This is an internal contract — server wires the adapter automatically; consumer YAML stays identical.

### B.3 Handler integration

In `runRole`'s `NeedInfoSignal` branch:

```ts
const ans = await stateOracle.query({
  query: (err as NeedInfoSignal).query,
  sessionId: ctx.sessionId,
  signal: ctx.options?.signal,
  trace: ctx.options?.trace,
  sessionLogger: ctx.options?.sessionLogger,
});
ancestorContext.oracleObservations.push({ query: (err as NeedInfoSignal).query, answer: ans.answer });
// + logRoleUsage('oracle', stateOracle.model, ans.usage, durationMs)
```

## C. `llm:` map + per-role LLM lookup

### C.1 YAML schema change

`llm:` becomes a map keyed by role name. Concrete LLM configs (provider/apiKey/model/temperature/…) live under each key:

```yaml
llm:
  main:                              # default for any role that doesn't override
    provider: deepseek
    apiKey: ${DEEPSEEK_API_KEY}
    model: ${DEEPSEEK_MODEL:-deepseek-chat}
    temperature: 0.5
  planner:                           # stronger model for plan decomposition
    provider: sap-ai-sdk
    model: ${SAP_AI_MODEL_PLANNER:-anthropic--claude-4.6-sonnet}
    resourceGroup: ${SAP_AI_RESOURCE_GROUP:-default}
    temperature: 0.2
  finalizer:                         # same/another strong model for synthesis
    provider: sap-ai-sdk
    model: ${SAP_AI_MODEL_FINALIZER:-anthropic--claude-4.6-sonnet}
    resourceGroup: ${SAP_AI_RESOURCE_GROUP:-default}
    temperature: 0.2
  # reviewer, oracle similarly when needed
```

`coordinator.planner.plannerLlm`, `coordinator.finalizer.finalizerLlm`, `coordinator.reviewer.reviewerLlm` reference keys in `llm:`. Unspecified or missing key → fall back to `llm.main`.

### C.2 Backward-compat shim

The server's YAML normalizer runs once after parsing:

```ts
if (cfg.llm && typeof cfg.llm.provider === 'string') {
  // Flat shape detected → wrap as { main: <flat> }
  cfg.llm = { main: cfg.llm };
}
```

Existing flat configs continue to work as `llm.main`. No consumer change required.

### C.3 Worker LLM map (out of scope)

Worker-level `pipeline.llm.{main,classifier,helper}` already follows this pattern. No change there. The top-level `llm:` map is the symmetric pattern at the coordinator level.

## D. Logger

`LlmComponent` widened with `'finalizer'` and `'oracle'`. `CATEGORY_MAP` (the shared one in `default-request-logger.ts`, also consumed by `SessionRequestLogger.aggregate`) maps both → `auxiliary`. No `/v1/usage` schema change — new `byComponent` keys naturally appear when the roles fire.

## E. Provability tests

1. **`PassthroughFinalizer`** returns the last-leaf-node output without invoking any LLM.
2. **`LlmFinalizer`** invokes the underlying `ILlm` (1) with no tools attached and (2) with the `FINALIZER_SYSTEM` prompt; returns `output` + `usage`.
3. **`TemplateFinalizer`** composes a deterministic markdown join of trace outputs.
4. **DAG coordinator** invokes `finalizer.finalize(...)` after `interpreter.interpret(...)` returns `ok=true`; finalizer tokens land in `/v1/usage.byComponent.finalizer`.
5. **`SubAgentStateOracle`** maps `query.query → ISubAgentInput.task`; `ISubAgentResult.output → query result.answer`; usage forwarded.
6. **`stateOracle.query(...)`** logs `byComponent.oracle` via `runRole`.
7. **YAML normalizer**: flat `llm: { provider: X, ... }` is rewritten to `llm: { main: { provider: X, ... } }` before consumption.
8. **YAML normalizer**: a `llm:` map with multiple keys (`llm.main`, `llm.planner`) resolves `coordinator.planner.plannerLlm: planner` to the correct concrete config.
9. **Default fallback**: `coordinator.planner.plannerLlm` absent → planner uses `llm.main`.

## Files

### Create (6)
- `packages/llm-agent/src/interfaces/finalizer.ts`
- `packages/llm-agent/src/interfaces/state-oracle.ts`
- `packages/llm-agent-libs/src/coordinator/dag/passthrough-finalizer.ts`
- `packages/llm-agent-libs/src/coordinator/dag/llm-finalizer.ts`
- `packages/llm-agent-libs/src/coordinator/dag/template-finalizer.ts`
- `packages/llm-agent-libs/src/coordinator/dag/subagent-state-oracle.ts`

### Modify
- `packages/llm-agent/src/interfaces/request-logger.ts` — `LlmComponent` += `'finalizer' | 'oracle'`.
- `packages/llm-agent-libs/src/logger/default-request-logger.ts` — `CATEGORY_MAP` += `finalizer → auxiliary`, `oracle → auxiliary`.
- `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` — invoke finalizer after `interpret`; replace `stateOracle.run(...)` with `stateOracle.query(...)`; surface usage for both via `runRole`.
- `packages/llm-agent-server/src/smart-agent/smart-server.ts` — flat-`llm:` shim; resolve `plannerLlm`/`finalizerLlm`/`reviewerLlm` by key; auto-wrap resolved oracle `ISubAgent` in `SubAgentStateOracle`; parse `coordinator.finalizer.*` block.
- Tests across all touched units (interface contracts, impls, handler integration, YAML normalizer).

## Out of scope

- Per-role LLM for worker-internal stages — workers already have `pipeline.llm.{main,classifier,helper}`.
- `IBudgetStrategy`, `IDispatchStrategy`, `IPlanReducer`, `IClarificationStrategy`, `ITraceFormatter`, `ISessionGraphFactory` as interface, `IRagAccessPolicy` — planned for a future epic.
- Finalizer with tools enabled (intentional restriction: tools-free guarantees the LLM cannot escape into another tool-loop).
