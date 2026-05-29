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
   - **2026-05-29 answer (user):** **no hash-based protection at all.** Cycles are prevented by three layered properties of the existing model, not by an explicit detector:
     1. **RAG-first planning (primary).** Every planner queries the knowledge-RAG before authoring its plan. If a fact is already there, the planner does not add a step to fetch it. The "same data needed at depth 1 and depth 3" case (e.g. program source referenced by both fetch-once at level 1 and security-scan at level 3) is naturally handled — level 3's planner sees the source in RAG and uses it instead of re-fetching.
     2. **PLANNER_SYSTEM directive "decompose to concrete leaves".** The planner system prompt instructs: if a task is achievable by ONE tool call, emit that tool call as the single plan step — do NOT re-decompose by repeating the parent's task verbatim. This is the same principle 17.0 already applies to "single-object multi-dimension → ONE node" (Task 15 of PR #163), extended to the recursive case.
     3. **Depth budget (insurance).** Q1's hard depth cap is the bottom-floor protection. If a planner mis-behaves and recurses anyway, budget exhaustion eventually halts it with `incomplete + missing[]`.
     The previously-proposed `(prompt, ancestorPath, knowledgeRagFingerprint)` hash detector was over-engineered. None of the three layers above needs an explicit hash — they prevent cycles by construction. A pathologically bad planner would trip the depth budget; that is acceptable insurance, not a routine concern.
7. **Streaming `StreamChunk` annotation.** Add `depth: number` and `path: string[]` for hierarchical client rendering, or keep flat?
   - **2026-05-29 answer (user):** the question was reframed. There are two different streaming goals that were being conflated:
     - **Content streaming** (Claude.ai-style token-by-token text rendering).
     - **Progress streaming** ("I am alive, here is what is happening" heartbeat).
     For the 18.0 backend nobody reads per-leaf content while the tree is executing — the consumer wants the answer at the end, and a progress signal in between to know the run isn't dead. Content streaming is needed only at the **root finalizer** (one sequential LLM call, naturally ordered, no parallel-sibling interleaving problem). During execution, only structured progress events are sent.
     **Answer:** extend `StreamChunk` discriminated union with new progress-event variants and keep `content` for the root finalizer's text stream. No `path`/`depth` arrays on every chunk — if the consumer wants topology it reconstructs from `source` / `parent` fields on the events.

     ```ts
     type StreamChunk =
       // Existing 17.0 — used by the root finalizer for its sequential text output
       | { kind: 'content'; delta: string }
       // 18.0 progress events bubbled up from internal Steppers
       | { kind: 'stepper-spawned'; source: string; goal: string; parent?: string }
       | { kind: 'stepper-done';    source: string; ok: boolean }
       | { kind: 'mcp-call';        source: string; tool: string; args?: unknown }
       | { kind: 'mcp-result';      source: string; tool: string; durationMs: number; bytes?: number }
       | { kind: 'tokens-used';     source: string; component: LlmComponent; delta: LlmUsage }
       | { kind: 'llm-call-start';  source: string; component: LlmComponent; model: string }
       | { kind: 'llm-call-end';    source: string; component: LlmComponent; durationMs: number };
     ```

     `source` = Stepper name (debug label). `parent?` lets a UI build a topology view if it wants one. Coordinator at the root has policy on which events to forward to consumer SSE:
     - **Default** — pass through all progress events + finalizer content.
     - **Quiet mode** — only `tokens-used` aggregated every N seconds + finalizer content (minimum-noise heartbeat).
     - **Verbose** — everything including individual `tokens-used` per LLM call.
     The earlier `(β) depth + path` proposal is dropped — it solved the parallel-siblings interleaving problem for content, but content is no longer streamed in parallel (only the finalizer streams content, and it's a single sequential call). path-arrays would be over-engineering.

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

## 11.6 Interaction modes — read/analyse vs. create/mutate

The §11.5 modes (cyclic-react / deep-stepper / planned-react) are execution shapes. Orthogonal to those is the **interaction semantics**, which differs sharply between the two large classes of prompts the system serves.

### Read / analyse mode (covered by §1-10 directly)

For "read program X" / "review code" / "answer question Y" prompts the model is:

```
prompt → plan → execute (write to knowledge-RAG) → root finalizer reads RAG → text answer
```

Single-shot. The consumer fires one prompt, gets one answer (possibly with mid-flight ClarifySignal for genuinely ambiguous requirements). No mid-execution side effects. The root finalizer either composes the answer from accumulated RAG or returns "insufficient: missing X".

### Create / mutate mode (new semantics)

For "create class Z with methods A, B, C" / "refactor X to use Y" / "scaffold a CDS view for table T" prompts the picture changes:

1. **Mutating side effects** must be confirmed before they happen — the agent cannot silently create artefacts in the consumer's SAP system.
2. **Iterative consumer input** is expected — "also add field email" mid-execution, "wait, change the parent class first", etc. The interaction becomes a conversation rather than a single round-trip.
3. **Multi-turn within one task** — the consumer's first prompt is rarely complete; they refine as the agent shows them what it is producing.
4. **Idempotency / rollback / transactionality** — if step 3 of 5 fails, the system state is partially mutated; do we roll back, retry, or report-partial?

### What's the same

The Stepper architecture, all four roles (planner / reviewer / interpreter / executor), the knowledge-RAG, the root finalizer — all unchanged. Mutate prompts are just plans that include mutating tool calls and tend to raise more signals.

### What's new

1. **Tool annotation: read-only vs. mutating.** A new metadata field on MCP-tool descriptions distinguishes the two classes. Executor policy:
   - read-only tool → call without confirmation;
   - mutating tool → raise `ClarifySignal('about to call <tool>(<args>), proceed?')` before the call (unless `mutationPolicy: trusted` is configured for this session).
2. **`ClarifySignal` becomes the main interactivity primitive.** Today (17.0) it is used sparingly for genuinely ambiguous plan inputs; in mutate mode it is the standard pre-action confirmation gate. Same signal type — broader use.
3. **Multi-turn consumer dialogue within one session.** Two cases:
   - **(a) Answering a pending signal** — consumer replies `yes`/`no`/`<modified args>` and the coordinator resumes the paused Stepper with that answer. The 17.0 ClarifySignal flow handles this directly.
   - **(b) New top-level prompt mid-execution** — "actually, also add field X". Three policies, to be decided:
     - **i. Cancel + replan**: abort the in-flight plan, capture what was already done in knowledge-RAG, replan from the combined prompt.
     - **ii. Append-to-plan**: add "add field X" as a new step to the running plan, dispatched after the current wave completes.
     - **iii. Queue for next logical iteration**: complete the current plan, then start a fresh plan for the new prompt — knowledge-RAG carries everything done so far. Cleanest semantics; lowest user-experience interactivity.
     - **2026-05-29 open question — recommend (iii) for v1**, (i) and (ii) deferred to 18.x. Rationale: (iii) maps cleanly to existing session-scoped infrastructure; (i) and (ii) require mid-plan amendment machinery not present in 17.0.
4. **Idempotency / rollback / transactionality — deferred.** v1 is best-effort: executor writes "snapshot" entries to knowledge-RAG before and after every mutating tool call so subsequent planners can see the state, but no automatic rollback on failure. A failed step leaves the system in a partially-mutated state and the coordinator returns `step <id> failed; system state may be partial; see knowledge-RAG entries <X, Y, Z> for last known state`. Full transactional semantics is a separate enterprise-workflow-engine concern out of scope for this vision.

### Why this matters for Q1 / Q5

The Q5 simplification (one finalizer at root, internal Steppers return status only) still holds for mutate prompts — the root finalizer reads knowledge-RAG and either confirms "X created at Y with state Z" or raises `insufficient: <what consumer must clarify>`. The difference is only that during execution the path is dotted with ClarifySignal pauses for mutate confirmations.

The Q1 sufficiency mechanism (budget + INCOMPLETE bubble + clarify-extension) also unchanged — it is orthogonal to whether the work is read or mutate.

---

## 11.7 Session persistence and resume

Read/analyse and create/mutate prompts both presume **one running session**. For real-world use, users also need to **leave** and **come back** — close the browser today, open it tomorrow, pick up the prior session, continue. The pattern is what Claude.ai, Claude Code, ChatGPT and Codex implement: persistent conversation list + resume.

### How peer products do it

| Product | Persists | Resume mechanism | Cross-session memory |
|---|---|---|---|
| Claude.ai (web) | Conversation = messages + artefacts, keyed by `(conversation_id, user_id)`, server-side store | User picks from sidebar → server reloads the tree | Opt-in "memory" feature — a separate user-scoped store of facts the user explicitly marks |
| Claude Code (CLI) | Append-only JSONL at `~/.claude/projects/<project-hash>/<session-id>.jsonl` | `/resume` lists, picks one, replays the JSONL into context | `MEMORY.md` index + per-fact memory files — separate user-controlled layer |
| Codex / ChatGPT | Conversations sidebar | Click → load message tree | "Memory" feature, opt-in, separate |

Common shape:
1. **Stable `session_id`** (not just an ephemeral cookie).
2. **Persistent storage** — DB rows + (for RAG-equipped systems) vector store.
3. **List/resume/delete API** for the consumer surface.
4. **Replay on resume** — runtime state is reconstructed from the persistent log.
5. **Cross-session memory is a SEPARATE layer**, opt-in, distinct from per-session knowledge.

### What 17.0 already gives us

- Cookie-bound session identity → can map to a stable `session_id` in a metadata table.
- `SessionGraph` lifecycle (mint / acquire / release / drain) — already structured for the in-RAM case; extending the slot for "rehydrate from store" is mechanical.
- Persistent vector-store backends for RAG (`qdrant`, `hana-vector`, `pg-vector`) — already configurable. The 18.0 knowledge-RAG can plug into them directly.
- `/v1/usage` already runs per-session — the same identity routing handles per-session list/resume.

What's missing:
1. **Stable session_id** distinct from the cookie. The cookie maps to one, but users need to list / name / pick / delete by ID, not by cookie.
2. **Session metadata store** — a small table (Postgres recommended) with `(user_id, session_id, title, created_at, last_used_at, status)`.
3. **Persistent message history** — either in the metadata DB or as append-only JSONL á la Claude Code; latter is simpler ops-wise.
4. **`/v1/sessions` API surface** — `GET` (list), `POST /<id>/resume` (claim), `DELETE /<id>` (purge).
5. **Persistent knowledge-RAG keyed by session_id** — use one of the configured persistent backends; in-memory store remains the default for stateless deployments.

### Cross-session memory — explicit separate scope

The 17.0 project memory record notes: *"user-scope only lives in a separate auth-enabled downstream build; default server = global+session"*. Holding that line: cross-session ("user-scoped") memory is a SEPARATE knowledge collection, available only in auth-enabled downstream builds. The public open-source build supports session-scoped persistence (resume the same conversation) but does NOT auto-bleed facts across conversations.

### Mid-plan resume after crash

Hardest case: the server died mid-plan (3 of 5 nodes executed). Two options:
- **(a) Full transactional resume.** Checkpoint plan state (executed/pending nodes, current Stepper subtree) at every `node-end`. On restart, restore and continue from the next un-executed node. Requires durable plan state, idempotent executor semantics, careful concurrency. Significant engineering — full workflow-engine territory. **Deferred to 18.x or 19.x.**
- **(b) RAG-replay resume.** No checkpointing of plan state. On restart, the knowledge-RAG still holds whatever executors wrote. Coordinator detects `status: in-progress` sessions and either (i) prompts the consumer "the last run died mid-flight — restart? (planner will re-plan from current RAG state, completed work won't be repeated because the new planner sees it)" or (ii) silently flips the session to `idle` and waits for the next prompt. **This is the v1 18.0 answer** — it costs nothing extra because the knowledge-RAG was going to persist anyway, and re-planning from saturated RAG cheaply re-uses prior work without true checkpointing.

### Open question for spec stage

When session is resumed, do we replay the entire message history into the LLM context (like Claude.ai), or do we let the planner start fresh and rely on knowledge-RAG to provide the prior facts? Replay = the LLM sees the literal prior dialogue, useful for reference-by-pronoun ("the second method you suggested"). RAG-only = cheaper, lossier on conversational continuity. Probably a config switch.

---

## 12. What this is NOT

- It is not "add more nodes to a flat plan". It is a recursive runtime where decomposition is deferred to the point where ambiguity resolves.
- It is not "give the planner a bigger system prompt". The planner is the same shape at every level; the architecture is in the recursion + RAG, not the prompt.
- It is not a refinement of 17.0. It is a worker/coordinator contract reshape. 17.0's roles surface (IFinalizer / IStateOracle / per-role LLM map / streaming) all carry forward as parts of the Stepper contract, but the Stepper's RECURSIVE composition is new.

---

This document is preserved for further thought. Next concrete step is the user weighing in on the §11 open questions; once those are settled, this becomes a proper design spec and we author an implementation plan.
