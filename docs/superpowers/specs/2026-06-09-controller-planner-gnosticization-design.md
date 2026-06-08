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

Two complementary variants are described below. **Variant 1 is the default**;
**Variant 2 is an optional layer for complex/high-stakes cases.**

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

## How the two relate

Both share the same agnostic engine, the per-step tool-selection fix, and the
hints + skills-RAG gnosticization. Variant 1 is the base. Variant 2 adds a
reviewer gate + grouping + per-step routing *on top*, enabled only where the
extra robustness is worth the cost. A deployment can run pure Variant 1, or
enable the Variant 2 reviewer for the hard cases.

## Open questions / next experiments

- Re-run the ZDAZ case with read tools (GetProgram/GetInclude) actually surfaced,
  to confirm clean include-discovery under Variant 1's per-step selection.
- Why did toolsRag rank run/write tools over read tools for "analyze program"? →
  tool-description/ranking issue, fixed in MCP descriptions (engine stays
  agnostic), not in the controller.
- Variant 2: exact config shape for per-step model routing (executor pair vs a
  selectable list) and the reviewer endpoint.
- Whether a light completeness check belongs in Variant 1 too (cheap heuristic
  vs full reviewer).

## Out of scope

WRITE concerns (results-context, create-idempotency, eventual-consistency) are
deferred and not addressed here.
