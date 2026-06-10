# Controller: Execution-Result Control & Data Backbone — Design

**Status:** active design (controller pipeline). READ + **idempotent** WRITE;
exactly-once non-idempotent side effects out of scope. NOT yet an implementation
plan — review the contracts below first.

**Builds on:** merged controller work (`bde840e6`, `cc5ccc43`) and
`2026-06-09-controller-planner-gnosticization-design.md`.

## Core idea: separate DOING from JUDGING

An LLM does not reliably grade its own work, so the step outcome is produced by a
**separate reviewer role**, never the executor's self-report. Per step:

1. **Executor** — given the step (intent + `requires`), recalled inputs, and the
   relevant tools, does the work and returns its **full result** (and an optional
   short self-claim). It does NOT decide success and does NOT write to RAG yet.
2. **Reviewer** — a separate role, given the step intent + `requires` + the
   per-reference recall evidence + the executor's result → produces the
   **authoritative outcome**:
   `{ status: 'ok'|'exists'|'failed'|'partial', approved: <content to keep>,
   remainder: <what is still missing>, note }`.
   `approved` is the executor's content for `ok`/`exists`, or the validated
   ACCEPTED extract for `partial`.
3. **Controller** — writes the step artifact ONCE (post-review, see below),
   updates `plannerPrivate`, maps `status` to the planner transition.

**Reviewer is ALWAYS-ON** (every step is reviewed; the executor never sets
status). What is configurable is the reviewer's MODEL (a cheaper-but-capable
model for simple steps), NOT whether review happens. By default the reviewer is
**tool-less** (judges from intent + evidence + result → no side-effect risk);
optional verification-by-read requires the consumer to designate a **read-only**
tool subset for the reviewer (the controller cannot classify tools agnostically).

## Roles

evaluator (request → goal) → planner (steps) → executor (does) → **reviewer
(judges)** → [loop] → finalizer (composes the answer after `done`).

## Interfaces (project principle: program to interfaces, swap implementations)

Every capability here is an **interface with a default implementation**;
deployments/tests swap implementations without touching the controller. Existing
seams stay (`ILlm`, `IEmbedder`, `IRag`/`IKnowledgeRagHandle`, `ISubagentClient`,
`IControllerPlanner`). This design adds/extends:

- **`IReviewer`** — `review(step, evidence, executorResult, opts) → Outcome`.
  The controller depends ONLY on this; `status` always comes through it.
  Default impl: an LLM reviewer (capable model). Alternative impls: a
  tool-verifying reviewer (read-only state check), a deterministic/heuristic
  judge (trusted fast path), a voting/composite reviewer. Swapping the impl
  changes *how* a step is judged, not the control flow.
- **`IFinalizer`** — `finalize(goal, request, approvedResults) → answer`. Default:
  LLM. Swappable (e.g. a template/format-driven finalizer).
- **`IControllerPlanner`** (exists) — gains the `partial` transition; incremental
  and adaptive are two implementations; consumers may supply their own.
- **`IKnowledgeRagHandle`** (exists) — extended metadata/filter (`runId/seq/
  status`); in-memory/qdrant/hana/pg are implementations of the SAME contract,
  with a fetch-then-filter fallback where native filtering is missing.
- **Typed, provider-neutral contracts:** `Outcome {status, approved, remainder,
  note}`, `Step {…, requires}` — no SAP/object specifics.
- **Run scope** — the `runId` minter is an injectable (deterministic test
  override), consistent with the existing id-minters.

The default build wires the LLM/standard implementations; the controller is
coded against the interfaces only — so reviewer, finalizer, planner and backbone
are all DI seams, swappable per deployment or per test.

## Outcome persistence (#1 — append-only RAG, write-after-review)

`IKnowledgeRagHandle` is append-only (`write()`, no id/update). So there is **no
`pending` artifact and no update**. Instead: the executor's result is held in the
controller in-memory; after the reviewer judges, the controller **writes the
artifact ONCE** with the final `status` and the reviewer-`approved` content:

```
writeArtifact(results-RAG, {
  kind: 'step-result', runId, seq, attempt,        // attempt ∈ identity (#2/26)
  // FULL Outcome is durable, not just status+approved (#1):
  status, note, remainder,                        // control fields, from the reviewer
  content: approved,                              // reviewer-approved (full | accepted extract)
})
```

The artifact persists the **complete `Outcome`** (`status`, `note`, `remainder`)
plus the approved content — NOT just `status`/`approved`. So `remainder` (needed
to replan a `partial`) and `note` survive a crash between the write and the bundle
persist. `plannerPrivate` is then a **convenience cache** of these control fields,
**rebuildable from the run's artifacts** on resume (exact list by `runId`,
resolving each `seq` by the **SAME outcome-precedence rule** as dedup/finalizer —
`ok/exists > partial > failed`, tie-break latest — NOT bare "latest", so the
planner, reconciliation and finalizer always agree). Losing the bundle does not
lose the control state. Nothing is written
before review; no record is mutated. (A raw-vs-approved audit trail, if ever
wanted, is an additional immutable record — out of scope now.)

**Reviewer crash safety (#2/18).** Because the executor result is held in-memory
and the artifact is written ONLY after the reviewer approves, executor-run →
review → write is a single atomic-from-recovery unit: a crash anywhere in it
leaves NO artifact at `(runId, seq)`, so reconciliation re-executes the step
(charged to `resumeCount`, cap `maxStepResumes`). The reviewer therefore needs no
separate durable phase or `reviewResumeCount` — a mid-review crash IS a step
crash-replay. Re-running is clean at the *control-state* level (nothing was
committed); duplicate *tool side effects* from the repeated executor run are
governed by the at-least-once + tool-idempotency contract (#3/19), the same as any
crash-replay — not by artifact-absence. (`maxReviewRetries` bounds *provider*
errors within one live review, a different failure mode.)

**Replay identity & reconciliation.** The artifact write and the cursor/bundle
persist are separate, so a crash between them replays a step. Append-only means
we cannot overwrite — so we need a planner-agnostic stable id, a reconciliation
rule that does not lose a confirmed success, and dedup that does not starve
recall.

- **Stable `seq` + durable attempt bound (#1).** `planCursor` exists only for
  adaptive. Instead, a durable monotonic **`nextSeq`** lives in the bundle, and the
  in-flight step is
  `inFlightStep = { seq, step, attempt, resumeCount, phase, transcript, toolCallCount }`
  where `phase ∈ {executing, awaiting-replan}` (#2/25). A replayed (uncommitted) step
  reuses the SAME `seq`, and each artifact also carries its `attempt`. So there are
  **two levels of keying (#2/26):** the **exact `(runId, seq, attempt)`** answers
  "did THIS execution commit?" (used by crash/external-resume reconciliation, so a
  prior attempt's `failed` artifact is never mistaken for the current attempt's
  result), while **`(runId, seq)`** is the cross-attempt resolution scope for
  dedup, the finalizer, and the read-side precedence rule.
  - **`transcript`** — the durable executor message log for this `seq` (the
    suspend/resume + crash-replay rebuild source; external results are appended
    here). The `external-tool` `PendingMarker` carries only the call coordinates
    (`{toolName, args, extId, position}`); the execution context lives on
    `inFlightStep` (#4/25).
  - **`toolCallCount`** — a durable count of external round-trips for this step,
    **incremented and persisted on `inFlightStep` BEFORE each external call is
    surfaced** (so it cannot reset across resumes); cap `maxToolCalls` (#1/25). It
    is NOT recomputed from the transcript at runtime (the transcript may be
    summarized/truncated for resume — see Open questions), so the durable counter is
    authoritative.
  - **Reset/replan (#2/25):** a fresh attempt / revised step (replan) **clears
    `transcript` (→ empty) and `resumeCount` (→ 0)**; `toolCallCount` also resets to
    0 (a revised step is a new transcript with its own round-trip budget). A
    crash-replay of the SAME attempt keeps `transcript`/`toolCallCount` (it rebuilds
    from them). `nextSeq` advance clears the whole `inFlightStep`.
- **Three distinct durable counters (#1/14).** A resume is one of three kinds,
  distinguished by durable state, each with its own bound:
  - **Fresh execution** (first dispatch / replan's revised step = a NEW
    transcript) → increments **`attempt`** (persisted BEFORE the LLM call); cap
    `maxStepAttempts`. This is what bounds the duplicate count per `(runId, seq)`
    (closing unique-K) and retry/replan liveness.
  - **External-tool continuation** (`pending` is an external-tool marker — a
    legitimate step making several external round-trips) → increments NEITHER
    `attempt` NOR the crash counter; bounded by the **durable `inFlightStep.
    toolCallCount`** (incremented+persisted BEFORE each surfaced call, so it
    survives resumes) against `maxToolCalls` (#1/25) — never a per-resume local
    counter that would reset to 0 each leg.
  - **Crash-replay** (`phase:'executing'`, NO external `pending`, transcript
    exists) → increments a separate durable **`resumeCount`** (persisted on
    re-entry, BEFORE re-executing); cap `maxStepResumes` → abort. This is what
    bounds a process that **keeps crashing before the artifact write on one
    attempt** (the gap `attempt` alone left open). `resumeCount` resets to 0 on
    commit / on a fresh attempt.
  `pending` cleanly separates the continuation case from the crash-replay case, so
  legitimate external round-trips are never charged the crash budget.
- **`inFlightStep` lifecycle by outcome (#3), one atomic write each:**
  - **advanced (`ok`/`exists`) / partial:** commit at `seq` → `nextSeq` advances,
    `inFlightStep` clears. (A `partial` remainder is planned at the NEXT `seq`; the
    accepted part is NOT re-run.)
  - **failed (#1 — close the post-failed crash window):** `nextSeq` does NOT
    advance; the controller FIRST persists `inFlightStep.phase = 'awaiting-replan'`
    (durable) — it does NOT yet have a revised step. THEN it calls the planner; on
    the planner's response it atomically sets
    `inFlightStep = { seq (same), revisedStep, attempt (unchanged here),
    resumeCount: 0, phase: 'executing', transcript: empty, toolCallCount: 0 }` —
    `resumeCount`, `transcript`, and `toolCallCount` are **all reset** (#3/16, #2/25:
    a revised step is a fresh attempt — new transcript, own round-trip budget — and
    must not inherit the prior attempt's crash/tool budget). The single fresh-execution increment then bumps `attempt` when
    the revised step runs (which also re-zeroes `resumeCount` per the rule that
    every fresh attempt resets it). A crash while `phase:'awaiting-replan'` resumes into
    **replan** (not re-execution of the failed step). The retry reuses the same
    `seq`, so failed + retry artifacts share `(runId, seq)` and dedup-by-precedence
    keeps the eventual success.
- **Resume reconciliation, by RESOLVED ARTIFACT, not by phase alone (#1).** The
  artifact write and the `phase` persist are separate, so a crash AFTER
  `writeArtifact(failed)` but BEFORE persisting `phase:'awaiting-replan'` leaves
  `phase:'executing'` with a durable FAILED artifact. So resume does NOT trust
  `phase` alone — it does an exact **`get(runId, seq, attempt)`** for the CURRENT
  attempt (#2/26 — a prior attempt's artifact at the reused `seq` is not this
  execution) and routes by the **resolved artifact status**:
  - an **approved** result (`ok`/`exists`/`partial`) → **adopt + commit**, do not
    re-run (closes the "wrote ok then crashed, replay would fail" case);
  - a **resolved `failed`** artifact (no approved one) → move to
    **`awaiting-replan` → replan**, do NOT re-execute the failed step (closes the
    write-failed-before-phase window);
  - **no artifact** for this `(runId, seq, attempt)` → the attempt truly did not
    complete → re-execute.
  `phase:'awaiting-replan'` (when it was persisted) is consistent with this and
  still routes to replan. As a backstop for any remaining
  duplicates, read-side dedup resolves a `(runId, seq)` by **outcome precedence**
  `ok/exists > partial > failed` (tie-break latest), never bare chronology.
  Committed seqs (`< nextSeq`) are authoritative and never re-run.
- **Dedup before the cap.** Duplicates of one `(runId, seq)` must not fill the
  top-K and crowd out other steps. Since duplicates are bounded by
  `maxStepAttempts` (above), semantic recall does a **single bounded over-fetch**
  (`k' = k × (maxStepAttempts + 1)`) → dedup `(runId, seq)` by the precedence
  above → take `min(k, available unique)` distinct steps. This is the ONE normative behavior (no
  pagination/refill). (See the retrieval-primitives definition under the data
  backbone.)

## Planner transitions (#2 — partial is a first-class outcome)

`commit()`/`lastOutcome` are extended from `advanced|failed` to
`advanced|failed|partial`:

- **advanced** (`ok`/`exists`): commit advances the cursor; no replan.
- **failed**: cursor stays; replan re-attempts.
- **partial**: commit **advances the cursor** (the accepted part is committed and
  will not be re-run) AND sets `lastOutcome='partial'`, which **forces a replan**
  whose job is to plan ONLY the `remainder` (recorded in `plannerPrivate`). The
  accepted step is NOT repeated; the replan INSERTS steps for the missing part.

So "got 8 of 10, replan got the last 2": the partial step is committed (the 8 are
done + in RAG as `approved`), and a replanned step produces the remaining 2.

## Finalizer (#2/#3 — unified, reviewer-approved content only)

Today only adaptive has a finalizer call; incremental returns a `done.result`
built from `plannerPrivate`. Once `plannerPrivate` is concise, incremental has no
data. Fix:

- **One finalizer stage runs after the planner returns `done`, for BOTH
  planners.** `done` only signals completion (carries no answer). The finalizer
  composes from the **run-scoped result set** in results-RAG, against the bundle's
  **durable `originalRequest`** — NOT the current leg's prompt, which after an
  external-tool resume is the tool result, not the user's ask (#2). The bundle
  persists `originalRequest`; its normalized hash is the identity fingerprint used
  for crash recovery.
- The finalizer reads only **reviewer-approved content** (`status ∈ {ok, exists,
  partial}` with the stored `approved` field) — never raw executor output. A
  `partial` artifact contributes its accepted extract only, so unfinished/wrong
  claims from a partial executor pass do not leak into the answer.

### Finalizer read policy (budget / ordering / truncation / overflow)

Token **budget** `B` (config); results ordered by `seq` (then request-relevance
if available); per-result cap `C` (truncate-with-marker beyond `C`). **Overflow**
(`Σ>B`): **map-reduce** — summarize largest/oldest into compact extracts, then
compose; never silently drop; log every reduction.

## Run scope & lifecycle (durable runId) (#4)

`traceId` changes per leg; the session holds many requests. A **run** (one user
request across suspend/resume legs) is scoped by a durable `runId`. Bundle state:

- **idle/terminal** — no active run; **active** — run in progress; **suspended** —
  awaiting external tool / clarify (`pending` set).

A durable **`runPhase ∈ {evaluating, planning, executing, finalizing}`** refines
`active` so recovery is unambiguous even when there is no `inFlightStep` (#2):
`evaluating` (the evaluator is deriving the goal — no plan yet), `planning` (goal
fixed, no in-flight step yet), `executing` (a step is in flight — `inFlightStep`
set), `finalizing` (planner returned `done`, `inFlightStep` cleared, finalizer
running). `runPhase` is persisted on every transition; a fresh run starts in
`evaluating`.

**General invariant — every LLM-invoking phase bounds its *crash-replay* with a
durable resume counter + cap (#2/16, #1/17),** so NO phase can crash-loop
unbounded. The bound is on REPLAY of an *unfinished* call, never on normal forward
progress. A counter may only be charged when recovery can PROVE a call was
actually in flight — so each phase has a **durable in-flight detector** that
distinguishes "crashed before the call started" (re-enter, do NOT charge) from
"crashed during the call" (charge the resume counter):

- **evaluating** → detector **`evalCallInFlight`** (#1/19), counter
  `evalResumeCount`, cap `maxEvalResumes`. The evaluator (request → goal) is a
  distinct LLM call that runs ONCE at the start of a run, and its `goal` is its
  *output* (no artifact to resolve against — same shape as planning). So: **persist
  `evalCallInFlight = true` BEFORE invoking the evaluator**. The evaluator returns
  ONE of two kinds, each with its OWN atomic transition (#1/20):
  - **goal established** → ONE atomic bundle write **persists the `goal`, clears
    `evalCallInFlight`, advances `runPhase → planning`** (and resets
    `evalResumeCount`, moot thereafter);
  - **needs-confirmation** (the evaluator wants the consumer to confirm a proposed
    target before committing a goal) → ONE atomic bundle write **persists
    `pending = {kind:'clarify', position:'goal', question, proposedTarget}`, clears
    `evalCallInFlight`, resets `evalResumeCount`, and sets run-state → `suspended`**
    — it does NOT write `goal` and does NOT advance to `planning`. The proposed
    target rides on the marker so a later confirmation commits THAT (not a bare
    "yes"). **Clarify-resume semantics are deterministic (#3/21), exactly one
    rule** (after an empty/whitespace answer is rejected — stay `suspended`,
    re-surface the question, #2/23)**:** the incoming reply is the answer; if it is
    an **affirmation**
    (`isAffirmation` — "yes"/"так"/…) AND a `proposedTarget` exists → `goal =
    proposedTarget`; **otherwise the reply itself becomes the `goal` verbatim**
    (treated as a refinement). EITHER way, ONE atomic bundle write sets the `goal`,
    clears `pending`, flips `runState → active`, and advances `runPhase → planning`
    (#1/22 — never suspended-with-pending:none, never a goal without its phase) — it
    does **NOT** re-invoke the evaluator and does **NOT** reset the run (a bare
    re-evaluation would loop the clarify forever, since the goal would still be
    empty). Recovery while
    `suspended` with a `clarify` marker takes the normal suspended-resume path
    (resume on the consumer's reply) — NOT an evaluator re-call, so `evalResumeCount`
    is not charged.

  Recovery in `runPhase:'evaluating'` while still `active` (no clarify marker yet):
  if `evalCallInFlight` → charge `evalResumeCount` (cap `maxEvalResumes`) and
  re-evaluate; else → re-evaluate without charging. This closes the evaluator
  crash-loop the invariant previously left uncovered (#1/19) AND defines the
  consumer-confirm flow for recovery (#1/20).
- **planning** → detector **`plannerCallInFlight`** (#1/18), counter
  `plannerResumeCount`, cap `maxPlannerResumes`. The plan/decision is the planner's
  *output*, so — unlike executing — there is no `(runId, seq)` artifact to resolve
  against; `runPhase:'planning'` alone cannot tell whether a call had started.
  So: **persist `plannerCallInFlight = true` BEFORE invoking the planner**; on the
  planner's response, ONE atomic bundle write **persists the decision
  (plan/step), clears `plannerCallInFlight`, and resets `plannerResumeCount → 0`**.
  Recovery in `runPhase:'planning'`: if `plannerCallInFlight` → a call was
  in flight → increment `plannerResumeCount` (cap `maxPlannerResumes`) and re-ask;
  else (false) → no call had started → re-ask WITHOUT charging. So normal forward
  planner calls (each ending with the atomic decision-write that resets the
  counter) are never capped — an incremental run that invokes the planner once per
  step is safe (#1/17). Forward planner progress is bounded by plan/step liveness
  (`maxStepAttempts`, `done`), not by this counter.
- **executing** → the in-flight detector is the **resolved artifact at
  `(runId, seq)`** (no separate marker needed): `attempt` (fresh-execution count,
  bounds dups + retry/replan liveness) + `resumeCount` (crash-replay of one
  attempt — charged on re-entry when `phase:'executing'`, no external `pending`,
  and NO resolved artifact at `seq`), caps `maxStepAttempts` / `maxStepResumes`.
  **The reviewer is NOT a separately durable phase (#2/18).** Executor-run →
  review → single write-after-review is ONE crash-replay unit: the executor result
  is in-memory only, and write-after-review guarantees the `(runId, seq)` artifact
  exists *only after* the reviewer approved. So a crash anytime between the
  executor producing its result and the post-review write leaves NO artifact at
  `seq` → reconciliation re-executes the step, charged to `resumeCount`. At the
  *control-state* level this is clean — no half-written or unreviewed artifact to
  reconcile, the re-run is a fresh transcript at the same `seq`, dedup-by-precedence
  absorbs eventual multiples — and no `reviewResumeCount` is needed: the reviewer
  crash IS the executor crash, by construction. **But re-execution can repeat the
  executor's external tool calls (#3/19): the re-run's safety against duplicate
  *side effects* rests on the same at-least-once + tool-idempotency contract as
  every other crash-replay here, NOT on artifact-absence** (artifact-absence only
  proves no control-state was committed, not that the world was untouched). For a
  non-idempotent WRITE this is exactly the at-least-once exposure called out under
  Idempotency & durability — out of scope for this design, deferred to the WRITE
  exactly-once spec. (`maxReviewRetries` is a separate, in-process budget for
  *provider* errors / malformed verdicts within one live review, not a crash
  bound.)
- **finalizing** → detector **`finalizeCallInFlight`** (same pattern as planning —
  the finalizer's answer is its output, no artifact to resolve), counter
  `finalizeAttempt`, cap `maxFinalizeRetries`: persist `finalizeCallInFlight=true`
  before the call. **Terminal-write reconciliation (#2/19).** The `terminalOutcome`
  lives in the SEPARATE TTL store while `finalizeCallInFlight`/`runState` live in
  the bundle, so the two writes are NOT one transaction — a crash between them can
  leave `terminalOutcome` already written but the bundle still `finalizing`. To
  make finalize **idempotent across that gap**, the completion order is fixed and
  recovery checks the terminal store FIRST:
  1. finalizer returns → **write `terminalOutcome` to the TTL store keyed by the
     current `runId`** (durable first);
  2. then the bundle write **clears `finalizeCallInFlight` and sets
     `runState → terminal`**.
  On recovery in `runPhase:'finalizing'` (whether reached by token OR fingerprint),
  the controller **first reads the terminal store for the current `runId`**: if an
  entry exists, finalize already produced an answer → **adopt it, set the bundle
  terminal, and do NOT re-invoke the finalizer** (so a fingerprint-resume can never
  replace an already-emitted answer). Only if there is NO terminal entry does it
  (re-)invoke the finalizer, charging `finalizeAttempt` when `finalizeCallInFlight`
  is set. (`finalizeAttempt` is moot once terminal.)

(Earlier rounds added the executing/finalizing counters; `plannerResumeCount` +
the explicit in-flight markers close the planning-phase crash-loop and the
charge-when-no-call-started over-count that were still open.)

Transitions:

- **New request while idle/terminal:** ONE atomic bundle write **resets EVERY
  run-scoped field** — `goal`, `plan`, `planCursor`, `plannerPrivate`, `budgets`,
  `lastOutcome`, `pending`, **`nextSeq` (→ 0), `inFlightStep` (→ none), `runPhase`
  (→ evaluating), `evalCallInFlight` (→ false), `evalResumeCount` (→ 0),
  `plannerCallInFlight` (→ false), `plannerResumeCount` (→ 0),
  `finalizeCallInFlight` (→ false), `finalizeAttempt` (→ 0),
  `originalRequest` (→ the new request; fingerprint re-derived)** — and **mints a
  fresh `runId`** → active. The prior
  run's `terminalOutcome` is NOT reset here — it lives in the separate TTL store
  (below) so it stays replayable by its `runId` across this fresh run.
  The reset is exhaustive (#3, #2/17) precisely so a fresh run cannot inherit the
  prior run's replay state (`nextSeq`/`inFlightStep`) or an exhausted resume
  budget (`plannerResumeCount`/`finalizeAttempt`).
- **Resume while suspended:** keep `runId` + all run-scoped state.
- **`done` / abort:** write a durable **discriminated `terminalOutcome`**
  (#1) — `{ kind:'success', answer } | { kind:'error', error }` — into a
  **SEPARATE keyed store `{ runId → { terminalOutcome, expiresAt } }`** (#2/13),
  NOT a single bundle field, then → terminal. `abort` (budget exhaustion,
  judge-failure escalation, `onFinalizeExhausted:'error'`) can fire from **any**
  phase — `evaluating`/`planning`/`executing`/`finalizing` — and always uses this
  same **store-first, bundle-second** ordering, so the general terminal-first
  recovery check (below) covers aborts from every phase (#1/21). Keying by `runId` with `expiresAt`
  lets the outcome **survive subsequent runs until its TTL** (a single bundle
  field would be wiped by the next run's reset, breaking the TTL promise). Replay
  returns whichever kind was stored (success → answer, error → error), never an
  undefined `finalAnswer`. The store is GC'd by TTL.
- **Request classification — strict ordered algorithm (#1/#2/15).** Evaluate in
  THIS order; the first matching branch wins:
  1. **`newRun` flag set** → fresh run (reset + new `runId`). Checked FIRST, so
     `newRun` overrides any replay (#2/15).
  2. **Explicit idempotency key / `runId` present** → **STRICT** routing, NO
     fingerprint fallback (#1/15):
     - the key is in the (run-surviving) **terminal store**, non-expired →
       **replay** its `terminalOutcome` (success → answer, error → error) and
       STOP — independent of the current bundle; a different active run keeps
       going;
     - else the key **equals the current bundle's `runId` AND `runState ∈
       {active, suspended}`** → **resume** the current run via the **three-stage
       recovery algorithm** (terminal-store → consume `pending` → route by
       `runPhase`, defined below — #3/22). The run-state guard matters (#1/16): if
       the current run is already TERMINAL (its store entry expired/GC'd), the key
       must NOT resume by a stale `runPhase`;
     - else → **not-found / expired** error. It does NOT fall through to
       fingerprint or to resuming a non-active run — a stale/expired key must
       never accidentally hijack a different (or terminated) run.
  3. **No explicit key** → fingerprint is used ONLY to recover an in-flight
     ACTIVE run (`active`/`suspended`) of the same request; a fingerprint match on
     a TERMINAL run does NOT replay (can't tell a lost-response retry from an
     intentional re-run) → **fresh run**. No fingerprint, no live key → fresh run.
- The terminal store is kept under a **retention TTL** so replay is bounded, not
  indefinite.
- **Crash recovery — active with NO `pending`:** a process crash mid-step leaves
  the bundle `active` but not `suspended`. Classification does NOT use raw request
  equality (unreliable for `Message[]`, whitespace, transport re-delivery).
  Instead:
  - **Explicit resume token (primary):** the bundle exposes `runId` as a resume
    token; a client that passes it back resumes that run unambiguously.
  - **Canonical fingerprint (fallback):** the bundle persists the durable
    `originalRequest` (also the finalizer's input); its identity fingerprint is a
    hash of the *normalized* request (messages reduced to `{role, trimmed
    content}`, transport metadata dropped). The incoming request is normalized +
    hashed and compared. (The fingerprint is for identity only; the request itself
    is kept for the finalizer.)
  - **Terminal run:** replay only on an **explicit token** (`runId`) → return the
    stored `terminalOutcome`; a fingerprint-only match does NOT replay (per #2) —
    it starts a fresh run. (Active-run resume below may use token OR fingerprint,
    since resuming an in-flight run is safe/idempotent; only terminal *replay* is
    gated on the explicit key.)
  - **Active run, match (token or fingerprint)** → resume in a **fixed three-stage
    order** (#1/21, #2/21), never `runPhase` first:
    1. **Terminal-store check FIRST, for ANY phase (#1/21).** `done` AND every
       `abort` (budget exhaustion, judge-failure escalation, `onFinalizeExhausted`)
       write the `terminalOutcome` to the TTL store BEFORE flipping the bundle to
       `terminal` — and that two-write gap exists in `evaluating`/`planning`/
       `executing` aborts too, not only `finalizing`. So the FIRST thing any resume
       does is **read the terminal store for the current `runId`; if an outcome is
       present, adopt it + set the bundle terminal and STOP** — do NOT resume the
       phase. (Generalizes the finalizing-only check of #2/19 to all phases, closing
       the "crash after terminal write, before bundle flip → recovery re-runs an
       active phase" window.)
    2. **Consume `pending` BEFORE `runPhase` (#2/21).** If `pending` is set, the
       run is `suspended`. Dispatch by `pending.kind`:
       - **`clarify`** → the incoming message IS the user's answer. **Validate it
         first (#2/23):** an empty / whitespace-only answer is NOT an established
         goal — stay `suspended`, keep the `clarify` marker, and re-surface the
         clarification question (no goal write, no phase change). For a non-empty
         answer, ONE atomic bundle write applies the deterministic clarify-resume
         rule from the evaluating phase (affirmation → `goal=proposedTarget`, else
         reply-verbatim → `goal`), clears `pending`, flips `runState → active`, AND
         advances `runPhase → planning` — all together, so recovery never sees a
         goal without its phase/state, nor `suspended` with `pending:none` (#1/22).
       - **`external-tool`** → **first check the resolved artifact of THIS attempt
         at `(runId, seq, attempt)` (#2/24, #2/26):** the artifact-store write and
         the bundle/marker clear are separate ops, so a crash between them can leave
         a durable artifact with a stale marker. The lookup is keyed by
         `(runId, seq, attempt)` — NOT bare `(runId, seq)` — because retry/replan
         reuses the same `seq`, so a PRIOR attempt's `failed` artifact must not be
         mistaken for this continuation's result (#2/26). If THIS attempt's artifact
         exists, route by its **resolved outcome, NOT unconditional advance
         (#1/26)** — exactly the executing reconciliation:
         - **approved (`ok`/`exists`/`partial`)** → in **ONE atomic bundle write**
           adopt it, clear `pending`, flip `runState → active`, advance the cursor /
           clear `inFlightStep` (the normal commit, #3/25);
         - **`failed`** (this attempt resolved failed) → in ONE atomic write clear
           `pending`, flip `runState → active`, and set `inFlightStep.phase =
           'awaiting-replan'` at the **SAME `seq`** (do NOT advance — that would skip
           an unexecuted step) → replan.
         Never a separate marker-clear that could leave `suspended` + `pending:none`.
         Do NOT repeat the tool call. If THIS attempt has no artifact yet, the
         awaited thing is the
         TOOL RESULT keyed by `extId`, NOT the incoming message (#2/22) — a plain
         re-request must never be mis-recorded as a result. **Look it up by `extId`**
         (external result/callback store):
         - If NOT yet available → the call is still outstanding: **re-issue the SAME
           tool call (same `extId`, idempotent) and keep the run `suspended`** — do
           not consume, do not advance.
         - If available → ONE atomic bundle write **injects the result into the
           durable `inFlightStep` execution state** (appends it to the step's
           persisted executor transcript), **clears `pending`, and flips
           `runState → active`** with `runPhase` staying `executing` (#1/24). The
           continuation is now a PLAIN `executing` step — NOT a `pending` one — so it
           is reconciled by the resolved artifact at `(runId, seq)` like any other
           step. Durability holds (#1/23): the result lives in the durable
           `inFlightStep` transcript, so a crash before the artifact commit re-enters
           `executing`, rebuilds from that transcript (result already injected — no
           re-fetch, no re-issue), and is bounded by `resumeCount`. This removes the
           unsupported `active + pending(resolved)` state — a resolved external
           result becomes ordinary in-flight execution.
       Only after `pending` is consumed (or absent, run already `active`) does
       routing fall through to `runPhase`. Without the pending-first rule a
       `clarify`-suspended run (still `runPhase:'evaluating'`) would wrongly
       re-invoke the evaluator instead of consuming the user's answer.
    3. **Route by `runPhase`** (no terminal entry, no `pending`):
       `evaluating` → re-invoke the evaluator (no goal yet), charging
       `evalResumeCount` (cap `maxEvalResumes`) only if `evalCallInFlight` proves a
       call was running; `planning` →
       re-invoke the planner (no in-flight step yet), charging `plannerResumeCount`
       (cap `maxPlannerResumes`) only if `plannerCallInFlight` proves a call was
       running; `executing` → the
       `inFlightStep` reconciliation above (adopt / replan / re-execute by resolved
       artifact, with a mid-review crash re-executing since no artifact was written),
       crash-replay bounded by `resumeCount`/`maxStepResumes`; `finalizing` →
       **re-run the finalizer** (the stage-1 terminal check already handled the
       already-emitted case), bounded by the **durable `finalizeAttempt`**
       charged on replay only when `finalizeCallInFlight` is set, so a crash-loop in
       `finalizing` cannot bypass `maxFinalizeRetries` (exceeded → `onFinalizeExhausted`). The finalizer is
       otherwise idempotent (composes from durable approved results, no side
       effects), so replay within budget is safe.
    No match → the crashed run is **abandoned** (logged) → reset → fresh run.
  So an active run — with OR without an `inFlightStep` (e.g. mid-finalize) — is
  never ambiguous: terminal-first, then pending, then `runPhase` says what to
  resume; otherwise it is explicitly abandoned, never silently continued under the
  wrong prompt.

## Data backbone & RAG contract changes (#5 prev)

- **results-RAG** — per-session store; each artifact tagged `{runId, seq, attempt,
  status}` and carrying the full `Outcome`. `KnowledgeEntryMetadata` +=
  `runId/seq/attempt/status` (or a generic `tags` map); `KnowledgeFilter` +=
  equality on **`runId`, `seq`, `attempt`, `status`** (#3 — `seq` required; `attempt`
  added #2/26 so reconciliation can fetch the CURRENT execution, not just any at the
  reused `seq`) + order by `seq`. The **semantic query must accept the `runId` filter applied
  BEFORE the top-K cap** (#2); backends do this natively or via the
  exact-`list(runId)`-then-rank-locally fallback.
- **tool-RAG** — `selectTools` top-K per step (executor only).
- **plannerPrivate** — convenience cache of control fields, rebuildable from
  artifacts.

**Two retrieval primitives (distinct):**
- **Semantic recall (executor):** top-K by meaning, **scoped to `runId` BEFORE
  the cap (#2)**. The session holds many runs, so a whole-session top-K could be
  filled by OTHER runs' artifacts before any run filter. Therefore the run filter
  must be applied pre-cap, one of:
  - **native:** the backend semantic query takes a `runId` equality filter and
    ranks within it (`query(text, k', filter:{runId})`); or
  - **fallback:** exact `list(runId)` (the run's artifacts only) → rank locally by
    similarity → top-K.
  Within the run's candidate set, duplicates of a `(runId, seq)` are bounded by
  `maxStepAttempts`, so a single **bounded over-fetch** `k' = k ×
  (maxStepAttempts + 1)` → dedup-by-precedence → take **`min(k, available
  unique)`** distinct `(runId, seq)` (a run may legitimately have fewer than `k`
  logical steps). No cursor/pagination needed. (Optional future: backend
  `DISTINCT (runId, seq)`.)
- **Exact list/get (NOT semantic) (#3):** an exhaustive metadata query —
  `list(runId)` / `get(runId, seq)` — returning ALL matching artifacts with no
  relevance ranking or top-K. Used by the **finalizer full set**, **resume-adopt**
  (`get(runId, seq)`), and **dedup**. A confirmed artifact can never be missed by
  a semantic cutoff because this path does not rank/cut.

## Dependency manifest & miss detection (not self-eval)

Planner emits per dependent step `requires: ["<plain reference>", …]`. Presence
is decided by a role OTHER than the doer. A single semantic query on the whole
step prompt cannot say WHICH reference matched, so evidence is gathered **one
recall query per `requires[]` reference** (#3): each reference → its own
top-K query → an evidence map `{ ref → hit?/topArtifact }`. (The general
step-prompt recall still runs for loose context; the per-reference queries are
extra embedding lookups — cheap.) The **reviewer** then judges intent + the
evidence map + result; a reference with no evidence (or an unused input) →
`failed` (note: "missing input: <ref>"). Honestly not fully deterministic
(semantic match + LLM judgement), but per-reference and decided by a non-doer
role. (Open: a stricter controller-side match threshold.)

## Config & roles contract (#5)

`ControllerConfig.subagents` gains **`reviewer`** and **`finalizer`** alongside
`evaluator/planner/executor` — each a standalone LLM config (+ optional `hint`):

- **Defaults / migration (no breaking change):** an existing 3-role config still
  works — if `reviewer` is absent it **defaults to the planner's model** (capable);
  if `finalizer` is absent it defaults to the planner too. New deployments may set
  them explicitly (e.g. a cheaper reviewer for simple pipelines).
- **Factory/deps (#4 — interfaces, not clients):** the handler depends on
  `IReviewer` and `IFinalizer` (the interfaces) — NOT on subagent clients. The
  **factory** reads the `reviewer`/`finalizer` LLM config and builds the DEFAULT
  LLM-backed implementations (`new LlmReviewer(makeSubagentClient(reviewerLlm))`,
  etc.), injecting them as `IReviewer`/`IFinalizer`. The `ISubagentClient` is thus
  an implementation detail INSIDE the default impl, never in the handler deps. A
  consumer swaps the interface (own reviewer/finalizer) without the factory.
  `models` gains `reviewer`/`finalizer` for usage attribution (`/v1/usage`
  byComponent gains `reviewer`/`finalizer`).
- **Reviewer tools:** none by default; a read-only subset only if the consumer
  designates one (see Core idea).

## External-tool resume (persist the suspended step)

The current `PendingMarker` (tool name/args + step name) loses the execution
context. The suspended state MUST persist on the durable `inFlightStep`: the
**full `Step`** (name, instructions, `requires`, model hint), the executor's
**message transcript** up to suspension, and the `external-tool` marker
`{toolName, args, extId, position}`.

On resume — **artifact-first, then result-by-`extId`:**
1. If THIS attempt's artifact exists at `(runId, seq, attempt)` (#2/26) → the
   continuation committed before the crash → route by its resolved outcome (#1/26),
   in **ONE atomic bundle write** each: **approved** → adopt, clear `pending`, flip
   `runState → active`, advance the cursor / clear `inFlightStep` (normal commit);
   **failed** → clear `pending`, flip `runState → active`, set `phase:'awaiting-replan'`
   at the SAME `seq` (do NOT advance) → replan. No tool re-call, never a bare
   marker-clear that leaves `suspended` + `pending:none` (#2/24, #3/25).
2. Else look up the **tool result keyed by `extId`** (not the resuming message,
   #2/22). If NOT yet available → the call is outstanding → **re-issue the SAME
   call (same `extId`, idempotent), stay `suspended`**.
3. Else (result available) → ONE atomic write **injects it into the durable
   `inFlightStep` transcript, clears `pending`, flips `runState → active`** with
   `runPhase` staying `executing` (#1/24). The continuation is now a PLAIN
   `executing` step (no `pending`), reconciled by `(runId, seq)` like any step.
   Rebuild the executor context from the transcript and **re-run executor →
   reviewer** (normal path) — no bypass to `plannerPrivate`. Durability holds
   (#1/23): the injected result is in the durable transcript, so a mid-continuation
   crash re-enters `executing` and rebuilds it without re-fetch, bounded by
   `resumeCount`.

**A continuation that makes the NEXT external call (#3/24):** the executor is free
to make several external round-trips. Each new call, in ONE atomic write:
**increments+persists `inFlightStep.toolCallCount` (cap `maxToolCalls`, #1/25)**,
**REPLACES the (now consumed) marker with a FRESH `external-tool` marker** (new
`extId`, new tool/args), appends to `inFlightStep.transcript`, and re-suspends — all
on the same `inFlightStep`/`seq`. Because `toolCallCount` is durable on the step
(not a per-resume local), the bound holds across crashes/resumes.

**`maxToolCalls` exceeded is a CONTROLLER failure, not a reviewer status (#3/26).**
The invariant that `status` always comes from `IReviewer` holds for STEP outcomes;
a blown round-trip budget is a control-level limit the executor never got to finish,
so the controller does NOT synthesize a reviewer `status:'failed'`. Instead it
emits a **controller-level step failure** (a typed control outcome
`{ kind:'control-failed', reason:'maxToolCalls', seq }`, NOT an `Outcome`) that
drives the SAME failed transition — `phase:'awaiting-replan'` at the same `seq` →
replan — bypassing the reviewer (there is no reviewable executor result). This is
the same shape as judge-failure / budget escalation: a controller transition, kept
out of the reviewer-owned `status` channel. (A persistent over-budget step is
ultimately bounded by `maxStepAttempts`/abort like any non-advancing step.)

So there is never a stale resolved marker; at most one *unresolved* marker is
outstanding at a time, and the transcript accumulates across round-trips until the
step commits its artifact. An external **soft** failure (the tool ran and returned
an error the executor surfaced) still flows the normal executor → reviewer path and
becomes a reviewer `status:'failed'` → replan — distinct from the controller-level
budget failure above.

## Idempotency & durability

- Controller does not dedupe/track existence; re-issued create → tool reports
  "already exists" → reviewer marks `exists` → advance. Update/delete/activate
  idempotency is the tool's contract.
- **At-least-once** (tool effect, write, persist are separate ops). READ replays
  harmless; side-effecting WRITE must be tool-idempotent. **Exactly-once for
  non-idempotent side effects is out of scope** (separate WRITE-durability spec);
  the replay window is a documented limitation.

## Reviewer / finalizer failure semantics (#2)

A reviewer or finalizer that times out / provider-errors / returns a malformed
or empty-but-`ok` outcome is a **judge failure, not a step failure** — the
executor's actual outcome is then UNKNOWN, so the controller must not silently
mark the step advanced OR failed.

- **Separate retry budgets:** `maxReviewRetries`, `maxFinalizeRetries` (distinct
  from the executor's `maxRetries`).
- **Reviewer transient error / malformed / `status:ok` with empty `approved`:**
  re-ask the reviewer (within `maxReviewRetries`). Empty-approved-with-ok is
  treated as malformed (contradictory), not as success.
- **Reviewer budget exhausted:** the step outcome is **unverifiable** → do NOT
  guess. Escalate: **abort the run with a control error** ("step <seq> outcome
  unverifiable") rather than advancing or failing the step. (A future option: a
  fallback `IReviewer` — e.g. a conservative deterministic judge.)
- **Finalizer error:** retry within `maxFinalizeRetries`, counted by a **durable
  `finalizeAttempt`** charged on crash-replay only when the durable
  `finalizeCallInFlight` marker proves a call was in flight (persist
  `finalizeCallInFlight=true` before the call). Completion is NOT a single
  transaction — `terminalOutcome` (TTL store) and the bundle's
  `finalizeCallInFlight`/`runState` are separate writes — so the order is
  **terminal store FIRST, then the bundle** clears `finalizeCallInFlight` + sets
  `runState → terminal`, and every `finalizing` recovery **reads the terminal store
  FIRST → adopt-without-re-call** if present (#2/19, #2/20). So crash-replays in
  `runPhase:'finalizing'` cannot bypass the budget, a crash BEFORE the call started
  is not miscounted, and a crash between the two writes never re-invokes the
  finalizer to replace an emitted answer. On exhaustion the behavior is
  a **single explicit config enum** `onFinalizeExhausted: 'error' | 'best-effort'`
  — **default `'error'`** (terminal control error, deterministic).
  `'best-effort'` composes from the already-approved results with an explicit
  "incomplete" marker. Either way: never a confabulated completion, and the
  terminal state is well-defined per the chosen value.
- These are LLM/role faults; they go through the same usage metering but are
  attributed to `reviewer`/`finalizer`, not the executor.

## What changes vs the current code

- New `IReviewer` + `IFinalizer` interfaces; handler depends on them; the factory
  builds the default LLM impls from the `reviewer`/`finalizer` config. Reviewer
  always-on, tool-less by default; usage attributed to `reviewer`/`finalizer`.
- `runStep`: durable `nextSeq` + `inFlightStep {seq, step, attempt, resumeCount,
  phase}`; `attempt` increments ONLY on a FRESH execution (first dispatch /
  replan), NOT on external continuation or crash-replay; a crash-replay (executing,
  no external `pending`) increments the separate `resumeCount` (cap
  `maxStepResumes`); external continuations are bounded by `maxToolCalls`. `failed`
  first persists `phase:'awaiting-replan'`, then (on planner response) sets the
  revised step at the same `seq` with `phase:'executing'`; `advanced`/`partial`
  commit + advance `nextSeq`. On resume: `awaiting-replan` → replan; `executing` →
  exact `get(runId, seq)` → adopt-or-re-run. Executor result held in memory → reviewer →
  **single** `writeArtifact` post-review; reads dedup `(runId, seq)` by outcome
  precedence; semantic recall filters `runId` before the bounded over-fetch
  `k×(maxStepAttempts+1)`.
- Per-`requires` recall queries → evidence map for the reviewer.
- Planner outcome `advanced|failed|partial`; `commit()`/`next()` handle `partial`
  (advance accepted + replan remainder); `lastOutcome` type extended.
- New budgets — one durable crash-replay counter+cap per LLM-invoking phase
  (bounds REPLAY of an unfinished call, never normal forward progress):
  `maxEvalResumes` (evaluating, via `evalResumeCount`),
  `maxPlannerResumes` (planning, via `plannerResumeCount` — reset to 0 after every
  persisted planner decision, so the incremental planner's per-step calls are NOT
  capped by it), `maxStepAttempts` (fresh-attempt; bounds dups + retry/replan
  liveness) + `maxStepResumes` (crash-replay), `maxToolCalls` (external round-trips,
  via the durable `inFlightStep.toolCallCount` — persisted before each surfaced
  call, never a per-resume local, #1/25), `maxFinalizeRetries` (via `finalizeAttempt`), `maxReviewRetries`;
  judge-failure escalation (abort-with-control-error, not silent advance/fail);
  `onFinalizeExhausted: error|best-effort` (default `error`).
- `plannerPrivate += {seq, status, note, remainder}` (payload-free), not content.
- Single finalizer after `done` for BOTH planners, reading run-scoped approved
  results (deduped) under the budget; `done` carries no answer.
- `SessionBundle`: durable `runId` (resume token) + run-state + `runPhase
  {evaluating|planning|executing|finalizing}` + `nextSeq` + `inFlightStep
  {seq,step,attempt,resumeCount,phase,transcript,toolCallCount}` (#2/25 — the
  durable executor transcript + round-trip count live ON the step; the
  `external-tool` `PendingMarker` carries only call coordinates) + in-flight markers
  `evalCallInFlight`/`plannerCallInFlight`/`finalizeCallInFlight` +
  `evalResumeCount`/`plannerResumeCount` +
  `finalizeAttempt` + durable `originalRequest`
  (finalizer input; normalized hash = identity fingerprint) + atomic run-scoped
  RESET (incl. markers→false, `evalResumeCount→0`, `plannerResumeCount→0`, `finalizeAttempt→0`);
  `attempt` increments on FRESH executions only (not external-tool continuations);
  `evalResumeCount`/`plannerResumeCount`/`finalizeAttempt` are charged on
  crash-replay ONLY when the matching in-flight marker
  (`evalCallInFlight`/`plannerCallInFlight`/`finalizeCallInFlight`) proves a call
  was running, and `evalResumeCount`/`plannerResumeCount` reset after every
  persisted goal/planner decision. The reviewer adds no durable phase
  — a mid-review crash re-executes the step (no artifact written yet), charged to
  `resumeCount`. A SEPARATE per-session keyed store
  `{runId → {terminalOutcome (success|error), expiresAt}}` holds terminal outcomes
  (TTL-GC'd), replayed ONLY via an explicit token/idempotency key (`newRun`
  overrides). Because `terminalOutcome` (TTL store) and the bundle's
  `runState`/markers are separate writes, every terminal transition (`done` and
  ALL aborts, from any phase) writes the terminal store FIRST, then flips the
  bundle — and **every** active-run recovery, regardless of `runPhase`, reads the
  terminal store FIRST → adopt-without-re-call (#2/19, #1/21). Active-run resume
  is a fixed order: **terminal-store → consume `pending` → route by `runPhase`**
  (#2/21), so a `clarify`/`external-tool`-suspended run consumes the reply instead
  of re-entering its phase. A non-empty clarify answer is consumed by ONE atomic
  write that also flips `runState suspended → active` (never `suspended` with
  `pending:none`; empty answer → stay suspended, re-ask, #2/23). `external-tool`
  resume is **artifact-first** (adopt + clear marker if `(runId,seq)` already
  committed, #2/24), else consumes the tool result looked up by `extId` (re-issue
  the same call + stay suspended if not yet available), NOT the incoming message.
  A found result is **injected into the durable `inFlightStep` transcript and
  `pending` is CLEARED** (the continuation becomes a plain `executing` step,
  reconciled by `(runId,seq)`; no `active + pending(resolved)` state — #1/24); a
  mid-continuation crash rebuilds from that durable transcript without re-fetch
  (#1/23). The NEXT external call **replaces the consumed marker with a fresh
  unresolved one** on the same `seq`, transcript accumulating (#3/24).
  Crash-recovery routed by
  `runPhase` (token/fingerprint for active
  resume, token only for terminal replay); resume reconciliation by RESOLVED
  artifact status; the full suspended-step state (Step + transcript + toolCallCount)
  lives on `inFlightStep`, while the `external-tool` `PendingMarker` carries only the
  call coordinates `{toolName, args, extId, position}` (#4/25). `plannerPrivate`
  rebuild + dedup + finalizer all resolve a `seq` by the same outcome-precedence.
- `KnowledgeEntryMetadata` + `KnowledgeFilter`: `runId/seq/attempt/status` (+ filter/order);
  backend filter or fetch-then-filter.

## Empirical basis

- Forced wrong-order DDIC: soft-failure undetected; adaptive confabulated success
  (2/3 inactive); incremental survived by foresight.
- Composition-coupled CDS: hard activation failure escalated → adaptive replanned
  with mass-activation; incremental hit the parse-retry limit (clean give-up).
- Hello-world write: correct code; weak executor flailed → target-model-aware
  planning (related, separate).

## Open questions

- Reviewer model tier vs cost (always-on = +1 call/step); can a cheaper model
  judge reliably; when does the reviewer verify via a read-only tool.
- Stricter controller-side input-presence evidence (beyond a recall hit).
- Persisted executor transcript size for resume — bound/summarize.
- Finalizer relevance ranking within budget; approved-extract sizing for partials.
- `plannerPrivate` growth on long runs.
- Whether `finalizer` should be its own role or always reuse the planner.

## Out of scope

- Exactly-once / non-idempotent WRITE durability (separate spec).
- Raw-vs-approved audit trail (extra immutable record).
- Target-model-aware step detail + per-step model routing (V3) — related, separate.
