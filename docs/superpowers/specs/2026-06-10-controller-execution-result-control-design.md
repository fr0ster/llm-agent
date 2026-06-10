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
  adaptive. Instead, a durable monotonic **`nextSeq`** lives in the bundle; when a
  step is dispatched the controller persists **`inFlightStep = { seq: nextSeq,
  step, attempt }`** and **increments+persists `attempt` BEFORE executing**. A
  replayed (uncommitted) step reuses the SAME `seq` (so writes land at the same
  `(runId, seq)`), and because `attempt` is bumped-and-persisted **before** each
  execution, the durable `attempt` count survives crashes — it is NOT reset by
  re-entry. A hard cap **`maxStepAttempts`** aborts a step that keeps
  crash-looping (liveness), and — crucially — it makes the duplicate count per
  `(runId, seq)` genuinely **bounded by `maxStepAttempts`** (closing the
  unique-K guarantee, which `maxRetries` alone did not, since crashes are not
  retries). Works for incremental and adaptive alike (no plan/cursor dependence).
- **`inFlightStep` lifecycle by outcome (#3).** ONE atomic bundle write per
  transition:
  - **advanced (`ok`/`exists`) / partial:** the accepted result is committed at
    `seq` → `nextSeq` advances, `inFlightStep` clears. (A `partial` remainder is
    planned at the NEXT `seq`; the accepted part is NOT re-run.)
  - **failed:** `nextSeq` does NOT advance; the replan's revised step atomically
    **replaces** `inFlightStep = { seq (same), revisedStep, attempt: prev+1 }`
    before re-execute. The retry reuses the same `seq`, so the failed artifact and
    the retry artifact share `(runId, seq)` and dedup-by-precedence keeps the
    eventual success.
- **Resume reconciliation, NOT latest-wins (#2).** Latest-write-wins is wrong: a
  first attempt could write an approved `ok` then crash, and a replay attempt
  finish `failed`, hiding the real success. So: on resume of an active run,
  BEFORE re-running `inFlightStep`, the controller **queries results-RAG for an
  existing approved artifact at `(runId, seq)`** (`status ∈ {ok, exists,
  partial}`); if one exists, **adopt it and commit — do NOT re-run** the step.
  Only if none exists is the step re-executed. As a backstop for any remaining
  duplicates, read-side dedup resolves a `(runId, seq)` by **outcome precedence**
  `ok/exists > partial > failed` (tie-break latest), never bare chronology.
  Committed seqs (`< nextSeq`) are authoritative and never re-run.
- **Dedup before the cap.** Duplicates of one `(runId, seq)` must not fill the
  top-K and crowd out other steps. Since duplicates are bounded by
  `maxStepAttempts` (above), semantic recall does a **single bounded over-fetch**
  (`k' = k × (maxStepAttempts + 1)`) → dedup `(runId, seq)` by the precedence
  above → take K distinct steps. This is the ONE normative behavior (no
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

Transitions:

- **New request while idle/terminal:** ONE atomic bundle write **resets EVERY
  run-scoped field** — `goal`, `plan`, `planCursor`, `plannerPrivate`, `budgets`,
  `lastOutcome`, `pending`, **`nextSeq` (→ 0), `inFlightStep` (→ none),
  `originalRequest` (→ the new request; fingerprint re-derived)** — and **mints a
  fresh `runId`** → active.
  The reset list is exhaustive precisely so a fresh run cannot inherit the prior
  run's replay state (`nextSeq`/`inFlightStep`) or recovery identity.
- **Resume while suspended:** keep `runId` + all run-scoped state.
- **`done` (finalizer composed) or abort:** → terminal; next request resets.
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
  - Match (token or fingerprint) → **resume from `inFlightStep`** (adopt-or-re-run
    per the reconciliation above). No match → the crashed run is **abandoned**
    (logged) → reset → fresh run.
  So an active-without-pending bundle is never ambiguous: recovered via a stable
  identity, or explicitly abandoned — never silently continued under the wrong
  prompt.

## Data backbone & RAG contract changes (#5 prev)

- **results-RAG** — per-session store; each artifact tagged `{runId, seq,
  status}` and carrying the full `Outcome`. `KnowledgeEntryMetadata` +=
  `runId/seq/status` (or a generic `tags` map); `KnowledgeFilter` += equality on
  **`runId`, `seq`, `status`** (#3 — `seq` is required, not just runId/status) +
  order by `seq`. Backends filter natively or fall back to fetch-then-filter.
- **tool-RAG** — `selectTools` top-K per step (executor only).
- **plannerPrivate** — convenience cache of control fields, rebuildable from
  artifacts.

**Two retrieval primitives (distinct):**
- **Semantic recall (executor):** top-K by meaning, scoped to `runId`.
  Duplicates of a `(runId, seq)` are **bounded by `maxStepAttempts`** (the durable
  per-step attempt cap — see Replay identity), so ≤ `maxStepAttempts` artifacts
  exist per `seq`. Therefore a single **bounded over-fetch** with the existing
  `query(text, k')`, `k' = k × (maxStepAttempts + 1)`, yields ≥ `k` distinct
  `(runId, seq)` after dedup-by-precedence (worst case: every one of `k` unique
  steps carries the max dups). No cursor/pagination required — the bound is a
  durable budget, not an assumption. (Optional future: a `query(text, k, offset)`
  cursor + backend `DISTINCT (runId, seq)` as a cleaner optimization.)
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
- **Finalizer error:** retry within `maxFinalizeRetries`; on exhaustion the
  behavior is a **single explicit config enum** `onFinalizeExhausted: 'error' |
  'best-effort'` — **default `'error'`** (terminal control error, deterministic).
  `'best-effort'` composes from the already-approved results with an explicit
  "incomplete" marker. Either way: never a confabulated completion, and the
  terminal state is well-defined per the chosen value.
- These are LLM/role faults; they go through the same usage metering but are
  attributed to `reviewer`/`finalizer`, not the executor.

## What changes vs the current code

- New `IReviewer` + `IFinalizer` interfaces; handler depends on them; the factory
  builds the default LLM impls from the `reviewer`/`finalizer` config. Reviewer
  always-on, tool-less by default; usage attributed to `reviewer`/`finalizer`.
- `runStep`: durable `nextSeq` + `inFlightStep {seq, step, attempt}` persisted
  BEFORE execute (`attempt` bumped pre-execute → durable bound; advance `nextSeq`
  only on commit; `failed` keeps `seq` and replaces `inFlightStep` with the
  revised step + `attempt+1`) → planner-agnostic stable `seq`; on resume, ADOPT an
  existing approved artifact at `(runId, seq)` instead of re-running; executor
  result held in memory → reviewer → **single** `writeArtifact` post-review; reads
  dedup `(runId, seq)` by outcome precedence (bounded over-fetch `k×(maxStepAttempts+1)`).
- Per-`requires` recall queries → evidence map for the reviewer.
- Planner outcome `advanced|failed|partial`; `commit()`/`next()` handle `partial`
  (advance accepted + replan remainder); `lastOutcome` type extended.
- New budgets `maxStepAttempts` (durable per-step attempt cap — bounds dups +
  crash-loop liveness), `maxReviewRetries`, `maxFinalizeRetries`; judge-failure
  escalation (abort-with-control-error, not silent advance/fail);
  `onFinalizeExhausted: error|best-effort` (default `error`).
- `plannerPrivate += {seq, status, note, remainder}` (payload-free), not content.
- Single finalizer after `done` for BOTH planners, reading run-scoped approved
  results (deduped) under the budget; `done` carries no answer.
- `SessionBundle`: durable `runId` (also the resume token) + run-state +
  `nextSeq` + `inFlightStep` + durable `originalRequest` (finalizer input; its
  normalized hash is the identity fingerprint) + atomic run-scoped RESET +
  crash-recovery classification (token/fingerprint, not raw equality); persist
  full suspended-step state in the external-tool `PendingMarker`. `plannerPrivate`
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
