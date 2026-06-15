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

**Selection contract (concrete).** Replace `PlannerKind = 'incremental' |
'adaptive'` with `PlannerKind = 'smart-executor' | 'weak-executor'`, and replace
`makePlanner(kind, …)` with `makeControllerPlanner(kind: PlannerKind, deps):
IControllerPlanner`. The **composition code** chooses `kind` — there is no
user-facing `planner:` YAML field and no autodetection. Concretely:

- Capability is a property of the **executor component the preset wires**, encoded
  in the **preset builder code** (the factory that assembles that controller), NOT
  a user YAML knob. A preset that wires a small/weak executor model passes
  `kind: 'weak-executor'`; one that wires a capable model passes
  `'smart-executor'`.
- Named pipeline presets in the registry (`pipeline: { name }`): `controller`
  (default → `smart-executor`) and `controller-weak` (→ `weak-executor`). The end
  user selects a preset; the preset's builder is the single source of truth for
  the planner↔executor pairing.
- A consumer composing its own pipeline in code calls `makeControllerPlanner`
  directly with the `kind` matching the executor it pairs — same rule, no config
  surface.

**Pairing guarantee — two honest levels (no false "verified capability").** Nothing
can inspect a model and prove it is "smart"; a self-declared capability is an
operator ASSERTION, not a verified fact. The spec is honest about this:

- **Strong guarantee — preset-pinned executor.** A preset MAY own (pin) its
  executor model/endpoint, so the user cannot override it within that preset.
  Here the pairing is genuinely guaranteed (the preset chose both planner and
  executor). This is the recommended shape for the shipped presets.
- **Weak guarantee — `declaredCapability` validation.** When a preset allows the
  user to supply `subagents.executor`, that config carries a
  `declaredCapability: 'smart' | 'weak'` field (honestly named — an assertion).
  The factory asserts it matches the preset's expectation and **fails loud on a
  declared mismatch** (catches the obvious `controller-weak` + declared-smart
  footgun). **Residual risk, documented:** the factory cannot detect a *mis*-declared
  model (an operator labelling a weak model `smart`); that is on the operator. It
  is NOT used for selection — the planner is still chosen by the preset/composition
  code, never by this field.

(If a future deployment needs the capability to be data-driven rather than
preset-encoded, that is the deferred per-step `Step.tier` routing below — not a
new top-level toggle.)

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

**Discovery-digest contract (structured, NOT free-text).** "Fan out exactly one
step per element" requires a machine-readable, validated digest — a free-text
summary cannot guarantee the 1:1 mapping. A discovery step's digest is therefore:

```
DiscoveryDigest = {
  items: { id: string; label: string }[];   // id stable+unique within the step; label = human/intent text
  truncated: boolean;                        // true if the list was capped at maxFanOut
  continuation?: Continuation;               // discriminated union (below), REQUIRED when truncated=true
}
```

**Empty is a VALID completion, not a failure.** `items: []` with `truncated: false`
means the discovery legitimately found nothing (e.g. a program with zero includes)
→ the discovery step is marked `expanded` with **zero fan-out steps**, and the run
proceeds. This is distinct from a MALFORMED outcome where the reviewer could not
produce a valid `DiscoveryDigest` at all (no `items` field / parse failure) — THAT
is the `partial`/`failed` → replan case. A 0-item completed discovery must NEVER
loop into replan.

Validation at expand time (only when a well-formed digest is present):
`items.length ≤ maxFanOut` (config, default e.g. 50) and each `label` ≤
`maxItemChars`.

**Continuation is a DISCRIMINATED UNION — its two semantics are incompatible:**

```
Continuation =
  | { kind: 'artifact-offset'; artifactId: string; offset: number }   // controller windows locally — NO executor step
  | { kind: 'tool'; token: string }                                   // needs a follow-up executor/tool step
```

- **`artifact-offset` (preferred, controller-local).** When the executor's
  enumeration is fully captured, the reviewer writes a durable **structured
  enumeration artifact** — `artifactType: 'enumeration'`, payload = the canonical
  `{ id, label }[]` array (NOT arbitrary `approved` text — a stable, indexable
  array). The `continuation` then references THAT artifact by `artifactId` +
  `offset`, and the **controller windows it locally** (`items =
  enumeration[offset : offset+maxFanOut]`) on each expand — **no executor/tool
  re-run**, so the offset is stable across crashes and cannot re-trigger discovery.
- **`tool` (only when the source itself paginates).** If the underlying tool could
  NOT enumerate fully in one result and exposes its own next-page token, that token
  is carried verbatim; the planner must emit a **follow-up discovery executor
  step** to fetch the next page (a real tool round-trip), which itself yields the
  next enumeration artifact / continuation.

The reviewer never FABRICATES a cursor: it either emits the structured enumeration
artifact (→ `artifact-offset`) or passes through a tool-native token (→ `tool`).
`truncated: true` WITHOUT a `continuation` is invalid (→ `partial`/replan). The
planner fans out the current window, then (artifact-offset) advances the offset
locally or (tool) emits the follow-up step, until a digest returns `truncated:
false`. A source that can neither be fully enumerated into an artifact NOR provide
a tool cursor cannot be safely fanned out → the discovery step fails loud (never
silently drops items).

The fanned-out steps are generated 1:1 from `items` (one step per `{id, label}`),
each carrying the source `item.id` in its provenance so re-expansion/crash-replay
is comparable. NON-discovery step digests stay free-text (§B). The full discovery
result stays in RAG for the executor; the planner sees only the structured digest.
The smart-executor planner does NOT use this — it emits the coarse step and lets
the executor iterate.

### E. Step-state machine (the board's vocabulary)

A step's board state is a **projection** of the controller lifecycle + the
reviewer's `Outcome.status` — NOT the raw `Outcome.status` (the planner does not
need `ok` vs `exists`; both mean "done"):

TWO separate axes — a **step-level** state (per board entry) and a **run-level**
status (the whole run) — because some blocking is about one step, some about the
whole goal:

```
STEP-level (per board entry):
planned ──start──► executing ──reviewer verdict──►  done      (Outcome ok | exists)   + digest: key extract
                                                     partial   (Outcome partial)        + digest: remainder
                                                     failed    (Outcome failed)         + digest: note
executing ──tool suspend──► awaiting-external ──resume──► executing      (a SPECIFIC step paused on an external tool)
done(discovery) ──weak planner fans out──► expanded

RUN-level (the run, not a step):
running | awaiting-clarify | awaiting-budget | finalizing | done | failed
```

**Step-state set (locked):** `planned | executing | done | partial | failed |
awaiting-external | expanded`. **Run-status set (locked):** `running |
awaiting-clarify | awaiting-budget | finalizing | done | failed`.

`awaiting-clarify` and budget escalation are **run-level**, not step-level: a
clarification request or a budget-cap pause blocks the whole run (it may arise
from the goal itself, not from any single step), so it does NOT belong on a step
entry. Only `awaiting-external` (a named step suspended on a specific external
tool) is step-level. (If a clarify is genuinely scoped to one step's execution it
still suspends the run at run-level while that step is `executing`; the planner
sees the run-status, not a per-step clarify state.)

Grounding: `Outcome.status` (`ok|exists|failed|partial`, reviewer-only,
`outcome.ts`) projects to step `done|partial|failed`; `InFlightStep.phase`
(`executing|awaiting-replan`) and the external-tool suspend already exist and are
merely surfaced. The genuinely NEW step states are **`planned`** (the cursor is
currently implicit) and **`expanded`** (discovery fan-out already emitted).
Decisions locked: (1) step state is a projection (not raw `Outcome.status`); (2)
`expanded` is a distinct gating state, not a side flag; (3) blocking is split
across the two axes — `awaiting-external` step-level, `awaiting-clarify` /
`awaiting-budget` run-level.

### F. Step identity & durable board persistence

**Canonical identity.** A board entry is keyed by a stable **`stepId`**, NOT by
`seq`. `stepId` is assigned when the step first enters the plan (at create-plan
or at fan-out — for a fanned-out step it is derived deterministically from the
discovery `stepId` + the source `item.id`, so a re-expansion produces the SAME
ids). `seq` is assigned only when the step starts executing (monotonic, run-scoped);
retries/replans of the same step share its `stepId` and produce distinct
`attempt` values under that `seq`. The mapping is therefore:

```
stepId (stable, plan-time)  ──1:1──►  board entry / state
stepId  ──assigned at start──►  seq (monotonic)  ──1:N──►  attempt (retries)
```

**Retry vs replan are DIFFERENT identities.** A **retry** re-runs the SAME intent
→ same `stepId`, new `attempt` under the same `seq`. A **replan** that REPLACES a
failed step with a DIFFERENT intent gets a **NEW `stepId`** carrying
`supersedesStepId` → the superseded id. The board shows them as two distinct
entries: the superseded step stays terminal (`failed`, with its digest), the
replacement is a fresh `planned`/… entry. This prevents one board entry from
conflating two different units of work. (A pure retry never sets
`supersedesStepId`.)

**Outcome resolution = precedence first, `writeOrdinal` only as tie-break.**
Multiple artifacts can exist for one `(stepId, seq)` (retries, crash-replay). They
collapse via the EXISTING `resolveByPrecedence` semantics — `ok|exists > partial >
failed` — and `writeOrdinal` breaks ties ONLY within an equal rank (latest equal-rank
write wins). A plain "latest-write-wins" is explicitly REJECTED: it could let a
later `failed` overwrite a committed `ok`. A board entry's STRUCTURE (its
existence, `stepId`, instructions) comes from the canonical `plan-decision`
artifact that introduced it; its STATE comes from the precedence-resolved
`step-result` outcome. The board is fully RECONSTRUCTIBLE from those two immutable
artifact streams alone — the bundle snapshot is never required.

**Durability rests on IMMUTABLE ARTIFACTS + deterministic merge — NOT bundle CAS.**
Reality check on the persistence layer: `persistBundle()` is an append-only
`KnowledgeBackend.put()`; `hydrateBundle()` takes the LATEST bundle snapshot
(last-write-wins by scan order). There is **no CAS / version fencing** on the
bundle, and `writeOrdinal` only orders/ties artifacts — it does NOT fence the
bundle write. So nothing here claims an atomic fenced bundle update (it does not
exist). The bundle is a **derived, last-write-wins cache**; the **source of truth
for recovery is the immutable, append-only artifacts**, over which the board is
rebuilt by a **deterministic merge** at hydrate.

**EVERY planner decision is an immutable artifact — not just expansion.** The
create-plan, every replan, AND every expand-remainder output is written as a
`plan-decision` artifact BEFORE its effect is reflected in the bundle. (Without
this, the initial plan and replans would live only in the bundle snapshot — a lost
snapshot would make `planned` steps and their `stepId`s unrecoverable, the gap this
closes.) The board is reconstructed by replaying `plan-decision` artifacts (the
plan structure + step ids/instructions) and `step-result` artifacts (the outcomes)
— the bundle adds nothing the artifacts lack.

**`plan-decision` artifact — storage contract:**
- `artifactType: 'plan-decision'`; payload = the decision kind (`create | replan |
  expand`), the produced/affected steps (each with `stepId`, full `instructions`,
  `discovery?`, `supersedesStepId?`, source `item.id` for fan-out), the
  `discoveryStepId` for an expand, and the `continuation` consumed (if any).
- **Stable `decisionId` = content hash** of the canonical decision inputs+output
  (UUIDv5 over `{runId, kind, anchorStepId, plannerOutput}`). This does NOT depend
  on the non-CAS bundle `writeOrdinal` (which two crash/concurrent branches could
  duplicate). Identical inputs+output → identical `decisionId` (natural dedup);
  different LLM outputs → different `decisionId`.
- **Canonical selection (total order, CAS-free):** for a given decision slot
  (e.g. `(runId, discoveryStepId)` for an expand, or `(runId, replan-of-stepId)`
  for a replan), the canonical decision is the one with the **lexicographically
  smallest `decisionId`**, and its content is used **wholesale** — ids AND
  instructions. This resolves the "two LLM calls produced different instructions
  for the same `stepId`" problem: we never merge two decisions; we pick ONE by a
  stable total order and take its steps verbatim. Non-canonical decisions are
  ignored (and may be GC'd).

**Crash recovery (no bundle CAS needed):**
- **A decision artifact for the slot exists** → the merge applies the canonical one
  (NO new LLM call); its steps define the board entries.
- **No decision artifact for the slot** (crash before it was written) → re-CALL the
  planner; the new decision is written and selected canonically. A duplicate that
  arrives later loses the `decisionId` total-order tie and is ignored.
- **Discovery already has a canonical expand decision** → expansion skipped
  (idempotent). `expanded` is thus a **derived predicate**: "a canonical
  `plan-decision{kind:expand}` exists for this `discoveryStepId`," not a
  CAS-protected flag. The merge is the authority; the bundle is an optimization.

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
- **Step-state board** — a structured projection replayed from the `plan-decision`
  artifacts (structure) + `step-result` artifacts (state), rendered into the
  planner prompt (replaces the payload-free `plannerPrivate` blob; the bundle is a
  pure cache of this projection).
- **Two planner implementations** + the **expand-remainder** trigger; the
  composition factory selects the implementation.
- **`Step`** — gains `stepId` (stable), `discovery?: true`, and
  `supersedesStepId?` (replacement-on-replan link); the board carries per-step
  `state` + `digest`. `step-result` artifacts gain `stepId`.
- **`plan-decision` artifact** — a new run-scoped immutable artifact for EVERY
  planner decision (`create | replan | expand`), with a content-hash `decisionId`,
  written before the bundle reflects it; the board is replayed from these +
  `step-result` artifacts (§F). The bundle becomes a pure derived cache.
- **`enumeration` artifact** — a new run-scoped artifact holding a discovery
  step's canonical `{id,label}[]` list, windowed locally by the controller for
  `artifact-offset` continuation (§D).
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
- Reviewer-digest unit tests: a discovery result yields a STRUCTURED digest
  (`items: [{id,label}]`, validated, bounded by `maxFanOut`/`maxItemChars`,
  `truncated` set on overflow); a normal result yields a free-text extract.

Plan-generation alone does NOT cover the real production risk — **settle /
recovery / retries and the crash window between expansion and persist**. Add
handler-level tests (the existing controller-handler test seam, with the
in-memory bundle store + a fake reviewer/executor):

- **Crash-injection around expansion.** Inject a crash (a) after the planner LLM
  returns but BEFORE the decision artifact is written (→ replay re-CALLs; assert no
  duplication via deterministic `stepId`s), (b) after the decision artifact is
  written but before the bundle snapshot reflects it (→ the hydrate-time merge
  re-APPLIES the persisted decision, NO second LLM call), and (c) after the
  snapshot reflects it (→ `expanded` predicate skips).
  In all three, on replay assert the fan-out is **neither duplicated nor lost** —
  an identical board and a single set of fan-out steps.
- **Retry identity + precedence resolution.** A step that fails then retries to
  `ok` keeps one `stepId` with incrementing `attempt` under one `seq`;
  `resolveByPrecedence` collapses to the `ok` (precedence `ok|exists > partial >
  failed`, NOT latest-write) — assert a later `failed` artifact does NOT overwrite
  an earlier committed `ok`; `writeOrdinal` only tie-breaks equal rank. A
  replan-replacement gets a NEW `stepId` + `supersedesStepId` and shows as a
  separate board entry.
- **Expansion-only-on-done.** A discovery step that settles `partial`/`failed`
  triggers replan, NOT expansion; `expanded` is never set.
- **Idempotent re-expand.** Re-invoking expand on an already-`expanded` discovery
  step is a no-op.

(The exploratory plan-generation capture used during design lives in `/tmp` logs;
the harness extension + handler crash tests above are the durable, plan-defined
verification.)

## Open / deferred

- **Digest format** — RESOLVED, not deferred: discovery digests are STRUCTURED
  (`items: [{id,label}]`, validated, bounded — §D); non-discovery digests are
  free-text. (The earlier "start free-text everywhere" idea is dropped — free-text
  cannot guarantee the 1:1 fan-out.)
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
