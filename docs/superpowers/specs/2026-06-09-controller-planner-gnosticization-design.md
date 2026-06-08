# Controller Planner: Gnosticization & Completeness — Design

**Status:** active design (read/general controller behaviour; WRITE concerns explicitly out of scope for now).

**Builds on:** PR #177 (agnostic controller role prompts + optional per-role
operational `hint`) and the adaptive planner (PR #176).

## Problem

The `controller` pipeline decomposes a request into steps that an executor runs
via tools. Two weaknesses surfaced in live experiments on E19:

1. **Coarse tool selection.** The catalog given to the *planner* is built once
   from the whole input prompt — `selectTools(`${goal}\n${prompt}`)` in
   `controller-coordinator-handler.ts` (~line 265), reused on every iteration
   incl. replan (~line 290). Only the *executor* re-selects per step (~line 444).
   For "analyze program ZDAZ_R_DELAYED_UPDATE" the prompt-level selection
   surfaced run/write tools (RuntimeRunProgram/UpdateProgram), never the
   read tools the actual "fetch source" step needed.

2. **Discovery depends on executor intelligence.** Adaptive's replan only fires
   when the executor *signals* a failure/insufficiency. A capable executor
   (sonnet) detected "I can't properly read this" and replanned (but flailed,
   ~207k tokens against the wrong toolset); a weak executor (gpt-4o-mini)
   **confabulated** the program's include structure without ever fetching it —
   1 planner call, 0 replan, 0 error: confident but ungrounded. Weak models do
   not recognise that a prerequisite is missing, so the reactive replan trigger
   never trips.

## Guiding principle (unchanged)

The engine **code stays agnostic** — role prompts say "the live target system",
never "SAP"/"ABAP", and never name tools. Domain/operational knowledge enters at
runtime through two channels, so any model is **gnosticized as it works**:

- **Pipeline hints** (`subagents.<role>.hint`) — static, per-role *operational*
  guidance (how to build the plan / how to execute), may be domain-flavoured but
  **never names tools**. Mainly to scaffold weaker models.
- **Skills RAG** — dynamic, procedural domain knowledge ("analyzing a program
  requires reading its includes; logic usually lives in include FORM routines")
  retrieved when relevant, plus runtime-accumulated context (e.g. once a
  program's source is read, the include names enter context).

Three variants are described below. **Variant 1 is the default**; **Variants 2
and 3 are optional layers for complex/high-stakes cases** — V2 with an external
reviewer gating sub-task groups, V3 with the planner classifying per-step
complexity and capable steps self-expanding recursively.

---

## Shared cross-cutting changes (apply to both variants)

- **Per-step tool selection, not prompt-level.** Remove the prompt-level planner
  catalog (`selectTools(goal+prompt)`). The planner plans by *intent* (the
  agnostic prompt already says "the executor picks the exact one"); tools are
  selected per step via `selectTools(step.instructions)` — the granularity the
  executor already uses. This fixes the ZDAZ mis-selection at the root.
- **Replan re-selects tools.** Tool relevance is recomputed against the updated
  context, so discover-expand (include names known only after the source read)
  surfaces the right tools on the next round.

---

## Variant 1 — Gnosticizing RAG planner (default)

A single agnostic planner made *effectively gnostic* by feeding it hints + skills
RAG + accumulated context, so it plans completely for the common case without any
extra orchestration machinery.

**Components**
- Agnostic planner (existing adaptive/incremental), unchanged in code.
- Per-role `hint` (existing, PR #177) — operational steering.
- Skills RAG — procedural domain knowledge retrieved for the goal/step and
  injected into the planner's context.
- Per-step tool selection + replan re-selection (shared changes above).

**Flow (ZDAZ example)**
1. Skills RAG / hint gnosticizes the planner: "to analyze a program, read its
   full source *and* its includes; logic lives in include FORM routines."
2. Planner plans `read source` (and, as a pattern, `read the program's includes`).
3. Source is read → its `INCLUDE` names enter the accumulated context.
4. The now-gnosticized planner plans the concrete `read include X/Y/Z` steps.
5. Finalizer composes the grounded analysis.

Discover-expand still happens, but it is driven by a **gnosticized planner**, not
by a weak executor's error.

**Pros:** simplest control flow; engine stays clean; one place to improve
(planning quality via hints/RAG); cost-efficient. **Cons:** completeness rests on
the planner's judgement + the quality/coverage of skills RAG; no hard gate, so a
gap in RAG coverage can still yield an incomplete-but-confident answer.

**When:** the default for the vast majority of tasks.

---

## Variant 2 — Reviewer for complex cases (optional layer)

For tasks where upfront planning cannot guarantee completeness (under-specified,
multi-stage, high-stakes), add a **smart reviewer** that gates progression.

**Components (additive to Variant 1)**
- **Grouped plan.** The plan is a sequence of *groups*, each group solving one
  sub-task (rather than a flat step list).
- **Per-step model routing.** Each step is tagged `cheap` | `capable`; the
  controller routes it to the matching executor endpoint. Mechanical reads →
  cheap; judgement/analysis → capable. (Config grows: an executor *pair* or a
  selectable executor per step.)
- **Reviewer role (capable).** After each group, an injected completeness-check
  step run by a capable model: "given this sub-task and what was gathered, is it
  sufficient? if not, what is missing?" Its domain awareness of *what to check*
  comes from skills RAG (e.g. "were the program's includes read?").
- **Completeness gate.** Progression to the next group only proceeds when the
  reviewer confirms sufficiency. On "insufficient", control returns to the
  planner, which generates additional steps (a new group) for the missing work;
  loop until the reviewer is satisfied.

**Flow (ZDAZ example)**
`[read report]`(cheap) → `[verify: enough to analyze?]`(capable) → "need the
includes" → planner generates `[read include×N]`(cheap) → `[verify: all present?]`
(capable) → OK → `[analyze]`(capable) → finalize.

Intelligence is spent **sparingly** — at group boundaries (verification) and on
judgement steps — not on every step.

**Pros:** robust against silent under-delivery even with a weak executor; loud,
explicit completeness; cost-controlled placement of the capable model. **Cons:**
more LLM round-trips and latency; more complex control flow and config; only
worth it when correctness/completeness matters more than simplicity.

**When:** complex, exploratory, or high-stakes tasks; opt-in per pipeline (e.g. a
config flag enabling the reviewer + routing).

---

## Variant 3 — Planner-assessed per-step complexity + self-expanding smart steps

Like Variant 2 it routes per step, but it **folds completeness into the step's
executor** instead of a separate reviewer role. At plan time the planner
classifies each step by complexity, where the operative criterion is: *does this
step require the model to self-assess the completeness of its own execution
(and possibly expand into a recursive sub-plan)?*

**Components**
- **Planner-assessed step complexity.** For each step the planner emits a
  routing tag, e.g. `Step.tier: cheap | capable`. The decision rule is not raw
  difficulty but completeness-self-assessment: a step that might need to expand
  into a recursive sub-plan (e.g. "analyze a program" → discover it needs the
  includes) is `capable`; a deterministic single-shot fetch is `cheap`.
- **Per-step model routing** (as in Variant 2): the controller runs each step on
  the matching executor endpoint.
- **Recursive self-expansion on capable steps.** A `capable` step's executor may,
  instead of returning a final step result, emit a **sub-plan** — the step
  recurses into its own ordered steps (themselves classified/routed). The smart
  model self-judges "am I done, or do I need more?" inline; there is no external
  reviewer. A `cheap` step never recurses — it just executes and returns.

**Flow (ZDAZ example)**
1. Planner plans `analyze program ZDAZ_...` and tags it `capable` (it foresees the
   step may need recursive expansion).
2. The capable executor reads the source, self-assesses "the logic is in includes
   I haven't read" → emits a sub-plan: `read include X/Y/Z` (each `cheap`).
3. Sub-steps run on the cheap model; their results return up to the capable step.
4. The capable step self-confirms completeness and returns the grounded analysis.

**Pros:** intelligence is spent only on the steps that actually need it (no extra
reviewer round per group); completeness lives with the model doing the work, so
no hand-off; naturally recursive for arbitrarily deep expansion. **Cons:** the
**planner's complexity classification is the linchpin** — if a step that needs
self-assessment is mis-tagged `cheap`, the cheap model confabulates (the original
failure mode returns); recursive execution is more complex to implement and
bound (depth/budget limits needed).

**When:** mixed-cost deployments that want fine-grained spend without a separate
reviewer; tasks whose hard parts are localised to a few steps rather than whole
sub-task groups.

---

## How the variants relate

All three share the same agnostic engine, the per-step tool-selection fix, and
the hints + skills-RAG gnosticization. **Variant 1 is the base** (gnosticized
planner, no extra orchestration). Variants 2 and 3 both add per-step model
routing for completeness on harder tasks, differing in *where* completeness
lives:

- **Variant 2** — an **external reviewer** gates whole sub-task *groups* (explicit,
  loud, hand-off; intelligence at group boundaries).
- **Variant 3** — completeness is **internal** to the capable step's executor,
  which self-assesses and **recursively sub-plans** (no separate role;
  intelligence only on planner-flagged complex steps).

Both 2 and 3 depend on a correct capability decision: V2 on the planner's
grouping + the reviewer firing, V3 on the planner's per-step complexity
classification. V1's gnosticization (hints + skills RAG) *improves the inputs to
both* — it makes the planner classify/group better and tells the reviewer/smart
step *what* completeness means for the domain. A deployment can run pure V1, or
layer V2 **or** V3 on top where robustness is worth the cost.

## Open questions / next experiments

- Re-run the ZDAZ case with read tools (GetProgram/GetInclude) actually surfaced,
  to confirm clean include-discovery under Variant 1's per-step selection.
- Why did toolsRag rank run/write tools over read tools for "analyze program"? →
  tool-description/ranking issue, fixed in MCP descriptions (engine stays
  agnostic), not in the controller.
- Variant 2: exact config shape for per-step model routing (executor pair vs a
  selectable list) and the reviewer endpoint.
- Variant 3: how reliably the planner can classify per-step complexity (the
  linchpin), and how to bound recursive self-expansion (max depth / token budget
  per recursion level) so a mis-tagged or runaway step cannot loop.
- Whether V2's external reviewer and V3's internal self-assessment can be mixed
  (e.g. self-expanding steps within reviewer-gated groups).
- Whether a light completeness check belongs in Variant 1 too (cheap heuristic
  vs full reviewer).

## Out of scope

WRITE concerns (results-context, create-idempotency, eventual-consistency) are
deferred and not addressed here.
