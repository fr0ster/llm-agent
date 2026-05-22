# Nested Subagent Dispatch Design

> **Status:** Design, not implemented. After this spec is approved, the writing-plans skill produces the implementation plan.

## Goal

Replace the current "subagent = wrapped SmartAgent, dispatched by Coordinator" model with a richer orchestration substrate that supports:

1. **Explicit subagent context assembly**: analyze the current task, retrieve relevant project/domain context from RAG, retrieve relevant MCP tool descriptions from MCP-RAG, and pass only the bounded result to the selected subagent.
2. **Two subagent execution types**: autonomous agents with their own full pipeline, and constrained leaf agents that run one LLM call over injected context.
3. **Nested dispatch with bounded depth**: an agent can dispatch other agents as steps in its plan. Depth is bounded — typical deployments stay at depth 0→1; deeper nesting is opt-in, never default.
4. **Three artifact scopes**: consumer artifacts, per-layer orchestrator artifacts, and per-layer subagent artifacts.
5. **Bounded failure handling**: retries, replanning, and eventual epicfail propagation are defined as a later phase, not a prerequisite for the first implementation.

This supersedes the structured-briefing direction explored in PR #132. That PR will be closed. The coordinator must not automatically pass previous step outputs as subagent context. Previous step results remain local execution state, not knowledge context.

## Non-Goals

- This spec does NOT define a new consumer-facing `SmartServer` request schema for conversational mode.
- This spec does NOT introduce a mandatory new artifact storage layer in llm-agent.
- This spec does NOT implement parallel dispatch in the first phase.
- This spec does NOT require the new error policy to ship together with nested-dispatch support.
- Specific UI/CLI changes for showing dispatch depth or epicfail traces are deferred.

---

## Core Principle: Context Is Assembled, Not Inherited

Subagents should receive a self-contained `task` plus an explicit `context` string. That context is built for the current dispatch only. It is not copied from the coordinator's previous step history.

The dispatcher is responsible for context assembly:

1. Analyze the current step/task.
2. Query regular RAG stores for domain, project, history, or artifact context.
3. Query MCP-RAG/tool-description stores for relevant tool affordances, schemas, and examples.
4. Optionally fetch exact consumer artifacts by id through MCP.
5. Compose a bounded textual `context` for the subagent.

Successful or failed prior `stepResults` are not included by default. They may only influence context if the current step explicitly depends on a prior step output, and then the planner must put that dependency into the step task or artifact reference.

---

## Concept: SmartAgent and Subagent share the same contract

A `SmartAgent` viewed from the consumer side is the orchestrator. The same kind of object, when dispatched as a step of a parent's plan, is a subagent — but each subagent is its own distinct instance with its own configuration. This is nested delegation, not recursion: nothing self-references itself.

The current `SmartAgentSubAgent` already reflects this — it wraps a separate `SmartAgent` and exposes the `ISubAgent` contract.

The asymmetry between parent and child comes from execution position (layer) and from the agent capability type:

- **Autonomous**: runs the full SmartAgent pipeline; at layer 0 it may dispatch its own children when the deployment explicitly configures them.
- **Constrained**: runs a single LLM call over injected context. Always a leaf — never dispatches anyone.

By default the system stays at depth 0→1 (root orchestrator + flat subagent registry). Deeper nesting requires the deployment to explicitly configure subagents inside subagents, and even then `maxLayer` defaults are conservative. There is no goal to enable "agents spawning agents for the sake of it".

---

## Subagent Types and Capabilities

`ISubAgent` needs explicit capability metadata. The planner and the plan validator cannot enforce layer rules from `description` alone.

```typescript
type SubAgentKind = 'autonomous' | 'constrained';

interface SubAgentCapabilities {
  kind: SubAgentKind;
  canRecurse: boolean;
  contextPolicy: 'required' | 'optional' | 'forbidden';
}

interface ISubAgent {
  readonly name: string;
  readonly description?: string;
  readonly capabilities: SubAgentCapabilities;
  run(input: ISubAgentInput): Promise<ISubAgentResult>;
}
```

### Autonomous: SmartAgentSubAgent

- Wraps a full `SmartAgent`.
- Has its own system prompt, RAG stores, MCP graph, skills, classifier, and optional CoordinatorHandler.
- Receives `{ task, context?, sessionId?, signal?, layer }`.
- Treats `context` as an optional preamble to the task.
- May dispatch child subagents when `layerConfig[layer]` allows autonomous execution.
- Uses its own internal `PipelineContext`; its internal `stepResults` are invisible to the parent.

### Constrained: DirectLlmSubAgent

- New leaf-node implementation.
- Composes only `ILlm` plus a system prompt.
- Has no RAG, MCP, skills, classifier, or coordinator.
- Receives `{ task, context?, sessionId?, signal?, layer }`.
- Cannot recurse.
- Internally performs one LLM chat call: system prompt + context preamble + user task.
- Usually uses `contextPolicy: 'required'`, but the policy is metadata rather than a hardcoded class rule. Some constrained agents may accept empty context when the task is self-contained.

Both implementations share the same registry and dispatch path. The planner chooses agents by name/description, while validation enforces `capabilities`.

---

## Dispatch Context Assembly

The first implementation must add a dedicated context builder. Without this component, removing briefing leaves no reliable replacement for useful subagent context.

```typescript
interface SubAgentContextRequest {
  task: string;
  step: PlanStep;
  agent: ISubAgent;
  layer: number;
  inputText: string;
  sessionId: string;
  signal?: AbortSignal;
}

interface SubAgentContextResult {
  context: string;
  sources: Array<{ kind: 'rag' | 'tool-rag' | 'artifact'; ref: string }>;
}

interface ISubAgentContextBuilder {
  build(req: SubAgentContextRequest): Promise<SubAgentContextResult>;
}
```

Context assembly rules:

- Query project/domain RAG first using the current task.
- Query MCP-RAG/tool descriptions second using an enriched query built from the task plus top RAG snippets.
- Fetch exact artifacts only when the task references artifact ids or when the planner emits explicit artifact references.
- Bound the final context by token budget.
- Include source refs for logging and debugging.
- Do not include arbitrary prior `stepResults`.
- If an agent has `contextPolicy: 'required'` and the builder returns empty context, plan validation or dispatch returns an `orchestrator-fault`.

Autonomous subagents can either receive the assembled context or fetch their own context through MCP. The default should be conservative: pass a compact context when the parent already has high-confidence retrieval results, otherwise let the autonomous agent retrieve inside its own pipeline.

---

## Layers and Bounded Depth

Each `SmartAgent` invocation carries a `layer` integer:

- Root consumer-facing calls use `layer = 0`.
- A parent at layer `L` dispatches every child with `layer = L + 1`.
- `SmartAgent.process()` receives `layer` through `AgentCallOptions`.
- `PipelineContext.layer` is initialized from `options.layer ?? 0`.

The default architectural invariant is a single rule, not a per-layer rule table:

```typescript
interface CoordinatorConfig {
  // ... existing fields
  maxLayer?: number;  // Default: 1. Deeper dispatch is forbidden.
}
```

**Invariants:**

- `layer === 0` (root) may dispatch any kind of subagent — autonomous or constrained.
- `layer >= 1` may dispatch only constrained subagents. Autonomous subagent dispatch is forbidden past the root by default.
- `layer >= maxLayer` cannot dispatch at all. The current agent must execute the request itself through its normal (non-coordinator) pipeline path.

This is intentionally restrictive: the typical deployment lives at depth 0→1 and gets clean behavior without configuration. A deployment that genuinely needs depth 0→1→2 must:

1. Raise `maxLayer` to 2 explicitly.
2. Confirm that all subagents reachable at layer 1 are autonomous and dispatch only constrained children.

Beyond `maxLayer = 2`, this design considers the use case unsupported. Anyone who needs it must extend the configuration explicitly; YAGNI for now.

Validation runs before plan execution so the planner can be corrected or the plan can be rejected early. Dispatch performs a defensive capability check as well.

The "execute itself" fallback (when dispatch is forbidden at the current layer) is NOT the current `SelfDispatch` class. `SelfDispatch` is a single `ILlm.chat` dispatch strategy used inside a plan. The fallback here means the SmartAgent continues through its regular pipeline/tool-loop path instead of attempting to plan child dispatches.

---

## Artifacts: Three Scopes

| Scope | Producer | Storage | Visibility | Lifetime |
|---|---|---|---|---|
| **Consumer artifacts** | Consumer or explicit artifact MCP tools | Consumer-controlled store, or optional built-in artifact MCP package | Visible only through allowed MCP tools and artifact ids | Persistent until consumer deletes |
| **Per-layer orchestrator artifacts** | Current layer coordinator | `PipelineContext.stepResults` | Current layer only | One plan execution |
| **Per-layer subagent artifacts** | Child autonomous subagent | Child `PipelineContext.stepResults` | Child only | One subagent invocation |

Consumer artifacts are the only persistent cross-turn layer. They are accessed through MCP tools. A rich client can provide its own artifact MCP server. A thin client may opt into a built-in artifact MCP package.

`get_artifact(id)` must be exact key-value retrieval, not semantic RAG. RAG can support artifact search/discovery, but exact artifact reads must not return approximate matches.

Consumer artifact access must be capability-bounded:

- The parent planner may include explicit artifact refs in a step.
- The context builder may fetch those refs and inject selected content.
- Child agents should only receive artifact ids or content that the parent layer intentionally grants.
- "Visible to any layer" means technically reachable through MCP when granted, not automatically exposed to every layer.

Per-layer artifacts never escape their layer. Parent agents receive only a child subagent's final `output` string and optional public metadata.

---

## Dispatch Protocol

```typescript
interface ISubAgentInput {
  task: string;
  context?: string;
  sessionId?: string;
  signal?: AbortSignal;
  layer: number;
  retryBudget?: RetryBudget;
}

interface ISubAgentResult {
  output: string;
  toolCalls?: LlmToolCall[];
  usage?: LlmUsage;
  metadata?: Record<string, unknown>;
  errorClass?: ErrorClass;
  epicFailTrace?: EpicFailTrace;
}
```

`briefing` is removed. No `goal`, `known`, `tried`, `constraints`, or `artifacts` fields are added to `ISubAgentInput`.

All subagent-specific text enters through:

- `task`: what the subagent must do.
- `context`: retrieved and assembled support material for this task.

The dispatcher calls the context builder before `sub.run()` when the selected agent's `contextPolicy` is `required` or when the parent chooses to inject context for an autonomous agent.

---

## Failure Policy: Phased Design

The nested-dispatch substrate should not block on the full error-policy redesign. Implement it in two phases.

### Phase 1: Preserve current coordinator behavior + minimal epicfail primitive

- Keep current `maxRetriesPerStep` and `failPolicy`.
- Add only the minimal error surface needed for layer validation and missing required context.
- Do not introduce LLM-judge classification.
- Do not change public failure semantics beyond the required subagent contract changes.

**Minimal epicfail primitive (required even in Phase 1):**

Even at depth 0→1, a clean error channel between layers is needed. The dispatch strategies (`SubAgentDispatch`, `HybridDispatch`) must NOT swallow or transform errors from a child subagent — they must propagate them upward as-is so the consumer sees the actual cause.

Concretely:

- Add `errorClass?: 'epicfail'` and `epicFailTrace?: EpicFailTrace` to `ISubAgentResult`. No other classes yet.
- When `SubAgentDispatch` calls `sub.run()` and gets a thrown error or a result with `errorClass: 'epicfail'`, it returns a `StepResult` with `ok: false`, `error: <message>`, and an attached trace frame. It does NOT attempt replan or retry beyond existing `maxRetriesPerStep`.
- The trace structure is the same as Phase 2 (see below) — `attempts[]` is empty in Phase 1 because no class-based retries exist yet.

This is ~30-50 lines of code, decouples error propagation from the larger policy decisions, and prevents the depth 0→1→2 scenario (whenever someone opts into it) from silently swallowing failures.

### Phase 2: Error classes, retry budgets, and epicfail

Add the richer model once nested dispatch and context assembly are stable.

```typescript
type ErrorClass =
  | 'transient'
  | 'orchestrator-fault'
  | 'consumer-fault'
  | 'subagent-fault'
  | 'configuration-fault'
  | 'epicfail';
```

Classification guidance:

- 429, 503, ECONNRESET, and retryable provider 5xx errors are `transient`.
- User cancellation is `consumer-fault`, not transient.
- Internal timeout may be `transient` or `subagent-fault` depending on source.
- Missing required context is `orchestrator-fault`.
- Auth/config/provider setup errors are `configuration-fault`.
- 400/422 LLM API errors need provider-specific handling; they are not automatically `orchestrator-fault`.
- Policy violations or impossible user requests are `consumer-fault`.

The deterministic classifier runs first. LLM-judge classification is optional, disabled by default, and only used for unclassified errors when a helper LLM is configured. Cache keys must include error text, provider/source, and step/agent identity, not error text alone.

```typescript
interface RetryBudget {
  transientRetries: number;
  replanAttempts: number;
  subagentRetryHints: number;
}
```

Retry budgets are owned by the current coordinator layer. Child layers receive a cloned budget snapshot or a configured child budget, not a shared mutable object. This prevents distant child retries from unexpectedly consuming the parent's budget.

`failPolicy` remains during migration:

- `failPolicy: 'abort'` maps to strict budgets and immediate failure behavior.
- `failPolicy: 'continue'` maps to current continue behavior until the new policy is explicitly enabled.
- Deprecation happens after one release cycle with compatibility shims.

Epicfail propagation:

```typescript
interface EpicFailTrace {
  layer: number;
  stepId: string;
  agentName: string;
  attempts: Array<{
    kind: 'transient' | 'replan' | 'hint';
    error: string;
    durationMs: number;
  }>;
  originalErrorClass: Exclude<ErrorClass, 'epicfail'>;
  childTrace?: EpicFailTrace;
}
```

When a child returns `errorClass: 'epicfail'`, the parent does not retry, replan, or reinterpret it. It appends its layer frame and bubbles the trace upward.

---

## What This Changes In Current Code

### Phase 1 Required Code

| Component | Path | Purpose |
|---|---|---|
| `SubAgentKind`, `SubAgentCapabilities` | `packages/llm-agent/src/interfaces/subagent.ts` | Typed registry metadata for validation. |
| `layer` on `AgentCallOptions` / `CallOptions` | `packages/llm-agent/src/interfaces/types.ts` or current call-options source | Carries dispatch depth into `SmartAgent.process()`. |
| `layer` field on `PipelineContext` | `packages/llm-agent-libs/src/pipeline/context.ts` | Tracks current invocation layer. |
| `LayerConfig` | `packages/llm-agent/src/interfaces/coordinator.ts` | Public coordinator config contract. |
| Plan validation gate | `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` | Rejects plans that violate layer capability rules. |
| `ISubAgentContextBuilder` | `packages/llm-agent-libs/src/subagent/context-builder.ts` | Builds bounded task context from RAG, MCP-RAG, and exact artifact refs. |
| Default context builder | `packages/llm-agent-libs/src/subagent/default-context-builder.ts` | Implements current task -> RAG -> tool-RAG retrieval. |
| `DirectLlmSubAgent` | `packages/llm-agent-libs/src/subagent/direct-llm-subagent.ts` | Constrained leaf-node subagent implementation. |
| Dispatch context wiring | `coordinator/dispatch/subagent.ts` | Builds context before `sub.run()`, passes `layer + 1`. |
| `SmartAgentSubAgent` layer propagation | `subagent/smart-agent-subagent.ts` | Calls `agent.process(prompt, { layer })`. |

### Phase 2 Required Code

| Component | Path | Purpose |
|---|---|---|
| `ErrorClass`, `RetryBudget`, `EpicFailTrace` | `packages/llm-agent/src/interfaces/error.ts` | Error policy contracts. |
| Error classification helper | `packages/llm-agent-libs/src/error/classify.ts` | Deterministic classifier plus optional LLM judge. |
| Retry budget orchestration | `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` | Class-based retries, replans, hint retries, escalation. |
| Epicfail propagation | `coordinator/dispatch/subagent.ts`, `self.ts`, `hybrid.ts` | Passes epicfail upward unchanged except trace frame append. |

### Optional Later Code

| Component | Path | Purpose |
|---|---|---|
| Built-in artifact MCP package | Separate package preferred | `save_artifact`, `get_artifact`, and artifact search for thin clients. |
| Parallel dispatch | Coordinator and `PlanStep` contract | Executes independent step groups concurrently. |

### Code To Remove (Rollback Of PR #132)

- `IBriefing` / `IBriefingArtifact` interfaces in `packages/llm-agent/src/interfaces/subagent.ts`
- `briefing?` field on `ISubAgentInput`
- `formatBriefing` in `packages/llm-agent-libs/src/subagent/format-briefing.ts`
- `buildBriefingFromContext` in `packages/llm-agent-libs/src/coordinator/briefing.ts`
- Briefing wiring in `SmartAgentSubAgent.run`, `SubAgentDispatch.dispatch`, `SelfDispatch.dispatch`
- All briefing tests
- Documentation entries in `INTEGRATION.md` and `CHANGELOG.md`

---

## Backwards Compatibility

This design changes the `ISubAgent` contract. Existing custom subagents must add:

- `capabilities`
- tolerance for `input.layer`
- optional tolerance for `input.context`

This is a breaking TypeScript change for custom subagent implementers. Runtime JavaScript implementations that ignore unknown fields may continue to work only if they add `capabilities` or are wrapped by a compatibility adapter.

Compatibility strategy:

- Provide `asAutonomousSubAgent(sub)` and `asConstrainedSubAgent(sub)` adapters for old implementations.
- Default `SmartAgentSubAgent` capabilities to `{ kind: 'autonomous', canRecurse: true, contextPolicy: 'optional' }`.
- Default `DirectLlmSubAgent` capabilities to `{ kind: 'constrained', canRecurse: false, contextPolicy: 'required' }`.
- Keep `failPolicy` during Phase 1.

---

## Parallel Dispatch (Future Phase)

The planner's plan is currently executed sequentially. Fan-out workloads can be modeled later with:

```typescript
interface PlanStep {
  parallelGroup?: string;
}
```

Steps with the same `parallelGroup` execute concurrently with `Promise.allSettled`. Order across groups is preserved.

Open decision for that future phase: whether one failure in a parallel group aborts the whole group or whether independent results continue under the error policy.

---

## Consumer Modes

Single-shot requests need no new consumer API.

Conversational mode relies on persistent consumer artifacts rather than hidden coordinator memory:

1. A rich client saves artifacts through its own MCP tools and references them by id in later turns.
2. A thin client may opt into the built-in artifact MCP package.
3. The orchestrator can use conversation history in its own root pipeline, but subagents receive only explicit `task` and assembled `context`.

The consumer's full message history remains in `PipelineContext.assembledMessages` for the root orchestrator. It is not automatically propagated to subagents.

---

## Implementation Plan Boundaries

The implementation should be split:

1. **Rollback PR #132 briefing.**
2. **Capabilities + layer plumbing + plan validation.**
3. **Context builder + DirectLlmSubAgent.**
4. **Nested dispatch propagation** (layer plumbing through child SmartAgent instances).
5. **Epicfail primitive** (Phase 1 of error policy — clean error channel between layers).
6. **Error policy Phase 2** (ErrorClass enum, retry budgets, LLM-judge).
7. **Parallel dispatch future phase.**

Do not implement all phases in one PR unless the changes remain reviewable and independently tested.

---

## Open Questions Deferred To Implementation Plan

- What exact token budget should `ISubAgentContextBuilder` use for constrained vs autonomous agents?
- Should context builder retrieval be configurable per subagent, per coordinator, or both?
- Should artifact refs live on `PlanStep` as structured metadata, or only inside `task` text for Phase 1?
- Should `EpicFailTrace` be surfaced as JSON, formatted text, or both?
- Should optional LLM-judge classification run in `CoordinatorHandler` or a separate helper service?
- Should the built-in artifact MCP ship in `@mcp-abap-adt/llm-agent-libs` or as a separate package? Lean separate.

---

## Self-Review

1. **Structured briefing removed:** previous step history is not used as implicit context.
2. **Context replacement is explicit:** `ISubAgentContextBuilder` is now central to the design.
3. **Layer enforcement is possible:** subagent capability metadata gives the validator something concrete to enforce.
4. **Artifact scope is bounded:** exact artifact reads are separated from semantic RAG, and visibility requires explicit grant.
5. **Scope is phased:** nested dispatch and context assembly can ship before the larger error-policy redesign.
6. **Migration is explicit:** old subagents need capability adapters or contract updates.

Design is ready for implementation planning after review of the open questions.
