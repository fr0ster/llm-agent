# Controller: Execution-Result Control & Data Backbone — Design

**Status:** active design (controller pipeline). Applies to READ tasks and
**idempotent** WRITE tasks; exactly-once non-idempotent side effects are out of
scope (see Durability & replay). NOT yet ready for an implementation plan —
result envelope, run scope, external resume and replay semantics are formalized
below but should be reviewed before planning.

**Builds on:** the merged controller work (plan-by-intent + per-step tool
selection, `bde840e6`; scope-discipline, `cc5ccc43`) and
`2026-06-09-controller-planner-gnosticization-design.md` (this spec details the
execution-result control / verification piece that doc left open).

## Problem

Live experiments on a real SAP/ABAP system surfaced coupled weaknesses in how
the controller moves and controls step results:

1. **Soft-failure passes undetected.** The outcome is decided by the subagent
   result *kind*: `content` ⇒ `advanced`, `error` ⇒ retry/`failed`. So when the
   executor *narrates* a failure as content ("activation failed, saved
   inactive"), the step is marked succeeded, no replan fires, and the run
   confabulates "done" with objects left broken.
2. **Context bloat.** `bundle.plannerPrivate` accumulates the FULL `res.content`
   of every step — including the raw data read from MCP (whole dump feeds, full
   source). The expensive planner's context fills with payload it never needs.
3. **Inter-step hand-off is best-effort.** A step consuming a prior step's output
   gets it only via per-step semantic recall (`resolveNeed` top-K, keyed by the
   step prompt). No hand-off guarantee, and the executor has no way to KNOW an
   expected input is missing → it may emit `ok` anyway.
4. **Synthesis needs everything.** A report/finalizer composes from ALL gathered
   results; top-K recall is the wrong access mode.

Framing constraint: the engine is **MCP/domain-agnostic** — it cannot know
domain object identities (class/domain/table are SAP specifics), so it must NOT
key results by `(object_type, name)`. We do not determinize the
non-determinizable; reliability comes from explicit references + miss DETECTION
+ error escalation, not from a key scheme.

## Principles

- **Agnostic, semantic, best-effort retrieval; deterministic miss-detection.**
  Results are retrieved by semantic search keyed on the natural-language step
  prompt — no provider-bound handles. A step declares the inputs it requires; the
  executor must DETECT and report a missing input (it never silently proceeds).
- **Data lives in RAG; the planner holds only control state.** Full results go to
  the results-RAG; the planner's context holds a concise per-step outcome log.
- **The LLM decides; no controller-side fallback.** Each step the executor gets
  BOTH the recalled prior results AND the relevant tools; using in-context data
  vs calling a tool is the LLM's choice (the "don't re-fetch" saving is emergent).
- **Idempotency belongs to the tool**, not the controller.
- **Plan by intent.** The planner names objects/data in plain language; never
  tools.

## Components

- **results-RAG** — per-session knowledge store (`knowledgeRagFor`). Every step
  writes its full result here, tagged with the run scope (below).
- **tool-RAG** — vectorized MCP catalog (`toolsRag`); `selectTools` returns
  top-K tools for the step.
- **Planner control-context** — `bundle.plannerPrivate`: a concise per-step
  outcome log (status + short note), NOT a data store.

## Run scope (durable runId)

`traceId` changes per request leg (and across suspend/resume), and the session
holds results from MANY user requests — so neither scopes "this run's results".
Introduce a **durable `runId`**:

- Minted when a fresh user request starts a controller run (no `pending`);
  stored in `SessionBundle.runId`; persisted with the bundle.
- **Reused on resume** (clarify / external-tool) — it survives suspend/resume,
  unlike `traceId`.
- Every step-result artifact is tagged `{ runId, seq, status }` (`seq` =
  monotonic per run; `status` from the outcome envelope).
- The finalizer reads results filtered by the **current `runId`** and
  `status ∈ {ok, exists}` (failed/partial attempts excluded, so retried/replanned
  steps don't pollute synthesis).

## Result envelope & protocol

`ISubagentClient` currently returns `SubagentResult` with a single `content`
string. The executor must instead return BOTH the full result AND a concise
generic outcome. Protocol:

- **Wire format.** The executor's reply body is the **full content**; it MUST end
  with a single final line:
  `STATUS {"status":"ok|exists|failed|partial","note":"<short, payload-free>"}`.
  (A trailing single-line marker avoids JSON-escaping a large payload, which a
  whole-envelope JSON would require.)
- **Parser.** Split off the last `STATUS {…}` line → parse the JSON →
  `{status, note}`; everything before it is the full content (→ results-RAG).
- **Validation.** `status` must be one of the enum; `note` ≤ ~200 chars and must
  not echo tool-read data.
- **Malformed / missing status.** Re-ask the executor ONCE (stern reminder).
  Still missing/unparsable ⇒ outcome `failed` — **never default to `ok`** (this is
  the whole point: undetected soft-failure must not survive).
- **Outcome mapping.** `ok` → `advanced`; `exists` → `advanced` (idempotent goal
  met); `failed` → `failed` (replan); `partial` → `failed` (replan to finish the
  remainder; `note` says what is left).
- **Hard errors** (`res.kind==='error'` / empty tool-call) keep the existing
  retry→`failed` path; the envelope covers the `content` path that today is
  blindly `advanced`.

The full content still goes to results-RAG (`writeArtifact`); only `{status,
note}` enters `plannerPrivate`.

## Step prompt + dependency manifest

Plan-by-intent shape, plus an explicit per-step **dependency manifest** so misses
are detected, not hoped away:

- The planner emits, with each step, `requires: [ "<plain-language reference to a
  prior output>", … ]` (e.g. "the report code generated earlier"). Plain text, no
  handles, no tool names.
- The executor is given the manifest AND its recalled context, and is INSTRUCTED:
  before doing the work, confirm each `requires` item is present in context; if
  any is ABSENT, return `status:'failed', note:'missing input: <ref>'` — do not
  proceed or fabricate.
- This makes the hand-off guarantee honest: retrieval stays best-effort (semantic
  top-K), but a **miss is deterministically DETECTED** (manifest check) → `failed`
  → escalation → replan (which can re-reference / re-fetch the input).

## Data backbone — access modes

- **Per-step recall (executor):** semantic top-K over results-RAG, keyed by the
  step prompt (loose context + manifest inputs). Both recall and tool selection
  run per step; both are surfaced to the executor; the LLM decides.
- **Full set (finalizer):** the run's results (`runId`, `status∈{ok,exists}`),
  ordered by `seq`. Governed by an explicit budget (next section).

(No exact-by-handle mode — rejected as provider-binding.)

## Finalizer read policy (budget / ordering / truncation / overflow)

The "full set" can re-overflow the finalizer with large dump/source payloads, so
it is NOT an unbounded dump:

- **Budget** `B` tokens for the finalizer input (config).
- **Ordering:** by `seq` (chronological); the request's directly-relevant results
  first when relevance is available.
- **Per-result cap** `C`: a result larger than `C` is truncated with a marker, or
  replaced by its `note` + a head/tail slice.
- **Overflow** (`Σ > B`): **map-reduce** — summarize the largest/oldest results
  into compact extracts, then compose; never silently drop. Every reduction is
  logged so coverage is auditable (no silent truncation reads as "covered all").

## Idempotency

The controller does not dedupe steps or track object existence. A re-issued
create targeting an existing object is tolerated: the create **tool** reports
"already exists" → executor returns `status:'exists'` → planner sees it and does
not re-create. Differently-phrased "create X" steps are NOT deduplicated by the
controller (impossible agnostically). This covers CREATE; update/delete/activate
idempotency is the tool's responsibility (see Durability & replay).

## Failure handling & control

- **Soft-failure fix:** outcome derives from the envelope `status`, not
  `res.kind` alone (closes "any content = advanced").
- **Missing input:** detected via the dependency manifest → `failed` → replan.
- **External-tool resume must NOT bypass the executor.** Today the external
  result is written straight to `plannerPrivate` and the planner replans, so an
  external SOFT failure never becomes `status:'failed'`. Fix: on resume, **re-enter
  the suspended step's executor** with the external result injected as context;
  the executor consumes it and produces the normal envelope ({status, note} +
  full content → RAG). External results thus get the same status discipline as
  any tool result; an external failure surfaces as `status:'failed'` → replan.
- **Optional verifier (V2-reviewer):** for complex / high-stakes / WRITE tasks, a
  capable model verifies the result against the step's intent before `advanced`.
  Opt-in.
- Trade-off: `status` is executor-self-reported (LLM-dependent), but strictly
  better than ignoring the content; the verifier raises assurance where it
  matters.

## Durability & replay (execution semantics)

Tool side-effect, `writeArtifact()` and `persistBundle()` (cursor commit) are
**separate** operations. A crash AFTER a tool effect but BEFORE the cursor commit
replays the step on resume. Therefore:

- **The controller is at-least-once.** READ steps replay harmlessly (idempotent
  reads).
- **Side-effecting (WRITE) steps must be tool-idempotent.** CREATE is covered by
  the tool's "already exists"; **update/delete/activate idempotency is the MCP
  tool/operation's contract**, not the controller's.
- **Exactly-once for non-idempotent side effects is OUT OF SCOPE here** — deferred
  to a dedicated WRITE-durability design (a side-effect journal / pre-commit
  barrier / two-phase mark). This spec's WRITE applicability is limited to
  idempotent operations; the replay window for non-idempotent ops is a known,
  documented limitation.

## What changes vs the current code

- `types.ts`: extend the executor result so `runStep` receives `{status, note}` +
  full content (parsed from the envelope), not a bare `content` string.
- `runStep`: parse the envelope; outcome from `status` (incl. malformed→`failed`,
  one re-ask); `writeArtifact(full content)` tagged `{runId, seq, status}`;
  `plannerPrivate += '[step …] ' + {status, note}` (payload-free).
- Executor system prompt: emit the `STATUS {…}` trailing line; verify the
  `requires` manifest and fail on a missing input; do not echo tool-read data.
- Planner: emit a `requires` manifest per dependent step (plain refs).
- `SessionBundle`: add durable `runId` (minted on fresh run, reused on resume).
- External-resume path (handler ~191): re-enter the suspended step's executor
  with the external result instead of writing straight to `plannerPrivate`.
- Finalizer: read the run-scoped full set from results-RAG under the budget
  policy, not from `plannerPrivate`.

## Empirical basis

- Forced wrong-order DDIC: soft-failure undetected; adaptive obeyed and
  confabulated success with 2/3 objects inactive; incremental survived by
  per-step foresight.
- Composition-coupled CDS: a HARD activation failure escalated → adaptive
  replanned with mass-activation; incremental emitted invalid decisions and hit
  the parse-retry limit (clean give-up).
- Hello-world class write: correct code from all variants; weak (gpt-4o-mini)
  executor flailed on create+activate — see "target-model-aware planning"
  (related, separate).

## Open questions

- Envelope marker robustness (a step whose content legitimately ends with a
  STATUS-looking line) — pick a low-collision marker / fenced block.
- Verifier scope & cost budget; which task classes enable it.
- `requires`-manifest presence check is itself semantic (the executor judging
  "is this input present?") — how strict; can it be made cheaper/more reliable.
- `plannerPrivate` growth on very long runs — summarize/bound the control log.
- Finalizer relevance ranking when the run has many results within budget.

## Out of scope

- Exactly-once / non-idempotent WRITE durability (separate WRITE-durability spec).
- Target-model-aware step detail and per-step model routing (V3) — related,
  tracked separately.
