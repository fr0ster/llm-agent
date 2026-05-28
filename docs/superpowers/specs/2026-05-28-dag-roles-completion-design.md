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
  /**
   * The interpreter's already-joined final output (today: terminal-leaf outputs
   * concatenated with \n\n). PassthroughFinalizer returns this verbatim to
   * preserve the current behaviour. LlmFinalizer/TemplateFinalizer typically
   * ignore it and re-derive from executionTrace.
   */
  interpreterOutput: string;
  /**
   * Execution-ordered (topological) list of DAG nodes that ran, with their
   * goal and output. Ordering follows the interpreter's actual run order,
   * NOT plan.nodes[] — after a splice that array can be non-topological.
   */
  executionTrace: ReadonlyArray<{
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
| **`PassthroughFinalizer`** (default) | none | Backward-compat: returns `input.interpreterOutput` verbatim — exactly what the DAG coordinator yields today (interpreter's terminal-leaf join with `\n\n`). |
| **`LlmFinalizer`** | one LLM call | DirectLlmSubAgent under the hood, with a `FINALIZER_SYSTEM` prompt and **no tools wired**. The LLM cannot tool-call; it can only write text from the trace context. |
| **`TemplateFinalizer`** | none | Deterministic join: `# Node {nodeId} — {goal}\n{output}` over the trace. Useful when the agent's plan is already shaped per-section. |

`FINALIZER_SYSTEM` (initial):

> You synthesize the final user-facing answer for a DAG-coordinated task. You will receive: (1) the user prompt, (2) the plan objective, (3) an ordered execution trace of completed DAG nodes (each with its goal and output). Produce the answer using ONLY the trace outputs. Do NOT propose new data collection. Do NOT include the trace structure in your reply unless the user asked for it. Address every part of the user's prompt.

### A.3 Handler integration (`DagCoordinatorHandler`)

`DagCoordinatorHandlerDeps` gains `finalizer?: IFinalizer` (optional in deps). The constructor **normalizes**: `this.finalizer = deps.finalizer ?? new PassthroughFinalizer()`. After normalization the field is always defined, so the handler body never deals with `undefined`. Existing direct-handler tests / consumers that omit `finalizer` get the default and unchanged behaviour.

**Interpreter changes (required for this fix):**

1. Today `DagPlanInterpreter` populates `result.executedPlan` only on failure (`packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts:187` returns `{ nodeResults, ok: true, output }` without `executedPlan` on success). The interpreter MUST also return `executedPlan: currentPlan` on the success path so recovered/replanned plans are visible to the finalizer.
2. **`InterpretResult` gains `executionOrder: readonly string[]`** — the actual topological execution order of node ids. The interpreter populates it as it runs nodes (it already iterates in topological order; just record the ids it visits in sequence). The finalizer trace iterates `executionOrder`, mapping each id to its `nodeResults[id]` and `executedPlan.nodes.find(n => n.id === id)`. This is the authoritative ordering — `executedPlan.nodes[]` is NOT topological after a splice (`spliceSubPlan` returns `[...rest, ...splicedSubNodes]` per `coordinator/dag/splice-sub-plan.ts:40`).

A regression test asserts (a) `executedPlan` reflects post-splice nodes on a successful replan run, and (b) `executionOrder` is topologically valid after splice (every node id appears after all its `dependsOn`).

After `result = await interpreter.interpret(plan, ...)` returns `ok === true`, the handler invokes the finalizer via the existing `runRole(component, model, thunk)` (which already handles usage logging on happy-path + clarify/needInfo signal paths + parse-error paths). The trace MUST be built from `result.executedPlan` (now populated on success too — see interpreter change above), falling back to the original `plan` only when the interpreter did not return it for some reason (legacy guard):

```ts
const executedPlan = result.executedPlan ?? plan;
const nodeIndex = new Map(executedPlan.nodes?.map((n) => [n.id, n]) ?? []);
// Use the interpreter's actual execution order (topological), NOT plan.nodes[]
// which can be non-topological after a splice.
const executionTrace = (result.executionOrder ?? []).map((id) => ({
  nodeId: id,
  goal: nodeIndex.get(id)?.goal ?? '',
  output: result.nodeResults[id]?.output ?? '',
}));
const finalRes = await runRole('finalizer', this.finalizer.model, () =>
  this.finalizer.finalize({
    prompt: ctx.inputText,
    // DagPlan.objective is optional; fall back to the original user prompt so
    // FinalizerInput.objective remains a non-empty required string.
    objective: executedPlan.objective ?? ctx.inputText,
    ancestorContext,
    interpreterOutput: result.output,   // verbatim what DAG yields today
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

> **Note on `FinalizerInput.objective`:** the interface keeps it **required** (`objective: string`) — the call site fills it from `plan.objective ?? prompt` so consumers always see a non-empty value.

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
  // no `model` exposed — inner ISubAgent runs a full pipeline; its LLM
  // activity is logged by the wrapped pipeline's handlers under their own
  // component labels (tool-loop, classifier, translate, …) via the SHARED
  // session logger. Therefore this adapter intentionally returns
  // `usage: undefined`; otherwise the handler's `logRoleUsage('oracle', ...)`
  // would double-count tokens already in the per-traceId delta.
  async query(input: StateOracleInput): Promise<StateOracleResult> {
    const res = await this.inner.run({
      task: input.query,
      sessionId: input.sessionId,
      signal: input.signal,
      trace: input.trace,           // worker pipeline still attributes by traceId
      sessionLogger: input.sessionLogger,
    });
    return { answer: res.output, usage: undefined };
  }
}
```

**Double-count avoidance contract:** `IStateOracle.query` returns `usage` ONLY when the implementation invokes an LLM in a path that does NOT log to the shared `requestLogger`. SubAgentStateOracle's inner pipeline DOES log (via worker setup), so usage stays `undefined`. A pure `DirectLlmSubAgent`-backed oracle (rare; not the standard config) would set usage normally because DirectLlmSubAgent bypasses pipeline logging. Handler's `logRoleUsage('oracle', usage)` is a no-op when usage is undefined.

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

### C.2 Backward-compat shim + types + lookup helper

**Type widening.** `SmartServerConfig.llm` (currently flat `LlmProviderConfig` in `packages/llm-agent-server/src/smart-agent/smart-server.ts:~189`) becomes **optional** + discriminated:

```ts
// before
llm: LlmProviderConfig;
// after
llm?: LlmProviderConfig | Record<string, LlmProviderConfig>;   // OPTIONAL: pipeline-only configs already work without it
```

`llm:` stays **optional** to preserve the existing "pipeline.llm.main is enough" path (`packages/llm-agent-server/src/smart-agent/__tests__/config-validation.test.ts:310` — pipeline-only configs valid without top-level `llm`). When absent, the normalizer returns `undefined`. Coordinator role resolution then falls back through a chain (`pipeline.llm.main` is the final default) — see the **Downstream consumers** section below for the full lookup order. The only error case is when NEITHER a top-level `llm:` NOR a `pipeline.llm.main` is configured AND a coordinator role needs an LLM.

**After normalization** (used by all downstream consumers that need a coordinator-level LLM map):

```ts
type NormalizedLlmMap = { main: LlmProviderConfig } & Record<string, LlmProviderConfig>;
// invariant: `main` is always present after normalization (when the map exists at all).
```

**Normalizer** (one branch in the parse step):

```ts
function normalizeLlmConfig(input?: SmartServerConfig['llm']): NormalizedLlmMap | undefined {
  if (input === undefined) return undefined;        // pipeline-only configs are unaffected
  // Heuristic: flat shape has a `provider` string at the top.
  if (typeof (input as LlmProviderConfig).provider === 'string') {
    return { main: input as LlmProviderConfig };    // backward-compat wrap
  }
  const map = input as Record<string, LlmProviderConfig>;
  if (!map.main) {
    throw new ConfigError("llm: map MUST include a 'main' key (default LLM for unspecified roles)");
  }
  return map as NormalizedLlmMap;
}
```

**Lookup helper** (`resolveLlmConfig(map, name?): LlmProviderConfig`):

```ts
function resolveLlmConfig(map: NormalizedLlmMap | undefined, name?: string): LlmProviderConfig | undefined {
  if (!map) return undefined;                       // caller decides whether undefined is an error
  if (!name || name === 'main') return map.main;
  const found = map[name];
  return found ?? map.main;                         // fall back to main if the named key is missing
}
```

**Downstream consumers** — `resolveSmartServerConfig` (`packages/llm-agent-server/src/smart-agent/config.ts:~842`) is updated to:
- Continue to allow a missing `llm:` block when `pipeline.llm.main` is present (pipeline-only flat config path stays valid).
- When `llm:` is present, route through the normalizer.
- **Coordinator role resolution falls back through both maps.** Today the server already constructs the DAG planner's `mainLlm` from `pipeline.llm.main` when top-level `llm:` is missing (`packages/llm-agent-server/src/smart-agent/smart-server.ts:618`, `:906`). To preserve that behaviour, role lookup chains: `resolveLlmConfig(normalizedTopLevelLlm, name)` → `resolveLlmConfig(normalizedTopLevelLlm, 'main')` → **`pipeline.llm.main`** (read once, normalized in the same way). Only if NONE resolve does the lookup throw `ConfigError("coordinator.<role> requires an LLM config: provide top-level llm.<name>, llm.main, or pipeline.llm.main")`. Pipeline-only configs that don't reference per-role LLMs continue working unchanged.

**Reviewer key naming + backward-compat alias.** The existing config validator and tests use `coordinator.reviewer.plannerLlm` (`packages/llm-agent-server/src/smart-agent/config.ts:44`, `packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts:105`). The new design's semantically correct field name is `reviewerLlm`. To avoid breaking existing configs, accept BOTH:

```ts
const reviewerLlmName =
  cfg.coordinator?.reviewer?.reviewerLlm
  ?? cfg.coordinator?.reviewer?.plannerLlm   // accepted alias (deprecated)
  ?? undefined;                              // falls back to 'main' via resolveLlmConfig
```

When `plannerLlm` is read from a `reviewer:` block, emit a `log({type:'warning'})` noting the rename. Same alias applies to `coordinator.reviewer.recoveryReviewer.plannerLlm` (if such field exists in the current config — keep parity).

**Validation:** the normalizer enforces `main` presence WHEN the map is given; arbitrary other keys are allowed (forward-compat for future roles 3–9). Unknown reference (e.g. `plannerLlm: missing`) silently falls back to `main` — the lookup helper never throws; a startup-time `log({type:'warning'})` notes the fallback for visibility.

Existing flat configs continue working: they're rewritten to `{ main: <flat> }` before any downstream code sees them. Pipeline-only configs (no top-level `llm:`) also continue working unchanged.

### C.3 Worker LLM map (out of scope)

Worker-level `pipeline.llm.{main,classifier,helper}` already follows this pattern. No change there. The top-level `llm:` map is the symmetric pattern at the coordinator level.

## D. Logger

`LlmComponent` widened with `'finalizer'` and `'oracle'`. `CATEGORY_MAP` (the shared one in `default-request-logger.ts`, also consumed by `SessionRequestLogger.aggregate`) maps both → `auxiliary`. No `/v1/usage` schema change — new `byComponent` keys naturally appear when the roles fire.

## E. Provability tests

1. **`PassthroughFinalizer`** returns the last-leaf-node output without invoking any LLM.
2. **`LlmFinalizer`** invokes the underlying `ILlm` (1) with no tools attached and (2) with the `FINALIZER_SYSTEM` prompt; returns `output` + `usage`.
3. **`TemplateFinalizer`** composes a deterministic markdown join of trace outputs.
4. **DAG coordinator** invokes `finalizer.finalize(...)` after `interpreter.interpret(...)` returns `ok=true`; finalizer tokens land in `/v1/usage.byComponent.finalizer`.
5. **`SubAgentStateOracle`** (subagent-backed, default for our YAML) maps `query.query → ISubAgentInput.task` and `ISubAgentResult.output → result.answer`; forwards `trace`/`sessionLogger` so the inner pipeline self-attributes by traceId; **returns `usage: undefined`** to honour the double-count contract (B.2).
6. **`stateOracle.query(...)`** on subagent-backed oracle **does NOT add anything to `byComponent.oracle`** — its inner pipeline's tokens already land under the wrapped components (`tool-loop`, `classifier`, …) of the SAME traceId.
6a. **Pure-LLM oracle** (a DirectLlmSubAgent-backed `IStateOracle` impl — not the default; consumers that wire one directly): returns `usage` populated and `stateOracle.query` logs `byComponent.oracle` via `runRole`. This is exercised by a unit test against an explicit `LlmStateOracle`-shaped stub.
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
- `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts` — **success path returns `executedPlan: currentPlan`** so recovery/replan splices are visible to the finalizer (today only set on failure).
- `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` — invoke finalizer after `interpret` (trace from `result.executedPlan`); replace `stateOracle.run(...)` with `stateOracle.query(...)`; surface usage for both via `runRole`; normalize `deps.finalizer ?? new PassthroughFinalizer()` in constructor.
- **`packages/llm-agent-server/src/smart-agent/config.ts`** — `SmartServerConfig.llm` widened to optional union; `normalizeLlmConfig` + `resolveLlmConfig`; reviewer key alias (`reviewerLlm` || `plannerLlm`-deprecated with warning); validate `llm.main` presence in map; coordinator role lookup chain (top-level llm → llm.main → pipeline.llm.main). Update existing validation/tests to allow the new map shape.
- `packages/llm-agent-server/src/smart-agent/smart-server.ts` — wire normalized LLM map into `resolveLlmConfig` calls at planner/reviewer/finalizer construction sites; parse `coordinator.finalizer.*` block; auto-wrap resolved oracle `ISubAgent` in `SubAgentStateOracle`.
- Tests across all touched units (interface contracts, impls, handler integration, interpreter `executedPlan` on success, YAML normalizer, reviewer alias, oracle adapter double-count contract).

## Out of scope

- Per-role LLM for worker-internal stages — workers already have `pipeline.llm.{main,classifier,helper}`.
- `IBudgetStrategy`, `IDispatchStrategy`, `IPlanReducer`, `IClarificationStrategy`, `ITraceFormatter`, `ISessionGraphFactory` as interface, `IRagAccessPolicy` — planned for a future epic.
- Finalizer with tools enabled (intentional restriction: tools-free guarantees the LLM cannot escape into another tool-loop).
