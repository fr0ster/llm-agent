# Controller: Execution-Result Control & Data Backbone — Design

**Status:** active design (controller pipeline). READ + **idempotent** WRITE;
exactly-once non-idempotent side effects out of scope. NOT yet an implementation
plan — the contracts below (roles, run lifecycle, finalization, RAG metadata)
need review first.

**Builds on:** merged controller work (`bde840e6`, `cc5ccc43`) and
`2026-06-09-controller-planner-gnosticization-design.md`.

## Core idea: separate DOING from JUDGING

An LLM does not reliably grade its own work. So the step outcome is NOT the
executor's self-report — a **separate reviewer role** judges the executor's
result. Doing and judging are different roles, different calls, different
contexts.

Per step:

1. **Executor** — given the step (intent + `requires` manifest), the recalled
   inputs, and the relevant tools, does the work. Returns the **full result**
   (+ an optional short self-claim). Writes the full result → results-RAG. The
   executor does NOT decide success.
2. **Reviewer** — a separate role, given the step intent + the `requires` it
   should have used + the executor's result (and, when assurance matters, a
   verification read of actual state) → produces the **authoritative outcome**:
   `{ status: 'ok'|'exists'|'failed'|'partial', accepted: <what was achieved>,
   remainder: <what is still missing>, note }`.
3. **Controller** — maps the reviewer's `status` to advance/replan, writes the
   outcome to `plannerPrivate`, tags the RAG artifact, persists.

The reviewer is the control point that closes soft-failure ("executor narrated
'saved inactive' but the intent was create+activate" → reviewer returns
`partial`/`failed`), completeness, and missing-input detection. It is a capable
model; it is +1 call/step (cost knob: scope it to side-effecting/complex steps,
or run it always for full control — configurable).

## Roles

evaluator (request → goal) → planner (steps) → executor (does) → **reviewer
(judges)** → [loop] → finalizer (composes the answer after `done`).

## Run scope & lifecycle (durable runId)

`traceId` changes per leg; the session holds many requests. A controller **run**
(one user request, across suspend/resume legs) is scoped by a durable `runId`.

State machine on `SessionBundle`:

- **idle/terminal** — no active run (initial, or after a run completed/aborted).
- **active** — a run in progress (`runId` set, plan/cursor live).
- **suspended** — awaiting an external tool result or a clarify (`pending` set).

Transitions:

- **New request while idle/terminal:** atomically **RESET all run-scoped fields**
  (`goal`, `plan`, `planCursor`, `plannerPrivate`, `budgets`, `lastOutcome`,
  `pending`) and **mint a fresh `runId`** → active. (Fixes stale goal/plan/cursor
  carrying over.)
- **Resume while suspended:** keep `runId` and all run-scoped state.
- **Run reaches `done`** (finalizer composed) **or aborts:** → terminal; the next
  request triggers the reset above.

Run-scoped fields and their reset are defined as ONE atomic bundle write, so a
crash cannot leave a half-reset bundle.

## Data backbone

- **results-RAG** — per-session knowledge store. Every executor result is written
  with metadata `{ runId, seq, status, kind }` (`seq` monotonic per run; `status`
  from the reviewer; `kind` = step-result / mcp-result).
- **tool-RAG** — vectorized MCP catalog; `selectTools` top-K per step.
- **plannerPrivate** — concise control log: per-step `{seq, status, note}` only,
  payload-free.

### RAG contract changes (#5)

The current `KnowledgeEntryMetadata` / `KnowledgeFilter` carry no run/seq/status.
This design REQUIRES:

- `KnowledgeEntryMetadata` += `runId: string`, `seq: number`, `status: string`
  (or a generic `tags: Record<string,string|number>` to avoid churn).
- `KnowledgeFilter` += equality filter on `runId`/`status` and ordering by `seq`.
- Backend support: in-memory (trivial), qdrant/hana/pg (payload/where filter +
  order). Backends that cannot filter must fall back to fetch-then-filter
  (documented), so the contract holds everywhere.

## Access modes

- **Per-step recall (executor):** semantic top-K over results-RAG, keyed by the
  step prompt; scoped to the current `runId`. Plus `selectTools`. Both surfaced;
  the LLM decides data-vs-tool.
- **Full set (finalizer):** the run's results (`runId`, ordered by `seq`),
  `status ∈ {ok, exists, partial}` — see partial handling and budget below.

(No exact-by-handle mode — provider-binding, rejected.)

## Dependency manifest & miss detection (#6 — not self-eval)

The planner emits per dependent step `requires: ["<plain reference>", …]`.
Whether a required input is actually present is decided NOT by the executor
self-attesting, but by:

- **Controller-side evidence (primary):** for each `requires` reference, the
  recall step records whether it surfaced any artifact; the controller passes the
  reviewer the manifest + which references had evidence.
- **Reviewer judgement (secondary):** the reviewer, seeing intent + manifest +
  retrieved evidence + result, decides if the step actually had/used its inputs;
  a missing input → `failed` (note: "missing input: <ref>").

This is honestly **not fully deterministic** (semantic recall + LLM judgement),
but the decision is made by a role OTHER than the doer, with explicit evidence —
removing the self-evaluation bias. (Open question: a stricter controller-side
presence check.)

## Result handling

- **Executor → results-RAG:** full content, tagged `{runId, seq, status:pending}`
  (status filled by the reviewer).
- **Reviewer → plannerPrivate:** `{seq, status, note, remainder}` (payload-free);
  updates the artifact's `status` and stores `accepted`/`remainder` summaries.
- **Outcome mapping:** `ok`/`exists` → advance; `failed` → replan; **`partial`**
  → advance the ACCEPTED part, then replan for the `remainder` (see #3).

## Partial results (#3 — don't drop the accepted part)

`partial` must not be excluded from synthesis. The reviewer splits a partial
result into **accepted** (what was achieved — kept, contributes to the answer)
and **remainder** (what is still missing — drives a replan). The accepted portion
stays in results-RAG with `status:partial` and IS included by the finalizer; the
remainder is recorded in `plannerPrivate` so the planner plans only the missing
part. So "got 8 of 10, replan got 2" → finalizer sees both the 8 and the 2.

## Finalizer (#2 — unified, both planners)

Today only the adaptive planner has a finalizer call; the incremental planner
returns a `done.result` it built from `plannerPrivate`. Once `plannerPrivate`
holds only concise outcomes, incremental has no data to answer with. Fix:

- **A single finalizer stage runs after the planner returns `done`, for BOTH
  incremental and adaptive.** The planner's `done` no longer carries the answer;
  it only signals completion. The finalizer composes the answer from the
  **run-scoped full result set** in results-RAG.
- This unifies the two planners on one finalization path and one data source.

### Finalizer read policy (budget / ordering / truncation / overflow) (#6 prev)

- Token **budget** `B` (config); results ordered by `seq` (then request-relevance
  if available); per-result cap `C` (truncate-with-marker beyond `C`).
- **Overflow** (`Σ>B`): **map-reduce** — summarize largest/oldest results into
  compact extracts, then compose. Never silently drop; every reduction is logged.

## External-tool resume (#1 — persist the suspended step)

Re-entering the executor on an external-tool result needs the suspended execution
context, which the current `PendingMarker` (tool name/args + step name) does not
carry. The suspended state MUST persist:

- the **full `Step`** (name, instructions, `requires`, any model hint),
- the **message transcript** accumulated in the executor's tool loop up to
  suspension,
- the external `{toolName, args, extId, position}`.

On resume: rebuild the executor context from the persisted transcript, inject the
external result, **re-run the executor → reviewer** (the normal per-step path).
The external result thus gets the same review discipline; an external soft
failure becomes `status:'failed'` → replan (no bypass to `plannerPrivate`).

## Idempotency

Controller does not dedupe or track existence. Re-issued create → the tool
reports "already exists" → reviewer marks `exists` → advance. Update/delete/
activate idempotency is the tool's contract (see Durability).

## Durability & replay

Tool side-effect, `writeArtifact`, and `persistBundle` are separate ops →
**at-least-once**. READ replays are harmless. Side-effecting WRITE ops must be
**tool-idempotent** (create covered by "exists"; update/delete/activate are the
tool's contract). **Exactly-once for non-idempotent side effects is out of
scope** (separate WRITE-durability spec: side-effect journal / pre-commit
barrier). The replay window is a documented limitation here.

## What changes vs the current code

- New **reviewer** subagent role + per-step executor→reviewer flow; `runStep`
  outcome comes from the reviewer, not `res.kind`/self-report.
- `SessionBundle`: durable `runId`; explicit run state + atomic run-scoped RESET
  on a fresh request; persist full suspended-step state (Step + transcript) in
  the external-tool `PendingMarker`.
- `KnowledgeEntryMetadata` + `KnowledgeFilter`: `runId`/`seq`/`status` (or
  generic tags) + filter/order; backend filter or fetch-then-filter fallback.
- `writeArtifact`: tag `{runId, seq, status}`; reviewer updates `status` +
  accepted/remainder.
- `plannerPrivate += {seq, status, note}` (payload-free), not `res.content`.
- Single finalizer stage after `done` for BOTH planners, reading the run-scoped
  full set under the budget policy; `done` no longer carries the answer.
- Planner emits `requires` manifests; recall records per-reference evidence for
  the reviewer.

## Empirical basis

- Forced wrong-order DDIC: soft-failure undetected; adaptive confabulated success
  (2/3 inactive); incremental survived by foresight.
- Composition-coupled CDS: hard activation failure escalated → adaptive replanned
  with mass-activation; incremental hit the parse-retry limit (clean give-up).
- Hello-world write: correct code; weak executor flailed → target-model-aware
  planning (related, separate).

## Open questions

- Reviewer model/cost: always-on vs scoped to side-effecting/complex steps; can a
  cheaper model judge reliably; does the reviewer ever verify via a tool read.
- Stricter controller-side input-presence evidence (beyond semantic recall hit).
- Envelope/transcript size: persisting the executor transcript for resume can be
  large — bound/summarize it.
- Finalizer relevance ranking within budget; distinguishing report-relevant from
  scaffolding results.
- `plannerPrivate` growth on long runs.

## Out of scope

- Exactly-once / non-idempotent WRITE durability (separate spec).
- Target-model-aware step detail + per-step model routing (V3) — related,
  separate.
