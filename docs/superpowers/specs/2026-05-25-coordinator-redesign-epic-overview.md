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

- **YAML is the complete description of the pipeline — this does NOT change.**
  Hard config-contract invariant carried from the existing versions. The redesign
  must express everything it introduces *within* that one full YAML pipeline
  description: the **coordinator is a stage inside the pipeline** (it replaces
  `tool-loop` when configured, exactly as today — NOT a pipeline-less top-level
  entity), and the **planner / reviewer / worker subagents are declared in the
  same YAML** (a subagent catalog; each subagent is itself a pipeline with its
  own llm/rag/mcp/prompt). A plain YAML with no `coordinator` block is the
  simplest case — one pipeline processing the prompt (today's behavior),
  unchanged.
- **Coordinator is the brain; subagents are hands.** Decomposition is a brain
  function. A leaf that needs finer decomposition **signals the coordinator**
  (which re-plans that node) rather than spawning its own subagent.
- **No nested dispatch.** Subagents are leaves. The recursive
  subagent-spawns-subagent machinery (`maxLayer`, layer validation, cross-layer
  epicfail propagation — #128–#132) is removed; dynamic decomposition relocates
  to coordinator re-plan-by-leaf-signal.
- **Planner and reviewer are supervised as `ISubAgent`s.** Decision (to keep
  slice specs from diverging): `IPlanner` / `IReviewStrategy` are **typed
  adapters composed *over* `ISubAgent`** — they do NOT extend or replace it. A
  role implementation owns an `ISubAgent` and adds only typed input-construction
  (prompt + agent catalog → `task`/`context`) and typed output-parsing (the
  subagent's `output` → `Plan` / verdict). The coordinator dispatches and
  supervises every role — planner, reviewer, worker — through the **one**
  `ISubAgent` path (same restart-with-clarification, same error handling); the
  role interface only wraps that path with typing. The coordinator special-cases
  none of them.
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
  - trivial → **answer-directly** (self-dispatched direct step; behavior shipped
    in #155, currently as an empty `steps: []` + synthetic `direct-1`);
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

## Decomposition (vertical, self-sufficient slices)

Each slice ships a **working, testable capability on its own** and leaves the
system runnable. Decomposition is by vertical slice, NOT by horizontal layer —
the interface/type contracts are introduced *inside* the first slice that needs
them, together with the code that uses them (a "contracts-only" sub-project would
not be self-sufficient).

1. **Batch DAG coordinator (MVP)** — the graph `Plan` type (`dependsOn` +
   data-flow), `IPlanner` (DAG planner), a topological/parallel executor that
   feeds each node its dependencies' outputs, and the batch `ICoordinator`
   (single-shot). End-to-end: prompt → DAG → execute → aggregated result.
   Honors progressive-complexity (default leans to a single-node plan). The
   contracts needed by this slice are defined here.
2. **Plan reviewer gate** — `IReviewStrategy` (LLM critic) + the review stage
   between planning and execution (gate, fail-loud). Additive on top of slice 1.
3. **Replan-by-leaf-signal + remove nested dispatch** — `IErrorStrategy` +
   leaf-signal on `StepResult`; coordinator re-plans a failed node into a finer
   sub-graph; remove/migrate the #128–#132 nested-dispatch surface. That surface
   is not only the orchestration machinery (`maxLayer`, layer validation,
   cross-layer epicfail propagation) but also the **public-API fields** that
   encode nesting: `ISubAgentInput.layer`, `SubAgentCapabilities.canDispatchChildren`,
   and the `SubAgentCapabilities.kind` `'autonomous' | 'constrained'` distinction
   (which collapses once subagents are always leaves). This slice marks them
   removed/deprecated/migrated (implementation detail deferred to the slice spec).
   Self-sufficient behavior change.
4. **Dialog / resumable coordinator** — second `ICoordinator` implementation:
   pause-on-clarification + resume across turns (the resumable-gate back-end).

Order: 1 → 2 → 3 → 4 (each shippable independently). Sequencing revisited per
slice; remaining interfaces (e.g. `ICoordinator` second impl, `IReviewStrategy`)
are introduced in the slice that first needs them.

## Out of scope / deferred

- Result-side review (output ≡ prompt) and the empty-but-ok LLM output edge from
  #155 — a separate result-side concern, not this plan-side reviewer.
- Speculative role implementations beyond what a consumer needs (YAGNI): we
  define interfaces broadly but implement only the listed concrete classes.

## Builds on / changes

- Builds on #145 (coordinator authors the task) and #155 (answer-directly,
  default hybrid dispatch).
- Removes the nested-dispatch foundation (#128–#132): orchestration (`maxLayer`,
  layer validation, cross-layer epicfail propagation) AND the public-API surface
  that encodes nesting (`ISubAgentInput.layer`, `SubAgentCapabilities.canDispatchChildren`,
  the `kind: 'autonomous' | 'constrained'` distinction). Scoped to slice 3.
