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
  executor     // bottom: MCP-tool call OR terminal LLM call;
               // writes step artifacts to knowledge-RAG as they are produced
}
```

(Finalizer is NOT part of the Stepper. It exists once, at the coordinator boundary above the root Stepper — see Q5.)

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
  missing?: string[];                      // populated when status = incomplete
  usage: LlmUsage;
}
```

No fields named "context", "tools allowlist", "facts": the Stepper gets handles, not payloads.

**Internal Steppers do not return text** (`output` is absent from the result by design — Q5/2026-05-29). Step artifacts are written into the knowledge-RAG by the executor as they are produced, and the next Stepper's planner reads them back via `knowledgeRag.query(...)`. Only the root finalizer (which is NOT a Stepper but a coordinator-level component) produces the consumer-facing text by reading the original prompt and the accumulated knowledge-RAG at the end of the run.

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
   - **2026-05-29 answer (user):** **per-level opt-in with smart defaults**. Default: reviewer ON at depth 0 (root) and depth 1, OFF at depth ≥ 2. Config override via `coordinator.reviewer.atDepths: [0, 1, …]` or `coordinator.reviewer.atDepths: 'all'`. Rationale: root reviewer catches catastrophic misreadings of user prompt; level-1 reviewer catches catastrophic decomposition errors. Below that the cost (extra serial LLM round-trip per Stepper) outweighs the value because reviewers at deep levels see only a narrow local task, not the global goal. **Async reviewer** (parallel-with-executor; reject triggers replan on next iteration without blocking emit) is captured as an 18.x optimisation, not a default.
3. **knowledge-RAG scope.** Per-session (knowledge survives across user requests in the same session) or per-Stepper-tree (isolated per top-level request)?
   - **2026-05-29 answer (user):** **per-session, single internal collection**. There is one knowledge-RAG collection per session; every Stepper executor writes step results into it; every Stepper planner reads from it for context augmentation. That is the entire scope decision.
     Operational concerns (LRU eviction when the collection grows large, optional explicit reset endpoint, TTL) are deferred — they will be added if/when operational pain (collection bloat, debug needs, privacy/compliance) surfaces. Not part of the v1 design.
     Cross-topic poisoning is a non-concern: vector RAG self-filters via semantic distance, so a query about program Y against a collection populated by program X returns near-zero relevance and the planner ignores it.
     17.0 session-scoped infrastructure already provides the per-session lifecycle (cookie identity, session graph, draining on close) — the knowledge collection slots into that machinery directly.
4. **Parallelism.** Allow concurrent child Steppers, or sequential only? Concurrent simplifies latency but complicates RAG conflict resolution.
   - **2026-05-29 answer (user):** parallelism is a **planning concern, not a runtime concern**. The planner decides — if it emits steps with no `dependsOn` between them it is asserting they are orthogonal; the interpreter is then free to run them concurrently. If the planner emits `dependsOn` chains, they run sequentially. The interpreter never reorders or parallelises against the planner's intent.
     Operational guard: `coordinator.stepper.maxParallelSteps` config caps concurrent child Steppers per parent (default 4; `0` or `1` forces effectively sequential; higher allows wider fan-out where deployment quota permits). Standard worker-pool semantics: when the wave is wider than the cap, ready nodes queue, slot opens on `node-end`.
     **Scope (clarified 2026-05-29):** ONE global config value, locally enforced per Stepper. Each Stepper applies the cap to its own children independently — there is no cross-tree semaphore. Worst-case math (deeply nested fan-out): `maxN^depth` concurrent at peak. With `maxN=4` and depth 3 → 64 concurrent. Real plans rarely fan out wide at every level (typical shape: wide at one review-style level, narrow elsewhere), so 4 is a sensible default for most deployments; raise to 8 on enterprise quotas with no rate limits. If operational pressure surfaces (rate-limit storms on deep + wide trees), a global semaphore is captured as an 18.x add-on, not a v1 default.
     Duplicate-fact race in knowledge-RAG (two siblings independently fetch the same fact and write near-identical vectors concurrently) is a **planner failure**, not a runtime concern — if two steps were meant to return the same fact, the plan should have had ONE step. When it happens despite that, consequences are harmless in v1: vector store inserts are commutative, semantic search returns either copy, planner sees the fact regardless. Cost is wasted LLM/MCP calls, debug noise from duplicate entries. Post-hoc dedup by semantic-similarity threshold is deferred to 18.x if operational pain surfaces.
5. **Finalizer at every level vs. root only.** Per-level finalizer = per-level LLM call; potentially significant cost. Allow `finalizer: pass-through` as default on internal levels?
   - **2026-05-29 answer (user):** **ONE finalizer at root only.** Internal Steppers do not have finalizers. They write their step artifacts (source code, MCP results, intermediate analyses) into the knowledge-RAG via the executor as they are produced, and return a STATUS only (`ok` / `incomplete` / `budget-exhausted` with `missing[]`) — not text.
     The root finalizer is the single text producer. Its job:
     - read the original consumer prompt;
     - read the session's knowledge-RAG;
     - decide: either compose the final answer from the RAG, OR raise an `insufficient` signal carrying `missing[]` upward to the coordinator.
     The coordinator on `insufficient` either returns "not enough info, here's what's missing" to the consumer, or — if budget allows — triggers a replan at root with the `missing[]` as hint.
     This collapses the entire per-level finalizer story (Passthrough/Template/LlmFinalizer on internal Steppers) into nothing: there are no internal finalizers. Data flows through the knowledge-RAG, not through return values. Internal Steppers are silent in text and active in RAG.
6. **Cycle protection signature.** Hash `(prompt, ancestorPath)` only, or `(prompt, ancestorPath, knowledgeRagFingerprint)`? Second is stricter, costs an embedding lookup.
7. **Streaming `StreamChunk` annotation.** Add `depth: number` and `path: string[]` for hierarchical client rendering, or keep flat?

## 11.5 Modes of operation

The 18.0 architecture is not one single execution pattern — it is **three modes** layered on the same Stepper contract. A deployment picks the mode (or default-per-request) based on task complexity.

### Mode A — Cyclic flat with context-augmenting ReAct
**For:** simple, single-task prompts where decomposition is overkill.
**Shape:** one Stepper, no recursion. Its planner emits a single-step plan "answer the user prompt". The executor is a **context-augmenting ReAct loop**:

```
prompt + initial RAG retrieval → LLM call
  → analyse response:
       • clean final answer  → write to knowledge-RAG, return
       • tool call            → execute MCP, append result, loop
       • "I can't, I need X"  → query MCP-RAG for X capability,
                                inject candidate tools into context, loop
       • "I have A but need B" → same: query MCP-RAG with B's intent,
                                 inject tools, loop
  → repeat until clean final OR budget exhausted
```

The differentiator from today's tool-loop is the **meta-action on negative/conditional responses**. When the LLM says it lacks a capability, the loop treats the utterance as an MCP-RAG query and ENRICHES the available tool set on the fly. The LLM does not have to know what tools exist — it expresses needs, and the runtime maps needs to tools.

Example trace for "Analyse program X":
1. LLM: *"I can't read the program code."* → query MCP-RAG `"read program code"` → inject `ReadProgram`, retry step.
2. LLM: *"Call ReadProgram(X)."* → execute, inject result.
3. LLM: *"I see the source, but I need its include files."* → query MCP-RAG `"read include code"` → inject `GetIncludesList`, `ReadInclude`, retry.
4. LLM: *"Call GetIncludesList(X)."* → execute. *"Call ReadInclude(I1)."* → execute. ...
5. LLM: clean final analysis → write to knowledge-RAG, return.

### Mode B — Deep recursive Stepper hierarchy
**For:** multi-faceted decomposable tasks where the planner can't see everything in one shot. The "deep reasoning / deliberation" mode.
**Shape:** the full §1-10 vision — every Stepper has its own planner, plans are shallow, decomposition is deferred, child Steppers recursively expand. Sufficiency oracle (§6/Q1) governs depth.

### Mode C — Recommended hybrid (planner top, cyclic workers below)
**For:** the production-realistic case — most real workloads.
**Shape:** top-level planner emits a shallow plan (mode B at the root only, depth 1). Each plan step is dispatched to a **Mode A cyclic worker** (no further recursion). The cyclic worker handles its assigned step with context-augmenting ReAct, writes the clean result to knowledge-RAG, returns.

Why this is the sweet spot:
- The planner provides structural decomposition — "first read code, then review it" — that pure ReAct cannot reach.
- The workers handle local intelligence — discover tools, fetch missing context — without paying the cost of recursive planning at every level.
- Knowledge-RAG accumulates between workers, so step N+1 starts already enriched by step N's outputs.
- Latency stays low — no per-level reviewer chain, no per-level finalizer.
- Budget is naturally bounded — planner caps the number of workers, each worker has its own iteration cap.

Mode C is the **default proposal** for 18.0. Modes A and B exist as the limit-cases (no planner / planner at every level). The runtime can degrade from C to A automatically if the planner emits a single-step plan, or escalate to B when sufficiency oracle (§6) signals a Stepper to recurse.

### Three YAML modes, ONE runtime contract

This translates to three pipeline modes exposed via config:

```yaml
mode: cyclic-react     # Mode A — context-augmenting ReAct
mode: deep-stepper     # Mode B — full recursive Stepper hierarchy
mode: planned-react    # Mode C — root planner + cyclic-react workers (default)
```

But **internally there is ONE Stepper contract** — the modes differ only by which planner / executor / recursion policy is wired:

| Mode | Stepper depth cap | Planner | Leaf executor | Runtime composition |
|---|---|---|---|---|
| `cyclic-react` | 0 (single Stepper) | trivial single-step planner ("answer the prompt") | `CyclicReActExecutor` (uses `INeedResolver`) | flat |
| `deep-stepper` | ∞ (bounded by §6) | full `IStepperPlanner` at every level | recursive child Stepper | tree |
| `planned-react` | 1 (root planner, leaves are cyclic) | full `IStepperPlanner` at root | each leaf step → a `cyclic-react` Stepper | mixed |

Shared components implemented once: `IStepperPlanner`, `IStepperInterpreter`, `IExecutor`, `IKnowledgeRag`, `INeedResolver`, `ISufficiencyOracle`, the recursive dispatch mechanic, the knowledge-RAG accumulator contract. The three "pipelines" are wiring configurations, not three independent implementations.

### Context-augmenting ReAct — the under-recognised pattern

The "LLM expresses a need → runtime translates need into tool/RAG retrieval → tools/context injected, retry" loop is the single most important new pattern in modes A and C. It deserves its own contract:

```ts
interface INeedResolver {
  /** Inspect an LLM utterance for a 'need' signal (cannot do X, lacks Y).
   *  Return the augmentations to apply (tools to inject, RAG queries to run)
   *  or undefined if the response is a clean answer or a normal tool call. */
  resolve(response: string): Promise<{
    queryToolsRag?: string;
    queryKnowledgeRag?: string;
    injectTools?: string[];
  } | undefined>;
}
```

Implementations can be deterministic (regex over phrasings like "I can't" / "I need") or LLM-driven (small classifier call: "is this utterance expressing a need, or a clean answer, or a tool call?").

---

## 12. What this is NOT

- It is not "add more nodes to a flat plan". It is a recursive runtime where decomposition is deferred to the point where ambiguity resolves.
- It is not "give the planner a bigger system prompt". The planner is the same shape at every level; the architecture is in the recursion + RAG, not the prompt.
- It is not a refinement of 17.0. It is a worker/coordinator contract reshape. 17.0's roles surface (IFinalizer / IStateOracle / per-role LLM map / streaming) all carry forward as parts of the Stepper contract, but the Stepper's RECURSIVE composition is new.

---

This document is preserved for further thought. Next concrete step is the user weighing in on the §11 open questions; once those are settled, this becomes a proper design spec and we author an implementation plan.
