# Controller: Execution-Result Control & Data Backbone — Design

**Status:** active design (controller pipeline; applies to read AND write tasks).

**Builds on:** the merged controller work (plan-by-intent + per-step tool
selection, `bde840e6`; scope-discipline, `cc5ccc43`) and the design in
`2026-06-09-controller-planner-gnosticization-design.md` (this spec details the
"execution-result control" / verification piece that doc left open).

## Problem

Live experiments on a real SAP/ABAP system surfaced four coupled weaknesses in
how the controller moves and controls step results:

1. **Soft-failure passes undetected.** The step outcome is decided purely by the
   subagent result *kind*: `res.kind === 'content'` ⇒ `advanced` (success),
   `'error'` ⇒ retry/`failed`. So when the executor *narrates* a failure as
   content ("activation failed as expected, saved inactive"), the step is marked
   succeeded, no replan fires, and the run confabulates "done" while objects are
   left broken. (Forced wrong-order DDIC test: adaptive obeyed the order, the
   activation failures were narrated as content, 2 of 3 objects left inactive,
   answer said "successfully activated".)
2. **Context bloat.** `bundle.plannerPrivate` (the planner's progress context)
   accumulates the FULL `res.content` of every step — including the raw data the
   executor read from MCP (whole dump feeds, full source). The expensive planner
   model's context fills with payload it does not need to plan. (dumps/CDS runs.)
3. **Inter-step data hand-off is best-effort.** A step that consumes a prior
   step's output gets it only via the executor's per-step semantic recall
   (`resolveNeed` top-K over the session RAG, keyed by the step instructions).
   There is no guaranteed hand-off; if the prior result is not in the top-K, the
   step lacks its input.
4. **Synthesis needs everything.** A report/finalizer step must compose from ALL
   gathered results; top-K semantic recall is the wrong access mode for it.

A deeper constraint frames the solution: the engine is **MCP/domain-agnostic**.
It cannot know domain object identities (class/domain/table are SAP specifics),
so it must NOT try to deterministically key results by `(object_type, name)` —
that binds the core to a provider and tries to determinize what cannot be
determinized agnostically.

## Principles

- **Agnostic, semantic, best-effort.** Results are retrieved by SEMANTIC search
  keyed on the natural-language step prompt — not by structured provider-bound
  handles. We do not determinize the non-determinizable; the safety net for a
  miss is error escalation → replan, not a key scheme.
- **Data lives in RAG; the planner holds only control state.** Full results go to
  the session results-RAG. The planner's context holds a CONCISE per-step outcome
  log only.
- **The LLM decides; the controller does not orchestrate fallback.** Each step,
  the executor is given BOTH the recalled prior results AND the relevant tools.
  Whether to use in-context data or call a tool is the executor LLM's choice. The
  "don't re-fetch what's already in context" saving is emergent, not enforced.
- **Idempotency belongs to the tool, not the controller.** The controller does
  not track object identity; a create tool reporting "already exists" is the
  idempotency signal, surfaced as the step outcome.
- **Plan by intent.** The planner names objects/data in plain language (good
  recall keys); it never names tools (the executor binds them per step).

## Components

Two distinct RAGs already exist and are kept separate:

- **results-RAG** — the per-session knowledge store (`knowledgeRagFor`). Every
  step writes its full result here (`writeArtifact`, `artifactType: 'step-result'`
  / `'mcp-result'`).
- **tool-RAG** — the vectorized MCP catalog (`toolsRag`); `selectTools` returns
  the top-K tools relevant to the step.

Plus:

- **Planner control-context** — `bundle.plannerPrivate`: a concise, per-step
  outcome log the planner reads when (re)planning. NOT the data store.

## Data flow (the loop)

```
plannerPrivate (concise outcome log)  →  planner (re)plans, writes the next step
                                          referencing needed prior outputs in
                                          plain language (a good recall key)
                                                         │
                                                         ▼
per step the executor is given:  recall(results-RAG, step prompt)  +  selectTools(tool-RAG, step prompt)
                                                         │ (LLM decides: use in-context data, or call a tool)
                                                         ▼
executor returns TWO things:  full content → results-RAG (writeArtifact)
                              concise outcome {status, note} → plannerPrivate
```

- **executor of a later step** pulls its inputs from results-RAG by semantic
  recall on its own (planner-written) step prompt.
- **finalizer** reads the FULL set of step-results from results-RAG (see access
  modes) — NOT `plannerPrivate` (which is now concise).

## Step prompt (planner output)

Unchanged shape (plan-by-intent), with one discipline: a step that depends on a
prior step's output must **explicitly reference that output in natural language**
("analyze the report code generated earlier", "use the structure of table X
fetched above") so the executor's semantic recall reliably surfaces it. No
structured handles, no tool names.

## Outcome schema (executor → planner control-context)

The executor returns, alongside its full content, a **concise generic** outcome:

```
{ status: 'ok' | 'exists' | 'failed' | 'partial', note: '<short, payload-free>' }
```

- `status` is **generic** (no provider/object fields) — keeps the core agnostic.
- `note` is a short prose line; it must NOT echo the data the executor read from
  a tool (no dump rows, no source). "What object" lives in the note / the step
  prompt, not in a structured key.
- Only this concise outcome enters `plannerPrivate`; the full content goes to
  results-RAG.

## results-RAG access modes

- **Per-step recall (executor):** semantic top-K over the session results-RAG,
  keyed by the step prompt. For loose context AND for inter-step hand-off (the
  step prompt references what it needs).
- **Full list (finalizer):** the COMPLETE set of the session's step-results
  (a list, not a semantic query) — synthesis must not lose anything.

(No exact-by-handle mode: handles were rejected as provider-binding /
non-agnostic. Reliability of the semantic hand-off comes from the planner
writing explicit references; misses fall through to error escalation.)

## Idempotency

The controller does not dedupe steps or track object existence. A re-issued
create that targets an existing object is tolerated: the create **tool** reports
"already exists" → the executor returns `status: 'exists'` → the planner sees it
in the control log and does not re-create. Differently-phrased "create X" steps
are NOT deduplicated by the controller (impossible agnostically); the tool's
"exists" signal + error handling absorb the consequence.

## Failure handling & control

- **Soft-failure fix:** the step outcome is decided by the executor's reported
  `status`, NOT by `res.kind` alone. A narrated failure now carries
  `status: 'failed'` → flips `lastOutcome` → adaptive replans (incremental
  re-decides). This closes the "any content = advanced" gap. (Trade-off: status
  is executor-self-reported — LLM-dependent, but strictly better than ignoring
  the content.)
- **Recall miss / conflict:** if semantic recall did not surface a needed input,
  the executor lacks its input → returns `failed` → escalation → replan. The
  error path is the safety net for best-effort recall.
- **Optional verifier (V2-reviewer):** for complex / high-stakes / WRITE tasks, a
  capable model verifies the result against the step's intent before `advanced`
  (reads the result, judges success). Opt-in; not on by default.

## What changes vs the current code

- `runStep`: executor returns `{ status, note }` + full content; outcome derives
  from `status` (not only `res.kind`). `writeArtifact(full content)` stays.
- `plannerPrivate += '[step …] ' + res.content` → `+= '[step …] ' + concise
  outcome` (status + note), payload-free.
- Executor system prompt: "report a concise outcome (status + short note); do NOT
  echo the data you read from a tool."
- Finalizer: read full step-results from results-RAG (full-list), not
  `plannerPrivate`.
- Per-step recall (`resolveNeed`) and tool selection (`selectTools`) already run
  per step — keep both, surface both to the executor, let the LLM decide.
- Add a full-list read of the session's step-results for the finalizer.

## Empirical basis

- Forced wrong-order DDIC (domain/data-element/table): soft-failure passed
  undetected; adaptive obeyed the order and confabulated success with 2/3
  objects inactive; incremental survived by per-step foresight.
- Composition-coupled CDS: a HARD activation failure DID escalate → adaptive
  replanned and added mass-activation (recovery worked); incremental emitted
  invalid decisions and hit the parse-retry limit (clean give-up).
- Hello-world class write: correct code from all variants; the weak (gpt-4o-mini)
  executor flailed on create+activate (retry storm) — separate "target-model-aware
  planning" concern, see the related memory.

## Open questions

- Format of `note` — fully free prose vs a couple of optional hints; keep generic.
- Verifier scope: which task classes turn it on; cost budget.
- `plannerPrivate` growth on very long runs — summarize/bound the control log?
- Full-list finalizer: how it distinguishes report-relevant results from
  intermediate scaffolding in the complete set.

## Out of scope

- Target-model-aware step detail (more explicit steps for weaker executors) and
  per-step model routing (V3) — related, tracked separately.
- WRITE-specific eventual-consistency (retry-read-with-backoff) beyond the tool's
  own "exists" signal.
