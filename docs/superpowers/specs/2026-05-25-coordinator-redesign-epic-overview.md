# Epic: Coordinator redesign — DAG planning, pluggable roles, batch + dialog

Status: epic overview (anchor for a multi-sub-project arc; kept while the epic is active)
Date: 2026-05-25
Supersedes the earlier 3-part "staged-pipeline" sketch (answer-directly #155 was its sub-project 1, already shipped).

## Vision

Reshape the coordinator from a monolithic linear-step handler into a **thin
supervisor over pluggable, subagent-shaped roles**, driven by a **DAG plan** and
usable in two consumption shapes (single-shot and dialog). Every seam is an
interface with multiple implementations selected by config/DI — the project's
established pattern (`IToolSelectionStrategy` #135, the LLM/embedder/RAG
provider axes, the existing `IPlanning/IDispatch/IActivation` strategies).

## Invariants (the principles this epic holds)

- **Coordinator is the brain; subagents are hands.** Decomposition is a brain
  function. A leaf that needs finer decomposition **signals the coordinator**
  (which re-plans that node) rather than spawning its own subagent.
- **No nested dispatch.** Subagents are leaves. The recursive
  subagent-spawns-subagent machinery (`maxLayer`, layer validation, cross-layer
  epicfail propagation — #128–#132) is removed; dynamic decomposition relocates
  to coordinator re-plan-by-leaf-signal.
- **Planner and reviewer are themselves `ISubAgent`s** under the same
  supervision/restart-with-clarification model as worker subagents. The
  coordinator special-cases none of them.
- **Externalizing the planner is cheap here** because its input is small and
  bounded (prompt + agent catalog), unlike an interactive ReAct loop whose
  planning needs the whole live context (why Claude Code plans inline; see
  "Relationship to other models").
- **Interface + multiple implementations**, selected by config/DI. Batch vs
  dialog are two `ICoordinator` implementations, not a mode flag. Clarification
  is one contract with two delivery back-ends (terminal vs ask-and-resume).
- **Material/data flows along graph edges.** A dependent node's input is composed
  by the coordinator from its dependencies' outputs (+ original material when
  needed) — the #145 "coordinator builds the task" principle, scoped to actual
  dependencies rather than "all prior steps".
- **Progressive complexity — the default does not over-engineer.** The
  planner/coordinator chooses the *simplest viable* plan shape:
  - trivial → **answer-directly** (single self-step; shipped in #155);
  - simple → **single-node plan = one subagent-pipeline** handles the whole task
    (the default server variant — fanning out is NOT required);
  - complex → **multi-node DAG** of subagents, only when decomposition is
    genuinely warranted.

  DAG fan-out is an *escalation on demand*, never forced. The DAG `Plan` type
  must therefore represent a 1-node plan as naturally as an N-node graph, and the
  default server config leans toward minimal decomposition. The plan reviewer
  validates whatever shape results (incl. a 1-node plan) against the prompt.

## Target architecture — interfaces and implementations

| Interface | Role | Implementations (now / later) |
|---|---|---|
| `Plan` (graph type) | DAG: task nodes; edges = `dependsOn` + data-flow | — (type) |
| `IPlanner` (planner-subagent) | prompt + agent catalog → DAG `Plan` | DAG planner (new); linear (degenerate) |
| `IReviewStrategy` (reviewer-subagent) | prompt + DAG → `{pass} \| {needsClarification}` | LLM critic; noop |
| `ICoordinator` | thin supervisor + staged pipeline | **batch/single-shot**; **dialog/resumable** |
| `IErrorStrategy` | reaction to a node failure | abort; replan-node-by-leaf-signal |
| `ISubAgent` (exists) | leaf workers; planner & reviewer are also `ISubAgent` | existing + new |
| gate/clarification contract | `{pass} \| {needsClarification, question, resume}` | terminal (batch); ask-and-resume (dialog) |
| leaf-signal | `StepResult` carries "needs-decomposition / failed + reason" | — (field) |

## Consumption shapes

- **Single-shot** (llm-agent as a subagent FOR Claude, or a plain API call):
  one input → DAG plan → review → execute → one aggregated result. The batch
  `ICoordinator`. Here llm-agent is itself a leaf for its caller while being the
  brain for its own subagents.
- **Dialog** (interactive llm-client): multi-turn; each turn may run the DAG
  engine; clarification/failed-review becomes an **interactive turn** (ask the
  user, pause, resume from the saved plan/progress state) rather than a terminal
  gate. Streaming and session state already exist in the runtime; the new
  capability is a **resumable coordinator** (pause-on-clarification + resume).

## Relationship to other models (Claude Code)

Claude Code's main agent plans **inline** (ReAct: plan↔act interleaved) because
its planning input is the entire evolving session and it is interactive. Our
SmartAgent is a server orchestrator with bounded planning input and pluggable
roles, so a **plan-and-execute DAG with an externalized planner** fits and buys
uniform supervision + pluggability. Both models keep subagents as **leaves**
(no deep nesting) — our removal of nested dispatch aligns with that.

## Decomposition (each its own spec → plan → implementation cycle)

1. **Contracts** — define all `I*` interfaces + graph `Plan` (deps + data-flow) +
   leaf-signal + resumable-gate outcome. Seams only, no behavior. (Foundation.)
2. **DAG planner** implementation + graph executor (topological order, parallel
   independent nodes, dependency data-flow into dependent nodes).
3. **Plan reviewer** implementation (`IReviewStrategy` LLM critic; gate, fail-loud).
4. **Replan-by-leaf-signal** (`IErrorStrategy`) + **removal of nested dispatch**.
5. **Batch coordinator** (`ICoordinator` single-shot).
6. **Dialog coordinator** (`ICoordinator` resumable, pause-on-clarification).

Order: 1 first (foundation). 2–4 build the engine. 5 then 6 are the two
coordinator implementations. Sequencing of 2–6 is revisited per sub-project.

## Out of scope / deferred

- Result-side review (output ≡ prompt) and the empty-but-ok LLM output edge from
  #155 — a separate result-side concern, not this plan-side reviewer.
- Speculative role implementations beyond what a consumer needs (YAGNI): we
  define interfaces broadly but implement only the listed concrete classes.

## Builds on / changes

- Builds on #145 (coordinator authors the task) and #155 (answer-directly,
  default hybrid dispatch).
- Removes the nested-dispatch foundation (#128–#132): `maxLayer`, layer
  validation, cross-layer epicfail propagation.
