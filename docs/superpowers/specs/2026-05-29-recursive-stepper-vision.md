# 18.0 Vision — Recursive Stepper Hierarchy over a Shared Knowledge-RAG

> **Status:** DRAFT / exploration. Not implementation-ready. Open questions section at the end must be settled before this can become a plan.
> **Date:** 2026-05-29 (captured from live brainstorm; 17.0.0 merged).
> **Replaces:** the 17.1 "RAG-aware planner + plan-driven context delivery" sketch in `memory/project_rag_aware_planner_goal.md`.

---

## 1. The insight

A worker today cannot say "I need more steps". It can only call tools its parent allowed and return what it found. If `read program X full code` discovers includes, the worker emits a final answer with what it has — the parent has no signal that more decomposition was needed.

A flat top-down plan from an omniscient planner does NOT solve this — the planner cannot foresee every dependency that only surfaces during execution.

**The fix is recursive decomposition with deferred discovery.** Each level plans only what it can SEE; new sub-steps emerge as execution proceeds and new facts land in a shared knowledge store.

## 2. Single recursive shape

Every node in the runtime hierarchy has the same composition:

```
Stepper {
  planner      // emits a SHALLOW plan from prompt + knowledge-RAG queries
  reviewer     // validates plan matches parent task + RAG state
  interpreter  // dispatches steps → child Steppers OR executor
  executor     // bottom: MCP-tool call OR terminal LLM call
  finalizer    // synthesises answer from accumulated knowledge before bubbling up
}
```

The Coordinator is the **root Stepper**. Workers / subagents are Steppers at non-root depth. The runtime makes no fundamental distinction between coordinator and worker — they share a contract, only their position in the tree differs.

## 3. Plans are shallow

A planner produces the smallest plan that is locally meaningful, deferring deeper decomposition to child Steppers. Example walk-through for the user prompt
**"Read full code of report Z and code-review it"**:

```
Root Stepper
└─ planner → [
     { goal: "read full source of Z" },
     { goal: "code-review Z" },
   ]
  ├─ Child A (read source of Z)
  │  └─ planner queries knowledge-RAG → source absent
  │     → [{ goal: "fetch source of Z" }]
  │     └─ Grandchild
  │        └─ planner sees GetProgFullCode in tools-RAG
  │           → [{ goal: "call GetProgFullCode(Z)" }]
  │           └─ executor: GetProgFullCode → write to knowledge-RAG → return
  └─ Child B (code-review Z)
     └─ planner queries knowledge-RAG → source PRESENT
        → [
            { goal: "security review" },
            { goal: "performance review" },
            { goal: "cleancore review" },
            { goal: "maintainability review" },
          ]
        ├─ Child B1 (security review)
        │  └─ planner queries knowledge-RAG → source YES; CWE patterns NO
        │     → [
        │         { goal: "list ABAP security CWE patterns" },
        │         { goal: "scan source for patterns" },
        │         { goal: "format findings" },
        │       ]
        │     …recurses…
        …
  └─ root.finalizer reads accumulated knowledge-RAG → writes final markdown answer.
```

A Stepper that bottoms out is one whose planner emits a single-step plan whose goal is **"call tool X"** or **"answer directly from RAG"**. The executor handles that.

## 4. Shared knowledge-RAG (the blackboard)

Two RAGs are visible to every Stepper, inherited from the root:

| RAG | Stores | Written by |
|---|---|---|
| **tools-RAG** | MCP + consumer-passed tool descriptions | static (boot time) |
| **knowledge-RAG** | Output of every executed step (source code, MCP results, intermediate analyses) | every executor after a successful call |

**Before building a plan, a planner queries knowledge-RAG with its task as the query.** If a needed fact is already there, no step is added to refetch it. If it is missing, the planner adds a step to obtain it (which may itself recurse).

The knowledge-RAG is the only inter-Stepper data channel. There is no `preparedContext` text bundle handed down. Each Stepper retrieves what it needs from the RAG itself.

## 5. The Stepper interface

```ts
interface IStepperInput {
  prompt: string;                          // narrow task from parent
  knowledgeRag: IKnowledgeRagHandle;       // read + write
  toolsRag: IToolsRagHandle;               // read only
  budget: { depthRemaining: number; tokensRemaining: number };
  signal?: AbortSignal;
  sessionLogger?: ISessionLogger;
}

interface IStepperResult {
  status: 'ok' | 'incomplete' | 'budget-exhausted';
  output?: string;                         // present when status = ok
  missing?: string[];                      // present when status = incomplete
  usage: LlmUsage;
}
```

No fields named "context", "tools allowlist", "facts": the Stepper gets handles, not payloads.

## 6. Sufficiency oracle — the central hard problem

Without a sufficiency mechanism the recursion either runs forever (always one more thing to fetch) or terminates early (premature "good enough"). Four candidate mechanisms:

1. **Hard budget.** Every Stepper has `depthRemaining` and `tokensRemaining`. Inherited from parent and decremented. Predictable, no LLM cost, but blunt.
2. **Planner self-check.** Before adding a `fetch X` step, the planner asks itself "can I answer the parent task without X? If yes — drop". LLM-driven, smooth, but per-step cost.
3. **Bottom-up INCOMPLETE signal.** A child that exhausts its budget returns `{ status: 'incomplete', missing: [...] }`. Parent decides — add a step to satisfy `missing`, or escalate.
4. **Reviewer as sufficiency gate.** The reviewer at each level sees the candidate plan + current knowledge-RAG. Rejects plans that say "answer" with empty RAG or "fetch more" when RAG is already saturated.

Realistic combination: **(1) + (3)** — hard budget as the floor, INCOMPLETE bubbling as composable coordination. (2) and (4) are nice-to-have refinements.

## 7. Streaming through the recursion

17.0's `onPartial` callback must propagate child → parent → root → SSE. Each Stepper that receives an `onPartial` forwards it to children, optionally injecting depth/path annotations into the `StreamChunk` (so the client can render hierarchical progress).

## 8. Practical concerns

1. **Cycle protection.** Stepper.planner must not propose a step it has already seen at any ancestor (e.g. grandchild proposing "fetch source of Z" when parent is already doing exactly that). Detection: hash `(prompt, ancestorPath)` — refuse to plan a step that matches an ancestor's prompt.
2. **knowledge-RAG embed cost.** Every step output is embedded into the vector store. Use a cheap embedder (we already have `sap-ai-core` text-embedding-3-small wired).
3. **Stepper instantiation cost.** Recursive spawn at scale needs the session-scoped infrastructure that landed in 17.0 (per-session graph, identity-bound RAG views, token-usage rollup keyed by traceId).
4. **Finalizer scope.** Each level's finalizer should synthesise only what's relevant to its parent's prompt — not re-summarise the entire global trace. Decision: finalizer reads its OWN subtree's knowledge-RAG entries only (by ancestor-path filter).
5. **Parallel children.** If a Stepper emits multiple steps with no `dependsOn`, the interpreter may run them concurrently. Knowledge-RAG writes from concurrent children must be commutative; if two children produce conflicting analyses of the same artefact, last-write-wins with timestamp is acceptable (the finalizer will re-read at synthesis time).

## 9. What this resembles

| Pattern | Match | Mismatch |
|---|---|---|
| **HTN planning** (Hierarchical Task Network) | Recursive HIGH→LOW decomposition | HTN is deterministic; here every level is LLM-authored |
| **Blackboard architecture** (Hearsay-II, 1970s) | Shared knowledge store; independent agents read/write | Classical blackboards have fixed knowledge sources; ours are spawned dynamically |
| **ReAct + reflection** | Each Stepper is a ReAct loop internally | ReAct alone is flat; recursion + shared knowledge are our extension |
| **LangGraph hierarchical agents** | Tree of agents | LangGraph graphs are pre-defined; ours decomposes at runtime based on RAG state |
| **Voyager / AutoGPT** | Recursive self-spawning | Voyager's skill library is a tool catalog; we add a knowledge accumulator |

Closest one-line description: **"Recursive ReAct over a shared blackboard with LLM-driven HTN decomposition"**.

I have not seen this combination formalised end-to-end in published systems. Individual parts (blackboard, HTN, ReAct, hierarchical agents) are well-studied; their composition appears novel.

## 10. Terminology to settle in the docs

| Today | 18.0 | Semantics |
|---|---|---|
| Coordinator / Worker / Subagent | **Stepper** | Single recursive shape |
| `IPlanner` | `IStepperPlanner` | Same contract at every depth |
| `IInterpreter` | `IStepperInterpreter` | Dispatch step → child Stepper OR executor |
| (new) | `IExecutor` | Terminal — MCP call or final LLM call |
| (new) | `IKnowledgeRag` | Accumulating RAG handle (read + write) |
| (new) | `ISufficiencyOracle` | Stop-condition arbiter (mechanism per §6) |

## 11. Open questions (must be settled before plan)

1. **Sufficiency mechanism.** Which of §6 (1)–(4), or which combination?
   - **2026-05-29 answer (user):** combo **(1) + (3) + budget-extension clarify**. Hard budget by default; on exhaustion, instead of silently returning `incomplete`, the Stepper raises a `ClarifySignal`-style query upward: *"Budget exhausted at depth N / X tokens used. Continue with extended budget, or stop with what we have?"* The consumer answers `continue` (extend budget, resume) or `stop` (return partial). Rationale: when running against corporate SAP AI Core, rate/cost limits are either huge or absent and the consumer wants the answer — they should not be forced to a hard cap. When running against rate-limited public providers, the same mechanism gives the consumer a graceful stop. Default budget exists; consumer can extend.
   - **Open sub-question (1a) — Resume:** the "extend budget and continue" branch implies the Stepper subtree can be paused and resumed without re-doing completed work. Session-scoped infrastructure (17.0) and the knowledge-RAG would carry intermediate state across the pause; the remaining un-executed plan steps would be re-dispatched on resume. User flagged: *"maybe this is too much"* — formal pause/resume adds a lot of state-management surface. Cheaper alternative: on `continue`, restart from scratch with a 2× budget; the knowledge-RAG already holds prior results so re-planning at each level will skip the work that was completed (because its planner sees the result already in RAG). Decision deferred.
2. **Reviewer at every level vs. root only.** Deep recursion + per-level reviewer multiplies cost. Skip on internal levels?
3. **knowledge-RAG scope.** Per-session (knowledge survives across user requests in the same session) or per-Stepper-tree (isolated per top-level request)?
4. **Parallelism.** Allow concurrent child Steppers, or sequential only? Concurrent simplifies latency but complicates RAG conflict resolution.
5. **Finalizer at every level vs. root only.** Per-level finalizer = per-level LLM call; potentially significant cost. Allow `finalizer: pass-through` as default on internal levels?
6. **Cycle protection signature.** Hash `(prompt, ancestorPath)` only, or `(prompt, ancestorPath, knowledgeRagFingerprint)`? Second is stricter, costs an embedding lookup.
7. **Streaming `StreamChunk` annotation.** Add `depth: number` and `path: string[]` for hierarchical client rendering, or keep flat?

## 12. What this is NOT

- It is not "add more nodes to a flat plan". It is a recursive runtime where decomposition is deferred to the point where ambiguity resolves.
- It is not "give the planner a bigger system prompt". The planner is the same shape at every level; the architecture is in the recursion + RAG, not the prompt.
- It is not a refinement of 17.0. It is a worker/coordinator contract reshape. 17.0's roles surface (IFinalizer / IStateOracle / per-role LLM map / streaming) all carry forward as parts of the Stepper contract, but the Stepper's RECURSIVE composition is new.

---

This document is preserved for further thought. Next concrete step is the user weighing in on the §11 open questions; once those are settled, this becomes a proper design spec and we author an implementation plan.
