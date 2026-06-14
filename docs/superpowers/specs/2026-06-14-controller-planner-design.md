# Controller Planner — Design (Capability-Tuned Planners, Step-State Digest Board, Deferred Fan-Out)

**Date:** 2026-06-14
**Status:** DRAFT — for user review
**Scope:** the controller pipeline's planner/executor/reviewer interplay — design AND testing in one spec. Clean break of the `incremental | adaptive` planner enum.

> Consolidates and supersedes `2026-06-09-controller-planner-gnosticization-design.md`
> (now removed). Its Variant 1 (skills-RAG gnosticization) and its shared "per-step
> tool selection" change are already implemented; its Variants 2/3 (reviewer-gated
> completeness and self-expanding capable steps) are resolved here into the
> smart/weak capability split.

## Problem

Two independent evidence sources converge on the same defects.

**Live plan-generation capture** (real `claude-4.6-sonnet`, no execution, WITH/WITHOUT skills):

1. **The planner does not see step RESULTS, so it loops or bloats.** Its "Progress"
   is a payload-free blob of `[seq N name ok]` records, while `PLANNER_SYSTEM`
   tells it "fetched results appear under Progress." They never do (the full
   result goes to RAG; only a control marker is in `plannerPrivate`). Empirically:
   `abap-review` and `read-includes` re-emit the SAME fetch step 12×
   (`exceeded MAX_STEPS`).
2. **Plan-once cannot fan out over an unknown-until-fetched set.** For
   `read-includes` the plan-once planner either **hallucinated** names/counts
   (`…_TOP/_SEL/_F01`, fixed "Read include 1..6") or **collapsed** to one coarse
   step (`find-usages` → single where-used). Neither is real data-dependent
   expansion.

**Earlier E19 experiments** (from the consolidated 2026-06-09 spec) showed the same
under a weak executor: gpt-4o-mini **confabulated** a program's include structure
without ever fetching it (1 planner call, 0 replan, 0 error — confident but
ungrounded), while sonnet detected the gap but flailed ~207k tokens against the
wrong toolset. **Weak models do not recognise a missing prerequisite, so a
reactive replan trigger never trips** — discovery cannot rest on executor
intelligence.

3. **Executor capability is not accounted for.** A coarse "do it all" step suits a
   strong executor but a weak one confabulates / under-delivers; a fine,
   planner-driven decomposition suits a weak executor but wastes a strong one. The
   current design has no notion of which it builds for.

## Core Axiom

**Execution ≠ control. The executor, by definition, cannot judge how it
performed.** Control — verifying a step did what it should, deciding what happens
next — lives in the **planner + reviewer**, never in the executor. The two
planner implementations below differ only in *how much* structure they impose to
retain that control given the executor's capability; control itself is never
delegated to the doer.

## Guiding principle (engine stays agnostic)

Role prompts say "the live target system", never "SAP"/"ABAP", and never name
tools. Domain knowledge enters at runtime through two channels, so any model is
gnosticized as it works:
- **Pipeline hints** (`subagents.<role>.hint`) — static, per-role *operational*
  steering (never names tools); mainly to scaffold weaker models. (Implemented.)
- **Skills RAG** — dynamic procedural domain knowledge retrieved for the
  goal/step. (Implemented — the skill plugin-host; the former "Variant 1".)

## Architecture

### A. Two result representations, two consumers

| Representation | Where it lives | Who consumes it |
|---|---|---|
| **Full result** | run-scoped **RAG, addressable by step (`runId`+`seq`)** — existing `step-result` artifacts | the **executor** (a later step recalls a prior step's full output by seq) |
| **Digest** (the planning-relevant slice) | the **planner's step-state board** | the **planner** — strictly digest-only, never reads the full RAG |

The **reviewer** writes BOTH on each settle: full `approved` → RAG (as today); a
purpose-built **digest** → the board. The reviewer **decides what from the result
is needed for planning** — a targeted extract (e.g. *the list of include names*),
not a generic summary.

### B. Planner context = a step-state digest board

Replace the payload-free `[seq N name ok]` blob (and the misleading "fetched
results appear under Progress" clause) with a structured board: per step the
planner sees **intent + state + digest**. Because the board carries state, the
planner (i) never re-issues a `done` step (fixes loop + bloat), and (ii) fans out
from a discovery step's digest (the digest of a discovery step IS the enumerable
list).

### C. Two capability-tuned planner implementations (clean break)

Retire `IncrementalPlanner`/`AdaptivePlanner` and the `planner: 'incremental' |
'adaptive'` enum. Introduce two implementations, **each with its own system
prompt**, selected **by the pipeline composition code** (the factory that
assembles the controller wires the planner matching the executor component it
pairs with) — NOT a user YAML toggle, NOT autodetection. The end user influences
it only by choosing a pipeline preset.

- **Smart-executor planner** — coarse / free steps; delegates in-step fan-out to
  the executor (one step "read all includes"; the executor lists then reads each
  in its tool-loop). This is the resolution of 2026-06-09 **Variant 3's** insight
  that a capable executor can self-expand — but control still returns to the
  reviewer after the coarse step.
- **Weak-executor planner** — fine-grained steps + **deferred expansion**
  (section D); never trusts the executor with multi-action steps. This is the
  resolution of 2026-06-09 **Variant 2** (planner-driven completeness, reviewer in
  the loop) without per-group machinery.

An optional **combined planner+reviewer** implementation is allowed: with no
separate reviewer, the planner produces its own digest from the full-result-in-RAG.

### D. Deferred expansion (weak-executor planner)

The operative criterion (sharpened from 2026-06-09 V3): **is the step's
decomposition knowable at plan time?** "Analyze the program" is decomposable
up front (read source → analyze). "Read every include" is **not** — the include
names live *inside* the source and are known only after it is read. The weak
planner handles the non-decomposable case with **explicit discovery marker +
expand-on-success**:

1. The weak planner marks a step as **discovery** (its result enumerates the
   remaining work) and leaves the remainder unplanned.
2. When that step settles **`done`**, the controller **re-invokes the planner** in
   an *expand-remainder* mode (a new trigger alongside `REPLAN` /
   `EXTERNAL_RESULT_REPLAN`).
3. The planner reads the discovery step's **digest** (= the enumerated list) and
   **fans out one concrete step per element**.
4. The discovery step is marked **`expanded`** so its fan-out is never generated
   twice.

The full discovery result stays in RAG for the executor; the planner sees only
the digest list. The smart-executor planner does NOT use this — it emits the
coarse step and lets the executor iterate.

### E. Step-state machine (the board's vocabulary)

A step's board state is a **projection** of the controller lifecycle + the
reviewer's `Outcome.status` — NOT the raw `Outcome.status` (the planner does not
need `ok` vs `exists`; both mean "done"):

```
planned ──start──► executing ──reviewer verdict──►  done      (Outcome ok | exists)   + digest: key extract
                                                     partial   (Outcome partial)        + digest: remainder
                                                     failed    (Outcome failed)         + digest: note
executing ──suspend──► awaiting-external | awaiting-clarify ──resume──► executing
done(discovery) ──weak planner fans out──► expanded
```

State set (locked): `planned | executing | done | partial | failed |
awaiting-external | awaiting-clarify | expanded`. Grounding: `Outcome.status`
(`ok|exists|failed|partial`, reviewer-only, `outcome.ts`) projects to
`done|partial|failed`; `InFlightStep.phase` (`executing|awaiting-replan`) and the
suspend kinds (`external-tool|clarify`) already exist and are merely surfaced. The
two genuinely NEW states are **`planned`** (the cursor is currently implicit) and
**`expanded`** (discovery fan-out already emitted). Decisions locked: (1) state is
a projection; (2) `expanded` is a distinct gating state, not a side flag; (3)
`awaiting-*` ARE shown to the planner (a blocked step is neither done nor todo).

## Data flow

```
planner (digest board) ──emits step──► controller ──dispatches──► executor
                                                                      │ recalls prior FULL results from run-scoped RAG by seq as needed
                                                                      ▼
reviewer ──verdict (Outcome)──┬─► FULL approved content ─► run-scoped RAG (step-result by seq)   [executor consumes]
                              └─► planning DIGEST ───────► planner board (state + digest)          [planner consumes]
weak planner: discovery done ──► controller re-invokes planner (expand-remainder)
                                  reads discovery digest (list) ──► fans out N steps ──► mark `expanded`
```

## Components & boundaries

- **`outcome.ts` / reviewer** — gains a `digest` field (planning-relevant extract)
  alongside `approved`/`remainder`/`note`.
- **Step-state board** — a structured projection over the run's step artifacts +
  in-flight state, rendered into the planner prompt (replaces the payload-free
  `plannerPrivate` blob).
- **Two planner implementations** + the **expand-remainder** trigger; the
  composition factory selects the implementation.
- **`Step`** — gains a discovery marker (e.g. `discovery?: true`); the board
  carries per-step `state` + `digest`.
- **Reused / already implemented (do NOT re-spec):** per-step tool selection
  (`selectTools(step.instructions)` in `runStep`; the old prompt-level
  `selectTools(goal+prompt)` is gone — the 2026-06-09 shared change, DONE); skills
  RAG; `subagents.<role>.hint`; run-scoped RAG; fenced catalog CAS; suspend/resume;
  the `requires` evidence map.

## Error handling

- `failed` / `partial` → existing replan paths, now fed the board digest instead
  of the payload-free blob.
- Expansion is idempotent: a step already `expanded` is never re-expanded (safe on
  crash-replay).
- A discovery step that settles `failed`/`partial` → normal replan, NOT expansion
  (expansion only on `done`).
- Combined planner+reviewer variant: if no digest can be produced, fall back to
  reading the full result from RAG once (documented exception to digest-only).

## Testing strategy

Primary signal is **plan GENERATION**, not execution (agreed scope: "знімаємо
генерацію планів, виконувати необовʼязково"). Extend the build-excluded
`plan-analysis.ts` dev harness:

- Add an `EVAL_PLANS_ONLY` capture mode + data-dependent fan-out prompts
  (`read-includes`, `find-usages`) + full incremental/weak-planner trajectories.
- Capture, per prompt × planner, the **generated plan** (full, instructions +
  per-step state) and the **deferred-expansion trajectory** (discovery step + the
  fanned-out steps after feeding a synthetic discovery digest), WITH/WITHOUT
  skills.
- Assert STRUCTURE, never retrieval quality: no repeated identical step (the loop
  regression we observed), discovery step present for fan-out prompts under the
  weak planner, fan-out count == digest list length, `expanded` set exactly once.
- Reviewer-digest unit tests: a discovery result yields a digest containing the
  enumerable list; a normal result yields a compact extract.

(The exploratory capture used during design lives in `/tmp` logs; the harness
extension above is the durable, plan-defined version.)

## Open / deferred

- **Digest format** (free text vs structured list) — start free-text; structure
  only if fan-out parsing needs it.
- **Per-step model routing** (`Step.tier: cheap | capable`, routing each step to a
  matching executor endpoint — 2026-06-09 Variants 2/3) — the deeper future layer;
  deferred. Capability is global-per-composition for now (YAGNI). A mis-tagged
  cheap step reintroducing the confabulation failure mode is the known risk that
  makes this worth doing carefully later.
- Live WITH-vs-WITHOUT *quality* measurement on real sap-skills + real embedder —
  separate effort, needs the user's env.

## Rejected

- Tuning the product `PLANNER_SYSTEM` wording to make a test pass (tuning a
  product prompt to a harness is wrong; the harness infidelity — payload-free
  Progress — is the real issue, fixed by the digest board).
