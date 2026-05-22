# Recursive Subagent Orchestration Design

> **Status:** Design, not implemented. After this spec is approved, the writing-plans skill produces the implementation plan.

## Goal

Replace the current "subagent = wrapped SmartAgent, dispatched by Coordinator" model with a richer orchestration substrate that supports:

1. **Two consumer-interaction modes**: single-shot HTTP-style requests and multi-turn conversational sessions.
2. **Two subagent execution types**: autonomous (full pipeline, own MCP/RAG) and constrained (pure LLM with injected context).
3. **Recursive dispatch with typed depth limits**: agents can spawn agents; recursion terminates naturally because constrained subagents are always leaf nodes.
4. **Three artifact scopes**: consumer artifacts (external, MCP-accessible), per-layer orchestrator artifacts (transient `stepResults`), per-layer subagent artifacts (invisible to parent).
5. **Bounded retry + error classification + epicfail escalation**: every layer has a retry budget; on exhaustion the error bubbles up unmodified to the consumer, without being swallowed mid-chain.

This supersedes the structured-briefing direction explored in PR #132. That PR will be closed.

## Non-Goals

- This spec does NOT define how the consumer-facing API (`SmartServer`) changes for conversational mode. Consumer-side request schema stays as-is; the orchestration changes are internal to how requests are processed.
- This spec does NOT introduce a new artifact storage layer in llm-agent. Artifacts live externally (consumer-side MCP or a built-in RAG-backed MCP tool described later).
- Specific UI/CLI changes for showing recursion depth or epicfail traces are deferred.

---

## Concept: SmartAgent and Subagent are the same thing

A `SmartAgent` viewed from above (consumer side) is the orchestrator. The same instance, dispatched as a step of a parent's plan, IS a subagent. The current `SmartAgentSubAgent` already reflects this — it wraps a `SmartAgent` and exposes the `ISubAgent` contract.

The single concept is recursive composition. The asymmetry comes only from execution position (layer) and from whether the agent has plan-and-dispatch machinery enabled (autonomous) or not (constrained).

---

## Architecture

### Subagent types

```
ISubAgent (contract)
├── SmartAgentSubAgent (autonomous, EXISTING)
│   - Wraps a full SmartAgent
│   - Has own system prompt, RAG (history + tools), MCP graph, skills, classifier
│   - Has own CoordinatorHandler — can plan and dispatch further subagents
│   - Receives: { task, sessionId?, signal?, layer }
│   - Fetches additional context itself via its MCP tools (e.g. get_artifact(id))
│
└── DirectLlmSubAgent (constrained, NEW)
    - Composes: ILlm + system prompt (only own thing)
    - NO RAG, NO MCP, NO skills, NO classifier, NO plan/dispatch
    - Receives: { task, context, sessionId?, signal?, layer }
    - Cannot recurse — always a leaf node
    - Internally: single LLM chat call. system prompt + (context as preamble) + (task as user message) → response
```

Both implement the same `ISubAgent` interface. From the orchestrator's perspective they look identical at the registry lookup level (both have `name` and `description`). The orchestrator's planner LLM picks by `description`.

The asymmetry shows up at dispatch: `DirectLlmSubAgent.run()` requires `context` to be present (errors if absent); `SmartAgentSubAgent.run()` treats `context` as optional preamble (if present, prepended to task).

### Layers and typed recursion

Each `SmartAgent` invocation has a `layer` (integer, 0 at the consumer-facing root, +1 each dispatch).

Recursion limits are expressed not as a numeric cap on depth but as **type rules per layer**:

```
layerConfig: {
  0: { autonomous: true, constrained: true },   // root: anything goes
  1: { autonomous: true, constrained: true },   // can recurse one more level
  2: { autonomous: false, constrained: true },  // can only dispatch leaves
  3: { autonomous: false, constrained: false }, // no dispatch — must self-execute
}
```

Defaults: `{ 0: both, 1: both, 2: constrained-only, 3+: forbidden }`. Configurable per deployment.

`SmartAgent.process()` reads `layer` from its invocation context. When constructing its pipeline, the `CoordinatorHandler` consults `layerConfig[layer]` and gates dispatch:

- If `autonomous: false`, planner can only emit steps with `agent` pointing to a registered constrained subagent.
- If `constrained: false`, dispatch entirely disabled — falls back to SelfDispatch (pure LLM tool-loop of this same agent).

The constraint is enforced at plan-validation time, not at dispatch time, so the planner LLM knows up-front what's allowed.

### Artifacts — three scopes

| Scope | Producer | Storage | Visibility | Lifetime |
|---|---|---|---|---|
| **Consumer artifacts** | Consumer (rich client or thin client + built-in `save_artifact` tool) | Consumer-controlled (own filesystem, DB) OR llm-agent's built-in RAG-backed store | Visible to ANY layer via MCP tool calls | Persistent (until consumer deletes) |
| **Per-layer orchestrator artifacts** | Current layer's planner (writes to `ctx.stepResults`) | In-memory `PipelineContext.stepResults` | This layer only | Lifetime of one plan execution |
| **Per-layer subagent artifacts** | Subagent's internal `stepResults` (if it has its own plan) | In-memory in the subagent's pipeline context | Subagent only — parent receives ONLY the final `output: string` | Lifetime of subagent's invocation |

**Consumer artifacts** are the only persistent layer. They're accessed via MCP tool calls — either provided by the consumer's own MCP server (rich client like Claude Code), or by a built-in MCP server bundled with llm-agent that exposes `save_artifact(name, content)` / `get_artifact(name)` over RAG (thin client).

**Per-layer artifacts** never escape their layer. A subagent's `stepResults` are invisible to the parent — this is the key isolation property that prevents context pollution across layers. The parent only sees the subagent's final `output`.

### Dispatch protocol

```typescript
interface ISubAgentInput {
  task: string;                  // Always present. User-message payload.
  context?: string;              // Required by constrained, optional preamble for autonomous.
  sessionId?: string;            // Session continuity for this agent (own history).
  signal?: AbortSignal;
  layer: number;                 // Set by parent dispatcher; subagent uses to derive its own children's layer = layer+1.
  retryBudget?: RetryBudget;     // Decremented per failed attempt (see Error Policy).
}

interface ISubAgentResult {
  output: string;                // The final answer.
  toolCalls?: LlmToolCall[];     // External tool-calls the subagent emitted but couldn't execute.
  usage?: LlmUsage;
  errorClass?: ErrorClass;       // Set when failed (see Error Policy); absent on success.
}
```

`briefing` is removed. No `goal`, `known`, `tried`, `constraints`, `artifacts` fields. The orchestrator passes everything needed in `task` (as text) or in `context` (as text), full stop. The orchestrator is responsible for fetching consumer-artifact content via MCP before dispatch when injection is required (constrained subagent case); for autonomous subagents, the orchestrator can either inject pre-fetched content as `context` or let the subagent fetch itself.

### Error policy

#### Error classes

```typescript
type ErrorClass =
  | 'transient'           // Network, rate limit, LLM 5xx — retry
  | 'orchestrator-fault'  // Bad prompt/context from parent — replan or escalate
  | 'consumer-fault'      // Request impossible / invalid data — bubble up
  | 'subagent-fault';     // LLM hallucination/internal subagent error — retry-with-hint or escalate
```

#### Classification mechanism — hybrid

- **Deterministic path** (automatic, no LLM): catch known exceptions and HTTP status codes inside the subagent runtime:
  - 429, 503, ECONNRESET, AbortError → `transient`
  - 4xx (except 429) from LLM → `orchestrator-fault` (malformed payload)
  - Missing required input (e.g. constrained agent with no `context`) → `orchestrator-fault`
  - Anything else → unclassified
- **LLM-judge path** (per-step, only on unclassified errors): orchestrator's helper LLM gets the error message + step context, returns one of the 4 classes. Cached per-error-text to avoid repeat costs within one plan.

#### Retry budgets

```typescript
interface RetryBudget {
  transientRetries: number;       // Default 3. Same step, same input, exponential backoff.
  replanAttempts: number;         // Default 2. Orchestrator regenerates plan around the failed step.
  subagentRetryHints: number;     // Default 1. Re-dispatch same step with planner-emitted hint ("don't do X").
}
```

The budget is allocated per `RetryBudget` instance and decrements as attempts are made. When ALL counters reach zero AND the error is not consumer-fault, the failure escalates as `epicfail` to the parent layer.

#### Reaction matrix

| Error class | Budget consumed | If budget remains | If budget exhausted |
|---|---|---|---|
| `transient` | `transientRetries` | Retry same step | Escalate as `epicfail` |
| `orchestrator-fault` | `replanAttempts` | Trigger replan via `IPlanningStrategy.rebuildPlan` | Escalate as `epicfail` |
| `subagent-fault` | `subagentRetryHints` | Re-dispatch with hint appended to task | Escalate as `epicfail` |
| `consumer-fault` | n/a | Bubble up immediately — consumer is the only source of correction | — |
| `epicfail` (from child layer) | n/a | NEVER processed by intermediate layer — passed through verbatim | Reaches consumer |

#### Epicfail propagation

When a subagent returns `errorClass = 'epicfail'`, the parent layer **does not** attempt to handle it. No replan, no retry. The parent layer immediately returns the same epicfail to ITS parent, with its own layer-id appended to the trace.

The trace structure:
```typescript
interface EpicFailTrace {
  layer: number;
  stepId: string;
  agentName: string;
  attempts: Array<{ kind: 'transient' | 'replan' | 'hint'; error: string; durationMs: number }>;
  originalErrorClass: ErrorClass;
  childTrace?: EpicFailTrace;  // If the epicfail originated below
}
```

By the time it reaches the consumer it's a chain of nested traces — full diagnostic with NO intermediate transformation.

This prevents "swallowed errors" — anti-pattern where an intermediate layer catches a child epicfail, "tries to fix it", masks the original cause, and consumer sees a confusing higher-level error.

---

## What this changes in current code

### Required new code

| Component | Path | Purpose |
|---|---|---|
| `DirectLlmSubAgent` | `packages/llm-agent-libs/src/subagent/direct-llm-subagent.ts` | Constrained leaf-node subagent implementation. |
| `layer` field on `PipelineContext` | `packages/llm-agent-libs/src/pipeline/context.ts` | Tracks recursion depth. |
| `LayerConfig` + plan-validation gate | `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` | Enforces type-per-layer dispatch rules. |
| `ErrorClass`, `RetryBudget`, `EpicFailTrace` types | `packages/llm-agent/src/interfaces/error.ts` (new) | Contracts for error handling. |
| Error classification helper | `packages/llm-agent-libs/src/error/classify.ts` | Hybrid deterministic + LLM-judge classifier. |
| Retry budget orchestration | `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` | Bound retries by class, escalate to epicfail. |
| Epicfail propagation in dispatch strategies | `subagent.ts`, `self.ts`, `hybrid.ts` | Pass through unchanged. |
| Built-in `save_artifact` / `get_artifact` MCP tool (optional, for thin clients) | `packages/llm-agent-libs/src/builtin-mcp/artifact-tool.ts` (or separate package) | Backend = injected RAG. |

### Code to remove (rollback of PR #132)

- `IBriefing` / `IBriefingArtifact` interfaces in `packages/llm-agent/src/interfaces/subagent.ts`
- `briefing?` field on `ISubAgentInput`
- `formatBriefing` in `packages/llm-agent-libs/src/subagent/format-briefing.ts`
- `buildBriefingFromContext` in `packages/llm-agent-libs/src/coordinator/briefing.ts`
- Briefing wiring in `SmartAgentSubAgent.run`, `SubAgentDispatch.dispatch`, `SelfDispatch.dispatch`
- All briefing tests
- Documentation entries in INTEGRATION.md, CHANGELOG entries

### Backwards-compatibility shape

- `ISubAgent` contract gets `layer` (required) and `retryBudget` (optional). Existing custom subagent implementations need to accept the new fields — they may ignore them. Implementations created during PR #128 (the original subagent infrastructure) implement only `task/sessionId/signal` — they will type-error and must be updated. This is a breaking change for anyone with a custom `ISubAgent`.
- `failPolicy: 'abort' | 'continue'` on `ICoordinatorConfig` becomes redundant; replaced by retry budgets and error-class reactions. Either deprecate with a shim that maps `failPolicy` to a budget preset, or break and force migration.
- Existing `SmartAgentSubAgent` works without changes once `layer` is plumbed.

---

## Parallel dispatch (scoped for this design)

The planner's plan is currently executed sequentially. With the type-per-layer model and a coming need for fan-out tasks ("analyze 10 reports"), the coordinator must support steps marked as independent.

Contract addition:
```typescript
interface PlanStep {
  // ... existing fields
  parallelGroup?: string;  // Steps with same group execute concurrently
}
```

Within a parallel group, the coordinator dispatches all member steps with `Promise.allSettled`, then assembles results. Order across groups is preserved.

This is a contract-level decision; implementation can land in a separate plan after this design ships.

---

## Consumer modes (single-shot vs conversational) — what changes

Single-shot needs nothing new. Conversational requires only that the consumer:
1. Either uses its own MCP tools to save artifacts at the right turn ("save this formal description as 'desc-v3'"), then references them in future turns by name.
2. Or uses the built-in `save_artifact` tool, which writes to llm-agent's RAG store.

The orchestrator's planner LLM, when assembling the next subagent's `task`/`context`, fetches relevant artifacts via the same MCP path. The orchestrator does not maintain a separate notion of "conversation artifacts" — they're just consumer artifacts.

The consumer's full message history continues to live in `PipelineContext.assembledMessages` for the orchestrator's own use (e.g. for the planner LLM to read prior turns when deciding the plan). What does NOT propagate to subagents is this full history — only what the orchestrator explicitly passes in `task`/`context`.

---

## Open questions deferred to implementation plan

- Should `EpicFailTrace` be serialized as JSON or as formatted text when surfaced to consumer? (Probably both — JSON for programmatic, formatted for UI.)
- Where exactly the hybrid error classifier's LLM-judge runs — in the `CoordinatorHandler` directly, or as a separate handler? (Probably a small dedicated handler so it can be tested and configured.)
- Built-in `save_artifact` MCP tool — does it ship as part of `@mcp-abap-adt/llm-agent-libs` or as a separate package? (Lean toward separate, since not all deployments need it.)
- Parallel dispatch semantics: does a single failure in a parallel group abort the whole group, or do `Promise.allSettled`-style independent results flow through?

---

## Self-Review

1. **Placeholder scan:** no TBDs, all sections concrete. The "open questions deferred" section is intentionally listed as such — they're implementation-plan decisions, not gaps in the design.
2. **Internal consistency:** Subagent types and layer model agree (constrained = always leaf, autonomous = may recurse). Error policy uses error classes consistently. Artifact scopes don't overlap.
3. **Scope check:** Single coherent topic — orchestration substrate redesign. Implementation will split naturally into: (a) subagent type + layer + LayerConfig, (b) error policy + retries + epicfail, (c) parallel dispatch. Each can be one plan or all in one plan; both feasible.
4. **Ambiguity check:** `context` field semantics are explicit (required for constrained, optional for autonomous). `layer` is integer, defined as 0 at root. `RetryBudget` defaults are stated. Class names disambiguated from existing `failPolicy`.

No issues found inline — design is ready for user review.
