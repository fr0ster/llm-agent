# Slice 4b: Coordinator loop + roles + state-oracle + clarify-to-user

Status: design (active — slice 4b, the final slice of the coordinator-redesign epic)
Date: 2026-05-27
Epic anchor: `docs/superpowers/specs/2026-05-25-coordinator-redesign-epic-overview.md`
Builds on: slice 1 (DAG coordinator), slice 2 (reviewer gate), slice 3 (replan + IErrorStrategy), slice 4a (reviewer-driven recovery)

> Lands in the SAME PR as slice 4a (one PR covers all of slice 4) so the global
> picture stays whole.

## Goal

Make the coordinator a **thin sequencer loop** over **role subagents** —
planner, reviewer, plan-interpreter, and a new **state-oracle** — that recovers
from execution errors by re-planning, consulting reality (the oracle)
autonomously for state questions, and surfacing a **clarification question to the
user** (ending the turn) only for genuine human-intent decisions. Continuity
across turns is free: the world holds the state and the conversation history
carries the dialogue — no resumption store.

## Scope & compatibility

Additive. **Backward-compat invariant (must not break): existing YAML configs.**
A config without a state-oracle / without a clarifying reviewer behaves exactly as
slices 1–4a (batch). New schema is optional. Regression guard: existing example
configs validate and load unchanged. This slice ships inside the same pending
major (17.0.0) as slice 3.

## Abstraction levels (locked)

```
global-interpreter (YAML/server; an IInterpreter impl)
  └─ executes the global pipeline (once per turn)
       └─ coordinator-stage  (a pipeline component; a thin sequencer)
            └─ via the IInterpreter INTERFACE calls →
               plan-interpreter (the DAG executor; a DIFFERENT IInterpreter impl)
                 └─ DAG
                      └─ subagents: planner / reviewer / state-oracle / workers
```

- The coordinator depends on **`IInterpreter` (the interface)**, never a concrete
  plan-interpreter class. The global interpreter and the plan interpreter are two
  implementations of one interface, at different levels — never conflated.
- The coordinator makes **no LLM calls** and assembles **no LLM context**. It only
  routes tasks/results/errors between roles.

## Context ownership (clarification of responsibility)

Context is **layered, with no central manager**:
- **Plan / interpreter own inter-node data-flow**: `composeNodeTask` builds each
  node's `task` (goal + dependency outputs + user input). The planner builds the
  data-flow structure, the reviewer checks it, the interpreter executes it.
- **Each subagent owns its own LLM context**: it takes its `task` as the user turn
  and assembles system prompt + RAG + tool-select + its own history via its own
  pipeline's `assemble` stage. Workers are full pipelines; role adapters compose a
  focused task over a constrained or tool-capable subagent.
- The coordinator owns neither — it is a dumb router.

## Hierarchical context rule (the context unit is node + ancestors)

Context is not globally accumulated and is not "the last prompt" — the unit is
**the current node/request plus its ancestor intent path**.

**Rule.** Role and worker inputs are built from the current node/request plus the
**ancestor intent path** (the parent objective(s) and the clarification dialogue
that led here, with the RAG/MCP each subagent assembles for *that* path). They MUST
NOT receive sibling or descendant context unless it flows through an explicit DAG
dependency edge, the execution trace, or an oracle observation. Clarify/resume
relies on the same rule: the next turn is fresh, but the planner input includes the
relevant **ancestor dialogue/context selected for the current request** — not the
raw chat.

This is why "no store" works: the carried unit is `node + ancestors`, not the whole
conversation. After a `clarify`, the answer (e.g. `ZCUSTOMERS` to "Which table
should I modify?") is meaningful because the ancestor path carries that question;
the node is not polluted by unrelated sibling tasks.

**Contract shape** — a curated `ancestorContext` (intent lineage), NOT raw history:

```ts
interface ContextPath {
  objective?: string;                                   // root/parent intent
  clarifications: Array<{ question: string; answer: string }>; // intent-shaping dialogue along the path
}
```

- `PlannerInput`, `ReviewInput`, `ExecutionFailureInput` carry `ancestorContext?:
  ContextPath` instead of raw history; the role assembles its own RAG/MCP from
  `task + ancestorContext`.
- `composeNodeTask` for a worker node = ancestor objective/path **+ dependency
  outputs (dependsOn edges only)** + user input when `needsInput`. Sibling nodes
  (not in the dependency closure) are excluded — already true today; this rule
  makes the exclusion normative and adds the ancestor intent path.
- `needInfo` oracle facts are scoped to the **current path** (the query + answer
  attach to this node's context), not appended globally.

## Roles (all behind interfaces)

- **Planner** (`IPlanner`) — builds the DAG plan. May emit a request for info
  (oracle) or a clarification (user) instead of a plan.
- **Reviewer** (`IReviewStrategy`) — pre-execution gate (`review`) and
  execution-failure decision (`reviewExecutionFailure`, slice 4a). May emit a
  request for info (oracle) or a clarification (user).
- **Plan-interpreter** (`IInterpreter`) — pure executor. Slice-3 autonomous local
  replan (`NeedsDecompositionError` → local splice) stays internal; any failure it
  does not resolve locally is **returned up** to the coordinator (the interpreter
  no longer drives reviewer-recovery — see "Relationship to 4a").
- **State-oracle** (NEW) — a **tool-using subagent** that answers "what is the real
  current state" (git / filesystem / ABAP via MCP). Consulted **autonomously** by
  the planner/reviewer for reality questions, so the user is asked only for intent.

### The state-oracle role

New role: declared as a normal `subagents:` catalog entry and selected by
`coordinator.stateOracle: <subagent-name>`. It is an `ISubAgent` whose pipeline has
MCP/tools (read tools, `checkrun`, git/FS), `contextPolicy: 'optional'`. The
coordinator holds a reference and exposes it to the planner/reviewer via the
"needInfo" round-trip below. (No new runtime interface beyond `ISubAgent` — the
oracle is just a tool-capable worker used for inspection rather than mutation.)

## Role decision protocol (needInfo vs clarify)

Both the planner's and the reviewer's outputs gain two non-terminal escape
hatches, in addition to their normal results:

- **`needInfo(query)`** — the role needs a *reality* fact. The coordinator
  dispatches the **state-oracle** with `query`, appends the oracle's answer to the
  role's input, and **re-invokes the role in the same turn** (bounded round-trips).
  Autonomous — no turn end.
- **`clarify(question)`** — the role needs a *human* decision. The coordinator
  emits `question` as the assistant output and **ends the turn cleanly** (not an
  error). No state is stored. The next turn is a fresh request (see "Resume").

Concretely the decision unions become:
- `PlannerOutput = DagPlan | { needInfo: string } | { clarify: string }`
  (`IPlanner.plan` return type widens; `LlmDagPlanner` parses the three shapes).
- `ReviewVerdict += { pass: false; needInfo: string } | { pass: false; clarify: string }`.
- `ExecutionReviewDecision += { action: 'needInfo'; query: string } | { action: 'clarify'; question: string }`
  (slice-4a `abort`/`revise` stay).

## Coordinator loop (the thin sequencer)

Per turn, inside the coordinator stage, a bounded loop (a single per-run budget
caps total planner/reviewer/oracle round-trips to prevent runaway loops):

```
plan = run-role(planner)                       // resolves needInfo via oracle; clarify → end turn
loop (bounded):
  verdict = reviewer.review(plan)              // gate; needInfo → oracle; clarify → end turn
  if verdict rejects with feedback: replan via planner with the feedback; continue
  result = interpreter.interpret(plan)         // returns done | failed
  if result.ok: stream output; DONE
  decision = reviewer.reviewExecutionFailure(error, trace, plan)  // needInfo|clarify|revise|abort
  needInfo → oracle answer fed back; re-decide
  clarify  → emit question; END TURN
  revise   → plan = revisedPlan; continue
  abort    → fail
```

`run-role` is the small helper that handles a role's `needInfo` (oracle
round-trip, bounded) and `clarify` (emit + end turn) uniformly. The coordinator
itself contains no recovery *judgement* — every decision is the role's; the
coordinator only routes.

## Resume — no store

A `clarify` ends the turn with the question as the assistant message. There is
**no resumption store**. The next turn is an ordinary request:
- the **world holds the state** (artifacts already created in git/FS/ABAP persist);
- the **conversation history** (already maintained by the runtime) carries the
  question and the user's answer;
- **workers are idempotent/adaptive** (slice-4a principle: "object exists →
  modify, not create") and the state-oracle reports current reality.

So the next turn re-plans from the *current real state*; completed work is not
redone. Resumption is an emergent property, not a mechanism.

Per the **Hierarchical context rule**, the resuming planner does NOT receive the
raw chat — it receives a curated `ancestorContext` (the objective + the relevant
clarification Q/A, e.g. `{question: "Which table?", answer: "ZCUSTOMERS"}`) selected
for the current request. The runtime already maintains conversation history; the
coordinator selects the path-relevant slice into `ancestorContext` rather than
dumping everything.

## Relationship to slice 4a (refactor within this PR)

Slice 4a put reviewer-driven recovery **inside** the interpreter
(`ReviewerErrorStrategy` invoked via `ctx.errorStrategy.onNodeFailure`). 4b moves
that recovery **up to the coordinator loop**: the interpreter returns a failed
`InterpretResult` (with the failed node + trace), and the **coordinator** calls
`reviewer.reviewExecutionFailure` and re-interprets. Consequences:
- `reviewExecutionFailure` (4a) is **kept and reused** — now called by the
  coordinator, not the interpreter.
- `ReviewerErrorStrategy` (4a, interpreter-internal) is **removed**; the
  interpreter's `IErrorStrategy` is back to slice-3 scope (autonomous local:
  `AbortErrorStrategy` default, `ReplanErrorStrategy` for `NeedsDecompositionError`).
- The interpreter's `revise` reaction handling (whole-remainder swap) is **removed
  from the interpreter** and re-expressed as the coordinator re-interpreting the
  reviewer's revised plan. (`ErrorReaction.revise` and `ErrorContext.plan/completedResults`
  from 4a are dropped, since reviewer-recovery no longer runs inside the interpreter.)
- Net: the interpreter is a pure executor again (slice-3 surface + "return failures
  up"); the coordinator owns the recovery loop. Slice-4a's reviewer method and the
  state-baselined-replan model survive — only their *call site* moves.

(This is why 4a + 4b share one PR: 4b reshapes where 4a's recovery runs.)

## Config (YAML, additive)

```yaml
subagents:
  - name: state-oracle
    config: ../subagents/state-oracle.yaml   # tool-capable inspection pipeline
  - name: <worker> ...

coordinator:
  planner:  { type: llm }
  reviewer: { type: llm }                    # gate + recovery + clarify
  stateOracle: state-oracle                  # NEW — name of the oracle subagent
  maxRoundTrips: 6                            # NEW — bounds planner/reviewer/oracle loop
```

- `stateOracle` is DAG-only; if set, must name an entry in `subagents:` (fail loud
  at startup otherwise). If absent, the coordinator answers no `needInfo` (a role
  emitting `needInfo` without an oracle → treated as `abort`/terminal with a clear
  error).
- No `dialog` flag: `clarify` always ends the turn with the question; whether a
  human or another agent answers next is the consumer's concern (single-shot caller
  gets the question as its answer; interactive client shows it and replies). The
  batch/dialog distinction collapses — there is one coordinator.

## Error handling

| Situation | Outcome |
|-----------|---------|
| role emits `needInfo`, oracle configured | oracle answers; role re-invoked (bounded) |
| role emits `needInfo`, no oracle configured | terminal error (clear message) |
| role emits `clarify` | question streamed as assistant output; turn ends cleanly |
| interpreter returns failed | coordinator calls `reviewExecutionFailure` → revise/clarify/abort/needInfo |
| `revise` | coordinator re-interprets the revised plan (bounded) |
| `abort` | turn fails (`COORDINATOR_*`) |
| round-trip / re-interpret budget exhausted | fail loud (`COORDINATOR_*`) |
| no oracle, no clarify (plain config) | batch behavior, unchanged from 4a |

## Testing

- **State-oracle round-trip** — a reviewer that returns `needInfo` once then
  `revise`: the coordinator dispatches the oracle, feeds the answer back, and
  proceeds; bounded so an oracle-loop terminates.
- **Clarify ends the turn** — a reviewer/planner `clarify` streams the question and
  the turn completes cleanly (no error); nothing persisted.
- **Coordinator loop** — failed interpret → `reviewExecutionFailure` → `revise` →
  re-interpret → done; `abort` → fail; budget exhausted → fail.
- **No-oracle config** — a `needInfo` with no oracle configured → terminal error;
  a plain config (no oracle, reviewer never clarifies) behaves exactly as 4a (batch).
- **4a refactor regression** — the slice-4a recovery scenarios now pass through the
  coordinator loop (interpreter returns failed; coordinator drives revise); slice-3
  autonomous local replan (`NeedsDecompositionError`) still works inside the
  interpreter.
- **Hierarchical context** — a role/worker input carries the ancestor intent path
  (objective + clarification Q/A) and its dependency outputs, but NOT a sibling
  node's output (a node with no `dependsOn` edge to a sibling never sees it); on
  resume the planner receives `ancestorContext` (the selected clarification Q/A),
  not the raw chat.
- **Backward-compat** — existing example YAMLs validate and load; build + lint:check
  clean; full suite green.

## Out of scope

- Durable/cross-process resumption store (the world + history suffice).
- A separate `ICoordinator` interface with batch/dialog impls — the batch/dialog
  distinction collapsed (one coordinator; clarify always ends the turn), so no
  second impl is introduced.
- Automatic side-effect rollback/compensation (the revised plan is state-aware via
  the oracle + idempotent workers — same stance as 4a).
- A formal `IStateOracle` interface beyond `ISubAgent` (the oracle is a tool-capable
  worker; promote to a dedicated interface only if a second non-subagent impl appears).
