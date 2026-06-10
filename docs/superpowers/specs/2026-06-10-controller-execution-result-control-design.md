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
  kind: 'step-result', runId, seq,
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

**Replay identity & reconciliation.** The artifact write and the cursor/bundle
persist are separate, so a crash between them replays a step. Append-only means
we cannot overwrite — so we need a planner-agnostic stable id, a reconciliation
rule that does not lose a confirmed success, and dedup that does not starve
recall.

- **Stable `seq` + durable attempt bound (#1).** `planCursor` exists only for
  adaptive. Instead, a durable monotonic **`nextSeq`** lives in the bundle, and the
  in-flight step is `inFlightStep = { seq, step, attempt, resumeCount, phase }`
  where `phase ∈ {executing, awaiting-replan}`. A replayed (uncommitted) step reuses the
  SAME `seq` (writes land at the same `(runId, seq)`).
- **Three distinct durable counters (#1/14).** A resume is one of three kinds,
  distinguished by durable state, each with its own bound:
  - **Fresh execution** (first dispatch / replan's revised step = a NEW
    transcript) → increments **`attempt`** (persisted BEFORE the LLM call); cap
    `maxStepAttempts`. This is what bounds the duplicate count per `(runId, seq)`
    (closing unique-K) and retry/replan liveness.
  - **External-tool continuation** (`pending` is an external-tool marker — a
    legitimate step making several external round-trips) → increments NEITHER
    `attempt` NOR the crash counter; bounded by the step's `maxToolCalls`.
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
    `inFlightStep = { seq (same), revisedStep, attempt (unchanged here), phase:
    'executing' }`. The single pre-execute increment then bumps `attempt` when the
    revised step runs. A crash while `phase:'awaiting-replan'` resumes into
    **replan** (not re-execution of the failed step). The retry reuses the same
    `seq`, so failed + retry artifacts share `(runId, seq)` and dedup-by-precedence
    keeps the eventual success.
- **Resume reconciliation, by RESOLVED ARTIFACT, not by phase alone (#1).** The
  artifact write and the `phase` persist are separate, so a crash AFTER
  `writeArtifact(failed)` but BEFORE persisting `phase:'awaiting-replan'` leaves
  `phase:'executing'` with a durable FAILED artifact. So resume does NOT trust
  `phase` alone — it does an exact `get(runId, seq)` and routes by the **resolved
  artifact status**, reconciled by precedence (`ok/exists > partial > failed`):
  - an **approved** result (`ok`/`exists`/`partial`) → **adopt + commit**, do not
    re-run (closes the "wrote ok then crashed, replay would fail" case);
  - a **resolved `failed`** artifact (no approved one) → move to
    **`awaiting-replan` → replan**, do NOT re-execute the failed step (closes the
    write-failed-before-phase window);
  - **no artifact** at `(runId, seq)` → the step truly did not complete →
    re-execute.
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

A durable **`runPhase ∈ {planning, executing, finalizing}`** refines `active` so
recovery is unambiguous even when there is no `inFlightStep` (#2): `planning` (no
in-flight step yet), `executing` (a step is in flight — `inFlightStep` set),
`finalizing` (planner returned `done`, `inFlightStep` cleared, finalizer running).
`runPhase` is persisted on every transition.

Transitions:

- **New request while idle/terminal:** ONE atomic bundle write **resets EVERY
  run-scoped field** — `goal`, `plan`, `planCursor`, `plannerPrivate`, `budgets`,
  `lastOutcome`, `pending`, **`nextSeq` (→ 0), `inFlightStep` (→ none), `runPhase`
  (→ planning), `finalizeAttempt` (→ 0), `originalRequest` (→ the new request;
  fingerprint re-derived)** — and **mints a fresh `runId`** → active. The prior
  run's `terminalOutcome` is NOT reset here — it lives in the separate TTL store
  (below) so it stays replayable by its `runId` across this fresh run.
  The reset is exhaustive (#3) precisely so a fresh run cannot inherit the prior
  run's replay state (`nextSeq`/`inFlightStep`) or an exhausted `finalizeAttempt`.
- **Resume while suspended:** keep `runId` + all run-scoped state.
- **`done` / abort:** write a durable **discriminated `terminalOutcome`**
  (#1) — `{ kind:'success', answer } | { kind:'error', error }` — into a
  **SEPARATE keyed store `{ runId → { terminalOutcome, expiresAt } }`** (#2/13),
  NOT a single bundle field, then → terminal. Keying by `runId` with `expiresAt`
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
     - else the key **equals the current bundle's `runId`** → **resume** the
       current run (by `runPhase`);
     - else → **not-found / expired** error. It does NOT fall through to
       fingerprint or to resuming the current run — a stale/expired key must never
       accidentally hijack a different active run.
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
  - **Active run, match (token or fingerprint)** → **resume by `runPhase`**:
    `planning` →
    re-invoke the planner (no in-flight step yet); `executing` → the
    `inFlightStep` reconciliation above (adopt / replan / re-execute by resolved
    artifact); `finalizing` → **re-run the finalizer**, bounded by a **durable
    `finalizeAttempt`** persisted+incremented BEFORE the call (same pattern as
    `inFlightStep.attempt`) so a crash-loop in `finalizing` cannot bypass
    `maxFinalizeRetries` (exceeded → `onFinalizeExhausted`). The finalizer is
    otherwise idempotent (composes from durable approved results, no side
    effects), so replay within budget is safe. No match → the crashed run is
    **abandoned** (logged) → reset → fresh run.
  So an active run — with OR without an `inFlightStep` (e.g. mid-finalize) — is
  never ambiguous: `runPhase` says what to resume; otherwise it is explicitly
  abandoned, never silently continued under the wrong prompt.

## Data backbone & RAG contract changes (#5 prev)

- **results-RAG** — per-session store; each artifact tagged `{runId, seq,
  status}` and carrying the full `Outcome`. `KnowledgeEntryMetadata` +=
  `runId/seq/status` (or a generic `tags` map); `KnowledgeFilter` += equality on
  **`runId`, `seq`, `status`** (#3 — `seq` is required, not just runId/status) +
  order by `seq`. The **semantic query must accept the `runId` filter applied
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
context. The suspended state MUST persist: the **full `Step`** (name,
instructions, `requires`, model hint), the executor's **message transcript** up
to suspension, and `{toolName, args, extId, position}`. On resume: rebuild the
executor context from the transcript, inject the external result, **re-run
executor → reviewer** (normal path) — no bypass to `plannerPrivate`. An external
soft failure thus becomes `status:'failed'` → replan.

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
  `finalizeAttempt`** persisted+incremented BEFORE each call (so crash-replays in
  `runPhase:'finalizing'` cannot bypass the budget). On exhaustion the behavior is
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
- New budgets `maxStepAttempts` (durable fresh-attempt cap — bounds dups +
  retry/replan liveness), `maxStepResumes` (durable crash-replay cap — bounds a
  crash-loop on one attempt), `maxToolCalls` (external round-trips per
  transcript), `maxReviewRetries`, `maxFinalizeRetries`; judge-failure escalation
  (abort-with-control-error, not silent advance/fail);
  `onFinalizeExhausted: error|best-effort` (default `error`).
- `plannerPrivate += {seq, status, note, remainder}` (payload-free), not content.
- Single finalizer after `done` for BOTH planners, reading run-scoped approved
  results (deduped) under the budget; `done` carries no answer.
- `SessionBundle`: durable `runId` (resume token) + run-state + `runPhase
  {planning|executing|finalizing}` + `nextSeq` + `inFlightStep
  {seq,step,attempt,resumeCount,phase}` + `finalizeAttempt` + durable `originalRequest`
  (finalizer input; normalized hash = identity fingerprint) + atomic run-scoped
  RESET (incl. `finalizeAttempt→0`); `attempt` increments on FRESH executions
  only (not external-tool continuations). A SEPARATE per-session keyed store
  `{runId → {terminalOutcome (success|error), expiresAt}}` holds terminal outcomes
  (TTL-GC'd), replayed ONLY via an explicit token/idempotency key (`newRun`
  overrides). Crash-recovery routed by `runPhase` (token/fingerprint for active
  resume, token only for terminal replay); resume reconciliation by RESOLVED
  artifact status; persist full suspended-step state in the external-tool
  `PendingMarker`. `plannerPrivate`
  rebuild + dedup + finalizer all resolve a `seq` by the same outcome-precedence.
- `KnowledgeEntryMetadata` + `KnowledgeFilter`: `runId/seq/status` (+ filter/order);
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
