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
  kind: 'step-result', runId, seq, status,        // final, from the reviewer
  content: approved,                              // reviewer-approved (full | accepted extract)
})
```

`plannerPrivate += { seq, status, note, remainder }` (payload-free). Nothing is
written before review; no record is mutated. (If a raw-vs-approved audit trail is
later wanted, that is an additional immutable record — out of scope now.)

**Crash/replay dedup (#1).** The artifact write and the cursor/bundle persist are
separate, so a crash between them replays the step and appends a SECOND artifact
for the same logical step. With an append-only store we cannot overwrite, so:
`seq` is the **stable step index** (the plan-cursor position), NOT a write
counter — a replayed step writes at the SAME `(runId, seq)`. Every read that
assembles results — finalizer full-set AND executor recall — **dedups by
`(runId, seq)`, keeping the latest write** (append/ingest order or a write
timestamp tie-breaker). So duplicates are tolerated in storage and collapsed at
read; the finalizer never sees two copies of one step.

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
  composes from the **run-scoped result set** in results-RAG.
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

- **New request while idle/terminal:** ONE atomic bundle write **resets all
  run-scoped fields** (`goal`, `plan`, `planCursor`, `plannerPrivate`, `budgets`,
  `lastOutcome`, `pending`, `originalRequest`) and **mints a fresh `runId`** →
  active. Fixes stale goal/plan/cursor carrying over.
- **Resume while suspended:** keep `runId` + all run-scoped state.
- **`done` (finalizer composed) or abort:** → terminal; next request resets.
- **Crash recovery — active with NO `pending` (#5):** a process crash mid-step
  leaves the bundle `active` but not `suspended`. The bundle persists the
  `originalRequest`; the next HTTP request is classified against it:
  - request **equals** `originalRequest` (a client retry of the same run) →
    **resume from the cursor** (re-run the in-flight step; at-least-once + the
    `(runId,seq)` dedup make replay safe for reads / idempotent writes);
  - request **differs** → the crashed run is **abandoned** (logged) → reset →
    fresh run for the new request.
  So an active-without-pending bundle is never ambiguous: it is recovered or
  explicitly abandoned, never silently continued under the wrong prompt.

## Data backbone & RAG contract changes (#5 prev)

- **results-RAG** — per-session store; each artifact tagged `{runId, seq,
  status}`. `KnowledgeEntryMetadata` += `runId/seq/status` (or a generic
  `tags` map); `KnowledgeFilter` += equality on `runId`/`status` + order by
  `seq`; backends filter natively or fall back to fetch-then-filter (documented).
- **tool-RAG** — `selectTools` top-K per step (executor only).
- **plannerPrivate** — concise control log `{seq, status, note, remainder}`.

**Access modes:** per-step recall (executor) = semantic top-K scoped to `runId`;
full set (finalizer) = run's approved results ordered by `seq` under the budget.

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
- **Finalizer error:** retry within `maxFinalizeRetries`; exhausted → return a
  control error, or a best-effort answer assembled from the already-approved
  results — never a confabulated completion.
- These are LLM/role faults; they go through the same usage metering but are
  attributed to `reviewer`/`finalizer`, not the executor.

## What changes vs the current code

- New `IReviewer` + `IFinalizer` interfaces; handler depends on them; the factory
  builds the default LLM impls from the `reviewer`/`finalizer` config. Reviewer
  always-on, tool-less by default; usage attributed to `reviewer`/`finalizer`.
- `runStep`: executor result held in memory → reviewer → **single** `writeArtifact`
  at stable `(runId, seq=stepIndex)` (post-review, final status, approved
  content); outcome from the reviewer; read-side dedup by `(runId, seq)`.
- Per-`requires` recall queries → evidence map for the reviewer.
- Planner outcome `advanced|failed|partial`; `commit()`/`next()` handle `partial`
  (advance accepted + replan remainder); `lastOutcome` type extended.
- New budgets `maxReviewRetries`, `maxFinalizeRetries`; judge-failure escalation
  (abort-with-control-error, not silent advance/fail).
- `plannerPrivate += {seq, status, note, remainder}` (payload-free), not content.
- Single finalizer after `done` for BOTH planners, reading run-scoped approved
  results (deduped) under the budget; `done` carries no answer.
- `SessionBundle`: durable `runId` + run-state + `originalRequest` + atomic
  run-scoped RESET + crash-recovery classification; persist full suspended-step
  state in the external-tool `PendingMarker`.
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
