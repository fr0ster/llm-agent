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

The **reviewer stays a pure judging role: it RETURNS data, it does not persist.**
On each settle the reviewer returns its verdict plus a purpose-built **digest**
(and, for a discovery step, the structured `{id,label}[]` enumeration) — it
**decides what from the result is needed for planning** (a targeted extract, e.g.
*the list of include names*, not a generic summary). The **controller** then does
the durable writes and assigns ids: full `approved` → run-scoped RAG (as today),
digest → the board, and — for discovery — the `enumeration` artifact + the
`plan-decision` artifacts (§D, §F). This preserves the existing reviewer/controller
boundary (reviewer judges; controller persists).

### B. Planner context = a step-state digest board

The heart of the design, in plain terms: **the digests of executed steps
accumulate into ONE context block that is appended to the planner LLM's request.**
So the planner sees, for every step, what was needed, what was done, the result of
doing it, and what helped or not — and (when skills are attached) how such things
are generally done. Concretely: replace the payload-free `[seq N name ok]` blob
(and the misleading "fetched results appear under Progress" clause) with a
structured board — per step **intent + state + digest** — rendered into the
planner prompt. Because the board carries state + digests, the planner (i) never
re-issues a `done` step (fixes the loop + bloat), and (ii) for a discovery step,
fans out — though it does so over a **bounded window the controller hands it from
the durable enumeration** (§D), not by reading the board digest itself (the board
digest of a discovery step is informational; the authoritative list is the
durable `enumeration` artifact).

**Board budget (REQUIRED — the board is bounded, with a deterministic compaction
policy and a GUARANTEED cap).**
- **`maxDigestChars` applies ONLY to non-discovery free-text digests** — the
  reviewer truncates those to it (full result is in RAG regardless). A **structured
  discovery digest is NEVER char-truncated** (that would corrupt the JSON / drop
  `continuation` and break 1:1 fan-out); it is bounded STRUCTURALLY by `maxFanOut`,
  `maxItemChars`, and a valid `continuation` (§D).
- **`maxBoardChars`** (whole board): on overflow a DETERMINISTIC compaction runs
  (same board ⇒ same output):
  1. **Actionable (protected) steps** are kept in full: every NOT-terminal step
     (`planned`/`executing`/`awaiting-external`/`expanding`) AND every discovery
     step that is `done` but **not yet `fully-expanded`** (its enumerable digest is
     still needed for the next expand window — see below).
  2. The most recent `K` other-terminal digests are kept in full.
  3. Older terminal digests compact oldest-first (by `seq`) to `[seq N name
     status]`; then those summaries drop oldest-first to a `"… M earlier steps
     omitted"` marker (full results stay in RAG, recallable by seq).
- **Actionable entries are NEVER aggregated.** A `"P planned, X executing"` count
  would erase the `stepId`/intent/individual state of unfinished steps — the
  planner would lose track of what is already planned and could re-create the same
  steps. So actionable (not-terminal) entries are ALWAYS rendered individually:
  `stepId` + state ALWAYS in full, and the intent rendered bounded to
  **`maxIntentChars`** (terse but present — never dropped). Only TERMINAL digests
  are compacted (rules 2–3).
- **The cap is GUARANTEED by BOUNDING both COUNT and PER-ENTRY size, then
  fail-loud:**
  - Count of simultaneously-actionable steps is bounded by `maxActiveSteps`
    (fan-out is ≤ `maxFanOut` per window, one window at a time via the §D capacity
    gate); per-entry size is bounded by `maxIntentChars` (+ fixed `stepId`/state).
    So the actionable set's worst-case rendered size = `maxActiveSteps ×
    (stepIdLen + stateLen + maxIntentChars)` — a finite, known bound.
  - **Config invariant validated at load (fail-loud):** that worst-case actionable
    size + `K × maxDigestChars` + headroom ≤ `maxBoardChars`. (Without
    `maxIntentChars` the actionable size would be unbounded and no invariant could
    hold — hence it is REQUIRED.)
  - If, despite the invariant, the board would STILL exceed `maxBoardChars`, the
    controller does NOT feed the planner a lossy board — it **fails loud / suspends
    BEFORE the planner call** (surfaced, never silently degraded).
- **Compaction never endangers expansion (both continuation kinds).** Expansion
  does not depend on the board digest at all: the CONTROLLER owns the durable
  continuation (`artifact-offset` → the `enumeration` artifact; `tool` → the token
  in a durable record, §D), windows it, and passes the bounded window to the
  planner. So neither an `enumeration` offset nor a `tool` token can be lost to
  board compaction.

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
3. **Two DISTINCT transitions — do not conflate them:**
   - **Within-page fan-out (`artifact-offset`).** The CONTROLLER reads the page's
     durable `enumeration` artifact, forms a **bounded window** (≤ `maxFanOut`
     items) and passes THAT window of `items` to the planner, which fans out one
     concrete step per element. The planner never reads the artifact or board
     digest — it is handed items. A token is NEVER passed to the planner.
   - **Next-page pagination (`tool` token).** A token is NOT a window and CANNOT be
     fanned out. When a page is exhausted AND it carried a next-page token, the
     CONTROLLER schedules a **follow-up discovery EXECUTOR step** (a real tool
     round-trip carrying the token) that produces the NEXT page's `enumeration`
     artifact. This is an executor transition, not a planner fan-out.
4. **Capacity gate — sized to AVAILABLE capacity (cannot deadlock).** The window
   is NOT a fixed `maxFanOut` stride. The controller emits the next window with
   `windowSize = min(maxFanOut, maxActiveSteps − activeCount, itemsRemaining)`, and
   only when `windowSize ≥ 1`; it records the ACTUAL emitted length so the next
   offset = `prevOffset + actualWindowLen` (NOT `+ maxFanOut`). A config invariant
   **`maxActiveSteps ≥ maxFanOut`** is validated at load (fail-loud), so at
   `activeCount = 0` a full window always fits — the gate can never block forever.
   Windows are NOT all emitted up front (so actionable steps never pile up past
   `maxActiveSteps`); each is recorded as a `plan-decision{kind:expand, offset,
   len}` (never generated twice, keyed by `(discoveryStepId, offset)`). A discovery
   **page** is fully windowed when the emitted windows cover its enumeration to the
   end; the **chain** is `fully-expanded` per the chain rule below. (Identity &
   durability of per-window decisions and follow-up page steps: §F.)

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
  | { kind: 'tool'; tokenRef: string }                                // CONTROLLER schedules a follow-up page executor step (no planner call); raw token in durable execution state, NOT here
```

- **`artifact-offset` (preferred, controller-local).** When the executor's
  enumeration is fully captured, the reviewer RETURNS the canonical `{ id, label }[]`
  array and the **controller** persists it as a durable **structured enumeration
  artifact** (`artifactType: 'enumeration'`, NOT arbitrary `approved` text — a
  stable, indexable array). **Identity & recovery:** the enumeration's `artifactId`
  is DETERMINISTIC, bound to the canonical discovery attempt —
  `enumerationId = uuidv5(runId, discoveryStepId, seq, attempt)`. A crash/re-review
  can append a second enumeration under a different `attempt` with a different list;
  the canonical one is the attempt selected by the discovery step's
  precedence-resolved + claim-fixed outcome (§F) — exactly ONE list is authoritative.
  Every `continuation` and every expand `plan-decision` references that
  `enumerationId`, so all windows index the SAME immutable list (offsets can never
  point at divergent sources). The controller windows it locally (`items =
  enumeration[offset : offset+maxFanOut]`) on each expand — **no executor/tool
  re-run**, so the offset is stable across crashes and cannot re-trigger discovery.
  **Durable write order (fixed): `enumeration` artifact FIRST, then the
  `step-result` that references its `enumerationId`.** A crash between the two
  leaves only a harmless orphan enumeration (no `step-result` -> the discovery step
  is not `done` -> re-review re-produces it idempotently via the deterministic
  `enumerationId`). The reverse order is FORBIDDEN — it would commit a `step-result`
  whose canonical digest dangles at a missing enumeration.
- **`tool` (only when the source itself paginates).** If the underlying tool could
  NOT enumerate fully in one result and exposes its own next-page token, the RAW
  token is stored in **durable EXECUTION state** (a continuation record in the
  bundle/run-state), NOT in any board/plan artifact. The board-side `continuation`
  carries only an opaque **`tokenRef`** (a stable handle) and the artifacts/board
  reference it by ref or by `tokenHash` — so the raw token is **NEVER rendered into
  the planner board, an `intent`, or logs** (redaction policy: the token is
  execution-secret-class; only the controller dereferences it to make the tool
  call). The controller then schedules a **follow-up discovery executor step**
  (no planner call) carrying the dereferenced token to fetch the next page.

  **The follow-up page step has a durable, deterministic identity** (controller-
  authored, but the board reconstructs only from artifacts): the controller writes
  a **`plan-decision{kind:'page', discoveryChainId, pageIndex, tokenRef}`** BEFORE
  dispatch — NO raw token in it — with:
  - deterministic **`stepId = uuidv5(discoveryChainId, pageIndex)`**, and
  - deterministic **`decisionId = uuidv5(runId, 'page', discoveryChainId,
    pageIndex, tokenHash)`** (the general `decisionId` formula's `anchorStepId /
    continuation / plannerOutput` do not apply to a controller-authored page; this
    is its dedicated identity). Canonical selection/dedup is the SAME as other
    decisions (smallest `decisionId` for the slot) — a stepId match ALONE is not
    enough to dedup append-only artifacts, so the `decisionId` is what collapses
    duplicate page schedulings. Crash-replay: if the page-decision exists it is
    replayed deterministically; if not, re-derivation produces the identical
    `decisionId`/`stepId` and dedups — a page is never lost or duplicated.

**Tool-pagination is a CHAIN with its own identity + completion rule.** A
tool-paginated source produces a CHAIN of discovery steps (page 0, page 1, …),
each its own discovery step with its own `enumeration` artifact, all sharing a
stable **`discoveryChainId`** (the first page's `discoveryStepId`) and carrying a
`pageIndex`. Each page is **page-complete** when its own enumeration is fully
windowed (offset reached its end). The CHAIN is **`fully-expanded`** when (a) the
**terminal page** — the one whose digest has NO next-page token — has been reached,
AND (b) every page in the chain is page-complete. So the `fully-expanded` predicate
ranges over `discoveryChainId` (all pages), NOT a single `discoveryStepId`: a page
that still has a next-page token is never the end, and the initial page is not
"forever truncated" — it is just page 0 of a chain that completes at its terminal
page. (A single-page discovery is the degenerate chain of length 1: no token ⇒ its
page-complete IS chain-`fully-expanded`.)

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

DISCOVERY step only (sub-states of done — windowed fan-out):
done(discovery) ──first window emitted──► expanding ──chain fully-expanded (terminal page reached + all pages page-complete)──► expanded

RUN-level (the run, not a step):
running | awaiting-clarify | awaiting-budget | finalizing | done | failed
```

**Step-state set (locked):** `planned | executing | done | partial | failed |
awaiting-external | expanding | expanded`. **Run-status set (locked):** `running |
awaiting-clarify | awaiting-budget | finalizing | done | failed`.

**Windowed-expansion state model (locked).** A discovery step that settles `done`
enters `expanding`; the CHAIN reaches `expanded` only when it is `fully-expanded`
per §D (terminal page reached AND every page page-complete). These are **derived
predicates** over the present expand decisions + page steps of the
`discoveryChainId`, NOT stored flags:
- a page is **page-complete** ⇔ `expand{offset}` decisions cover its enumeration to
  the end (no further within-page offset remains).
- `expanding` (chain) ⇔ some page is not yet page-complete, OR the terminal page
  has not been reached (a next-page token is outstanding).
- `expanded` (chain, fully) ⇔ terminal page reached AND all pages page-complete.
- **Next within-page offset** = `prevOffset + prevWindow.len` (the ACTUAL recorded
  length, since windows are sized to available capacity — §D), while offset < page
  enumeration length, emitted under the §D capacity gate (idempotent — keyed by
  `(discoveryStepId, offset)`). When a page is page-complete AND it carried a
  next-page token, the controller instead schedules the follow-up discovery
  EXECUTOR step for the next page (§D), not another window.
Each `(discoveryStepId, offset)` window decision is emitted exactly once; the chain
transitions `done → expanding → expanded` monotonically (no "expanded set exactly
once" flag).

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
currently implicit) and the discovery sub-states **`expanding`/`expanded`** (the
windowed fan-out). Decisions locked: (1) step state is a projection (not raw
`Outcome.status`); (2) `expanding`/`expanded` are derived predicates over the
expand decisions (windowed completion, above), not stored flags; (3) blocking is
split across the two axes — `awaiting-external` step-level, `awaiting-clarify` /
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

**Outcome resolution is ATTEMPT-SCOPED — pick the current attempt first, THEN
resolve.** Multiple artifacts can exist for one `(stepId, seq)` across retries
(`attempt 0, 1, …`). A naive "any `step-result` outbeats any transient" is WRONG:
after `attempt 0 = failed`, once `attempt 1` has a claim/in-flight but no result
yet, the board must show `executing` (the live retry), not the stale `failed`. So:

1. **Current attempt** = the MAX `attempt` seen across all records (claims,
   in-flight, step-results) for `(stepId, seq)`.
2. **If the current attempt is unsettled** (a `step-start` claim / in-flight exists
   for it but no `step-result` for that attempt) → state = its TRANSIENT state
   (`executing`, or `awaiting-external` if its `pending` is external) — this
   overrides any OLDER attempt's terminal outcome.
3. **If the current attempt is settled** → state = `resolveByPrecedence` over the
   SETTLED attempts' outcomes (`ok|exists > partial > failed`; `writeOrdinal`
   tie-breaks equal rank). A plain "latest-write-wins" is REJECTED (a late `failed`
   must not overwrite a committed `ok`).

So `failed(attempt 0) → executing(attempt 1) → done(attempt 1)` renders correctly:
the new attempt's transient supersedes the old terminal, and precedence applies
only once no newer attempt is live. A board entry's STRUCTURE (existence, `stepId`,
instructions) still comes from the canonical `plan-decision`; its STATE from this
attempt-scoped resolution. Board reconstruction merges **THREE sources**:

1. **Structure** ← `plan-decision` artifacts (`stepId`, instructions, `slotId`).
2. **Terminal state** ← `step-result` artifacts (per-attempt; precedence-resolved
   among settled attempts) + digest.
3. **Transient state** ← `step-start` claim + the bundle's in-flight/`pending`
   (current-attempt `executing` / `awaiting-external`).

Per the attempt-scoped rule above: the STRUCTURE
and TERMINAL states are reconstructible from immutable artifacts alone; the
TRANSIENT states (`executing` / `awaiting-external`) additionally need the
`step-start` claim + the bundle's `pending` (run-execution state, which lives in
the bundle — below). A lost bundle thus loses only transient in-flight precision,
recovered by re-deriving from the claim (re-`executing`) — never a committed
outcome.

**What is artifact-backed vs what stays in the bundle.** Reality check:
`persistBundle()` is an append-only `KnowledgeBackend.put()`; `hydrateBundle()`
takes the LATEST snapshot (last-write-wins); there is **no CAS** and `writeOrdinal`
only orders artifacts. So we do NOT claim an atomic fenced bundle update, and — be
precise — the bundle is **NOT** a "pure cache of everything." The **SessionBundle
remains the durable run-execution state** that lives nowhere else: `pending` /
external-tool + clarify suspension, the executor transcript, `toolCallCount`,
resume counters, `budgets`, and the in-flight `phase`. Losing those breaks
external-tool and crash resume, so the bundle is still persisted on every
transition as today. What becomes **additionally artifact-backed is ONLY the BOARD
projection** — the plan STRUCTURE and the step OUTCOMES — so a torn plan/board
write is recoverable:

- **Plan structure** ← `plan-decision` artifacts (below).
- **Step state** ← `step-result` artifacts (precedence-resolved). The step-result
  artifact carries the reviewer **`digest`** (and `remainder`/`note`) alongside the
  full `approved` content, so the BOARD's per-step digest — what the planner reads —
  is itself reconstructible from artifacts, not only from the bundle. (Without this
  the board would claim to be artifact-reconstructible while its digests lived only
  in the snapshot.)

**EVERY planner decision is an immutable artifact (not just expansion).** The
controller writes a `plan-decision` artifact for create-plan, every replan, and
every expand-window BEFORE the board reflects it — otherwise the initial plan and
replans would live only in the snapshot and a lost snapshot would make `planned`
steps + `stepId`s unrecoverable. `artifactType: 'plan-decision'`; payload =
`kind` (`create | replan | expand | page`), the produced/affected steps (`stepId`,
full `instructions`, `discovery?`, `supersedesStepId?`, fan-out `item.id`), for an
expand the `discoveryStepId` + the `continuation` window (`offset, len`) consumed,
and for a `page` the `discoveryChainId` + `pageIndex` + `tokenRef` (NEVER the raw
token — that lives in durable execution state, redacted from board/intent/logs;
§D). A `page` is a controller-authored decision (not an LLM call) but durable via
the same mechanism, with its own `decisionId = uuidv5(runId,'page',
discoveryChainId,pageIndex,tokenHash)` (§D) + the `(runId,'page',…)` slot.

**Finality is fixed by EXECUTION, not by a hash race.** An executed step is
IMMUTABLE — the executed prefix of the plan is never rewritten. A new planner
decision is computed FORWARD from the board (it reads the digests of already-`done`
steps — "what is done" — and only appends or replaces NOT-yet-executed work; a
pure-retry keeps identity, a replacement uses a new `stepId` + `supersedesStepId`).
So a later decision can never overwrite a step whose outcome already committed.
The only ambiguity is the narrow window where two decisions for the same
not-yet-executed slot exist (a crash/re-call before any of their steps ran) — and
there NO history is at stake, so a deterministic pick is safe:

- A decision carries a content-hash `decisionId` (UUIDv5 over `{runId, kind,
  anchorStepId, continuation?, plannerOutput}`). Identical output → identical id
  (dedup); different output → different id.
- **The winner is fixed at DISPATCH by a durable `step-start` claim keyed by the
  contested DECISION slot, BEFORE the step runs.** A claim is
  `{ runId, slotId, stepId, seq, attempt, decisionId }`. The `attempt` is REQUIRED:
  a retry of the same `(stepId, seq)` is a new `attempt`, and each dispatched
  attempt writes its own claim — without it, two attempts' claims would be
  indistinguishable and crash recovery could not match a claim to the
  `(runId, stepId, seq, attempt)` `step-result` it dispatched. Resolution splits by
  concern: the **DECISION winner** for a `slotId` is fixed by the FIRST claim for
  that slot (attempt-independent — a retry never changes which decision owns the
  slot); the **per-attempt dispatch record** is the claim matched 1:1 to its
  `(stepId, seq, attempt)` `step-result`. The **`slotId` identifies the whole
  planner DECISION, not a per-step position** — otherwise position 0 could claim
  decision A while position 1 claims a competing decision B, exactly the forbidden
  cross-decision merge. So a decision occupies ONE slot and a claim on ANY of its
  steps fixes the WHOLE decision:
  - create-plan → `slotId = (runId, 'create')` — one per run;
  - replan → `slotId = (runId, 'replan', anchorStepId)` — one per replaced anchor;
  - expand → `slotId = (runId, 'expand', discoveryStepId, offset)` — one per window;
  - page → `slotId = (runId, 'page', discoveryChainId, pageIndex)` — one per
    follow-up page step (it is dispatched, so it MUST have a slot + `step-start`
    claim like any other step).
  The winner for a `slotId` is the decision named by its **first `step-start`
  claim**; before any claim exists (the pre-dispatch crash window) the merge picks
  the smallest `decisionId` deterministically. The winning decision's steps are
  applied **wholesale** (all of its steps, ids AND instructions — never a
  step-by-step mix of two decisions). Once a claim for a `slotId` exists, that
  decision is locked and competing decisions for the slot are inert.
- **Concurrency: one turn per session at a time, via an in-process lock.**
  `SmartServer._withSession` only refcount-`acquire`s a shared session graph today
  — it does NOT serialize concurrent requests, so two HTTP turns with the same
  session cookie CAN advance the controller in parallel. This design adds a simple
  **per-`sessionId` async lock**: a turn takes the lock at entry (BEFORE
  hydrate/classify — `runId` does not exist yet, so the lock MUST key on
  `sessionId`, the identity present at request entry; keying on `runId` would let
  two parallel turns mint two runs before any lock) and releases it in a `finally`
  on every exit (success / suspend / error / abort). With one turn at a time, there
  is a single writer: the bundle's last-write-wins snapshot is safe and the artifact
  streams need no version token.
- **Multi-process horizontal scaling is OUT OF SCOPE (deferred).** Running
  CONCURRENT turns for the SAME session across processes is NOT supported by this
  design and is deliberately not solved here. Doing it correctly needs a
  storage-side fenced/CAS write that REJECTS a stale writer at write time — neither
  the append-only `KnowledgeBackend` (artifacts) nor `persistBundle` (LWW snapshot)
  provides it, and an after-the-fact "ignore older writes" merge is wrong (old
  artifacts are legitimate history, and a LWW bundle write from a stale coordinator
  would still clobber `pending`/transcript/budgets). **A fencing token does NOT
  help here**: it protects only if the STORE verifies it on write, but neither
  `KnowledgeBackend` nor `persistBundle` checks any token — so a lease-holder that
  lost its lease can still issue a clobbering LWW bundle write. And **sticky
  routing is NOT a single-writer guarantee** — restart/rebalance/rolling-deploy
  overlap two processes on one session, exactly when the clobber happens. So the
  only supported deployments are:
  - (i) **single process**, or
  - (ii) multi-process ONLY if the deployment provides an EXTERNAL mechanism that
    **provably fail-stops / isolates the previous owner BEFORE the session is
    handed to a new owner** (a hard handoff barrier — not a soft lease the old
    owner can outlive). Without that guarantee, multi-process is **unsupported**.

  Making our own stores enforce exclusivity (a token they verify on write, i.e. a
  fenced/CAS-capable store) is a separate infrastructure decision, explicitly
  deferred — and is the only thing that would let the controller itself, rather
  than the deployment, guarantee single-writer.
- **Write order is fixed: claim → durable in-flight (bundle) → dispatch.** The
  `step-start` claim is written first; THEN `inFlightStep` (seq, stepId,
  **`attempt`**, decisionId, phase=`executing`) is persisted to the bundle; THEN the
  executor is dispatched. The `attempt` is REQUIRED on the in-flight record too: a
  retry bumps `attempt`, so after a crash recovery must know WHICH attempt to
  resume and match to its `(stepId, seq, attempt)` `step-result`/claim — without it
  a retry could resume the wrong attempt. Recovery per crash window: (a) claim
  present, no in-flight in bundle → not yet dispatched → resume persists in-flight
  and dispatches (the claim already fixed the decision); (b) in-flight present, no
  `step-result` for that `attempt` → resume via the EXISTING in-flight
  replay/suspend path (executor-call idempotency is that path's existing concern);
  (c) `step-result` for the `attempt` present → terminal.

This gives finality without backend CAS — but NOT without serialization: under the
single-writer per-`sessionId` lock above, a content-hashed write-once decision + a
decision-slot-keyed pre-dispatch claim fix the winner before execution — never a
retroactive flip, no in-flight window in which the winner can change.

**Expand is per-WINDOW within a per-PAGE chain.** The expand slot is
`(runId, discoveryStepId, offset)` — NOT just `(runId, discoveryStepId)` — so each
capacity-sized window (`plan-decision{kind:expand, offset, len}`) coexists instead
of the first one marking the whole discovery done. Across pages, a tool-paginated
discovery is a CHAIN keyed by `discoveryChainId`; each follow-up page is a
`plan-decision{kind:'page', discoveryChainId, pageIndex}` with deterministic
`stepId = uuidv5(discoveryChainId, pageIndex)` (§D). Completion is at the CHAIN
level: a **page** is page-complete when its windows cover its enumeration; the
**chain** is **`fully-expanded`** when the terminal page (digest with NO next-page
token) is reached AND every page is page-complete. `page-complete`, `expanding`,
and `fully-expanded` are all **derived predicates** over the present
`plan-decision{expand}` + `plan-decision{page}` artifacts of the
`discoveryChainId`, not CAS flags. (The old single-`discoveryStepId` +
`truncated:false` definition is superseded.)

**Crash recovery:**
- **A `plan-decision{expand, offset}` or `{page, pageIndex}` exists** → re-apply it
  with its deterministic id (NO new LLM/scheduling).
- **None exists** (crash before write) → re-derive: a window is re-formed forward
  from the board under the capacity gate; a follow-up page is re-scheduled from the
  durable token — the deterministic `stepId`s dedup, so no page/window is lost or
  duplicated.
- **Window already emitted / page already page-complete / chain already
  `fully-expanded`** → skipped (idempotent).

## Data flow

```
planner (digest board) ──emits step──► controller ──dispatches──► executor
                                                                      │ recalls prior FULL results from run-scoped RAG by seq as needed
                                                                      ▼
reviewer ──RETURNS {verdict, approved, digest, enumeration?}──► controller persists + assigns ids:
                              ├─► FULL approved content ─► run-scoped RAG (step-result by seq)   [executor consumes]
                              ├─► planning DIGEST ───────► planner board (state + digest)          [planner consumes]
                              └─► enumeration (discovery) ─► 'enumeration' artifact (windowed locally)
discovery done ──► CONTROLLER windows the durable enumeration/tool-token (≤maxFanOut)
               ──► hands the window to the planner (expand-remainder) ──► planner fans out ──► plan-decision{expand,offset}
```

## Components & boundaries

- **`outcome.ts` / reviewer** — the verdict gains a `digest` field (and, for
  discovery, a structured `enumeration`) that the reviewer RETURNS; the reviewer
  does NOT persist — the controller does (boundary preserved).
- **Step-state board** — a structured projection rendered into the planner prompt
  (replaces the payload-free `plannerPrivate` blob), merged from THREE sources
  with the attempt-scoped resolution of §F: (1) `plan-decision` artifacts
  (structure) + (2) `step-result` artifacts (terminal state + digest) + (3) the
  `step-start` claim and the bundle's in-flight/`pending` (the TRANSIENT states
  `executing` / `awaiting-external` — do NOT omit these; a board without source 3
  cannot show a live or blocked step). The BOARD portion of the bundle is a derived
  cache; run-EXECUTION state (budgets, phase, transcript, resume counters,
  `pending`, `toolCallCount`) lives authoritatively in the SessionBundle. The
  projection is EXTENSIBLE — further sources/states may be added as the system
  grows (the three above are the current set, not a closed limit).
- **Two planner implementations** + the **expand-remainder** trigger; the
  composition factory selects the implementation.
- **`Step`** — gains `stepId` (stable), `discovery?: true`, and
  `supersedesStepId?` (replacement-on-replan link); the board carries per-step
  `state` + `digest`. `step-result` artifacts gain `stepId` AND the reviewer
  `digest` (so the board's digests are artifact-reconstructible).
- **`plan-decision` artifact** — a new run-scoped immutable artifact for EVERY
  planner/controller decision (`create | replan | expand | page`), with a
  content-hash `decisionId`,
  written before the bundle reflects it; the board is replayed from these +
  `step-result` artifacts (§F). Only the board portion of the bundle is thereby a
  derived cache — run-execution state still lives in the bundle.
- **`enumeration` artifact** — a new run-scoped artifact holding a discovery
  step's canonical `{id,label}[]` list (deterministic `enumerationId =
  uuidv5(runId,discoveryStepId,seq,attempt)`), windowed locally by the controller
  for `artifact-offset` continuation (§D).
- **`step-start` claim artifact** — written immediately BEFORE a step is
  dispatched (`{runId, slotId, stepId, seq, attempt, decisionId}`, `slotId` = the
  whole decision); pins the winning decision for a `slotId` at dispatch time so no
  competing decision can win during the in-flight window; `attempt` matches it 1:1
  to its `step-result` (§F).
- **Per-`sessionId` serialization lock** — a NEW component: an in-process async
  lock keyed by `sessionId` (NOT `runId` — `runId` does not exist before
  hydrate/mint), acquired at turn entry before hydrate and released in `finally` on
  every exit (success/suspend/error/abort). It makes ONE turn advance a session at
  a time → single writer → the bundle's LWW snapshot is safe. Required because
  `_withSession` does NOT serialize concurrent same-session requests today.
  Multi-process concurrent same-session is OUT OF SCOPE (§F).
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

**Two test scopes — they differ by what is pipeline-agnostic vs planner-specific:**

- **Gnostification (skills WITH/WITHOUT) — a CONCRETE conformance matrix across
  ALL pipelines (pass/fail, not "as far as possible").** A row per pipeline
  (`flat`, `linear`, `controller`, `dag`, `stepper`) in the existing
  `pipelines/__tests__/conformance.test.ts` seam. Each SUPPORTED row asserts three
  checkpoints with a stub skill source + a probe prompt: (1) the skill source is
  attached to that pipeline; (2) a relevant skill is SELECTED for the probe; (3)
  the selected skill's CONTENT actually appears in the exact context the pipeline
  feeds the model (the assembler prompt for flat/linear; the planner recall block
  for controller; the step/tool-query context for dag/stepper). A pipeline that
  does NOT yet wire skills (per the skill-plugin-host spec — e.g. dag/stepper if
  still deferred there) is an EXPLICIT matrix entry marked `unsupported(reason)` /
  `xfail`, not a silent gap — so the matrix is exhaustive and every cell is a
  definite supported-pass or recorded-deferred. This scope is NOT planner-specific.
- **Replanning / deferred expansion / capability planners / board+claim+attempt+
  crash — the CONTROLLER pipeline ONLY.** ("Has a planner" is too broad — `dag`
  and `deep stepper` also have planners but do NOT implement this board / claim /
  expand protocol; only the `controller` does.) They are tested for the controller
  with BOTH planner kinds
  (`smart-executor`, `weak-executor`). Pipelines without a planner (flat/linear/…)
  get only the gnostification scope above.

Primary signal for the planner scope is **plan GENERATION**, not execution (agreed:
"знімаємо генерацію планів, виконувати необовʼязково"). Extend the build-excluded
`plan-analysis.ts` dev harness:

- Add an `EVAL_PLANS_ONLY` capture mode + data-dependent fan-out prompts
  (`read-includes`, `find-usages`) + full trajectories for BOTH new planners
  (`smart-executor` and `weak-executor`) — NOT the retired `incremental`/`adaptive`.
- Capture, per prompt × planner, the **generated plan** (full, instructions +
  per-step state) and the **deferred-expansion trajectory** (discovery step + the
  fanned-out steps after feeding a synthetic discovery digest), WITH/WITHOUT
  skills.
- Assert STRUCTURE, never retrieval quality: no repeated identical step (the loop
  regression we observed); discovery step present for fan-out prompts under the
  weak planner; per-window fan-out count == that window's actual `len`; each
  `(discoveryStepId, offset)` window decision emitted exactly once; the chain
  transitions `done → expanding → expanded` monotonically.
- **Tool-pagination chain tests.** A multi-page discovery: (a) each follow-up page
  is a `plan-decision{kind:'page', discoveryChainId, pageIndex}` with deterministic
  `stepId = uuidv5(discoveryChainId, pageIndex)` AND `decisionId = uuidv5(runId,
  'page', discoveryChainId, pageIndex, tokenHash)`, and a `step-start` claim on slot
  `(runId,'page',discoveryChainId,pageIndex)`; (b) **terminal-page completion** —
  the chain reaches `fully-expanded` only after the page with NO next-page token is
  reached AND every page is page-complete (NOT at the first page's last window);
  (c) **deterministic page replay/dedup** — a crash before/after the page-decision
  write, or a duplicate scheduling, collapses by `decisionId` (stepId alone is
  insufficient), never losing or duplicating a page; (d) **token redaction** — the
  raw next-page token NEVER appears in the rendered board / any `intent` / logs;
  only a `tokenRef`/`tokenHash` is in artifacts, the raw token only in durable
  execution state.
- **Capacity-gated windows.** With `maxActiveSteps` small relative to the
  enumeration, assert windows are emitted incrementally as capacity frees (not all
  up front), `windowSize = min(maxFanOut, maxActiveSteps − activeCount, remaining)`,
  next offset advances by ACTUAL `len`, and a config with `maxActiveSteps <
  maxFanOut` fails loud at load (no deadlock).
- Reviewer-digest unit tests: a discovery result yields a STRUCTURED digest
  (`items: [{id,label}]`, validated, bounded by `maxFanOut`/`maxItemChars`,
  `truncated` set on overflow); a normal result yields a free-text extract
  truncated to `maxDigestChars`.
- **Board-budget tests.** (a) Drive a run past `maxBoardChars` and assert the
  deterministic compaction: protected (not-terminal) steps + most recent `K`
  terminal digests kept in full; older terminal digests collapse to
  `[seq N name status]` oldest-first; then to `"… M omitted"`; same board ⇒
  identical output. Assert actionable (not-terminal) entries are NEVER aggregated —
  each keeps `stepId` + state + a `maxIntentChars`-bounded intent. (b) **Discovery
  protection:** the next expand window still succeeds under budget pressure because
  it reads the durable `enumeration` artifact (and durable token), not the board —
  assert fan-out is unaffected by compaction. (c) **Guaranteed cap / fail-loud:** a
  config violating the invariant (`maxActiveSteps × (stepId+state+maxIntentChars) +
  K × maxDigestChars + headroom > maxBoardChars`) fails loud at load; and a run
  whose actionable set still would not fit **suspends/fails BEFORE the planner
  call** — it is NOT silently degraded to counts.

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
- **Dispatch claim fixes the winner — BOTH pre-dispatch windows (distinct
  recovery).** (a) Crash after the `step-start` claim is written but BEFORE
  `inFlightStep` is persisted to the bundle → on resume, no in-flight exists, so
  the step is (re-)dispatched, but the claim already pins the decision (assert the
  SAME decision wins, not a competing one). (b) Crash after `inFlightStep` is
  persisted but BEFORE the executor was dispatched → on resume the in-flight replay
  path runs the step under the claimed decision. In BOTH, assert the claimed
  decision wins and no competing decision's steps appear. Also assert a crash after
  the claim but before any `step-result` never lets a later competing decision win.
- **Retry identity + precedence resolution.** A step that fails then retries to
  `ok` keeps one `stepId` with incrementing `attempt` under one `seq`;
  `resolveByPrecedence` collapses to the `ok` (precedence `ok|exists > partial >
  failed`, NOT latest-write) — assert a later `failed` artifact does NOT overwrite
  an earlier committed `ok`; `writeOrdinal` only tie-breaks equal rank. A
  replan-replacement gets a NEW `stepId` + `supersedesStepId` and shows as a
  separate board entry.
- **Attempt-correct crash resume.** A step at `attempt N` that crashes mid-flight
  resumes the SAME `attempt N` (the in-flight record + claim carry `attempt`),
  matching its `(stepId, seq, attempt)` `step-result` — assert recovery never
  resumes the wrong attempt or double-counts a retry.
- **Attempt-scoped board state.** Drive `failed(attempt 0) → claim/in-flight
  (attempt 1) → done(attempt 1)` and assert the board shows, in order, `failed`
  then **`executing`** (the live retry, NOT the stale `failed`) then `done` — the
  newer attempt's transient supersedes the older attempt's terminal; precedence
  (`ok>partial>failed`) applies only once no newer attempt is live.
- **Expansion-only-on-done.** A discovery step that settles `partial`/`failed`
  triggers replan, NOT expansion; NO `plan-decision{kind:expand}` is written and
  the step never enters `expanding`.
- **Idempotent per-window re-expand.** Re-invoking expand for an already-emitted
  `(discoveryStepId, offset)` window writes no new decision; the chain reaches
  `fully-expanded` only when the terminal page is reached AND all pages
  page-complete, and a re-invoke after that emits nothing.
- **Slot-claim contention.** Two competing decisions for one `slotId` (different
  `stepId`s) → the first `step-start` claim's decision wins; the loser's steps
  never appear executing on the board. (Note: this assumes the lock already
  serialized the turns — it does NOT by itself prove serialization; see below.)
- **Per-`sessionId` lock protocol (separate tests).** (a) Two concurrent
  turn-advances for one `sessionId` are SERIALIZED (the second blocks until the
  first releases — assert no interleaved writes). (b) **Fresh-run race:** two
  parallel first-requests for a new session mint exactly ONE `runId`, not two
  (lock taken on `sessionId` BEFORE hydrate/mint). (c) The lock is released after a
  thrown exception AND after an abort (the `finally` runs on every exit). (No
  multi-process / distributed-lease test — that case is out of scope, §F.)

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
