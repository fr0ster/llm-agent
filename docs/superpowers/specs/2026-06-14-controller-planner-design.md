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

**Raw-token ingress (transient, never persisted by the producer).** For a
tool-paginated discovery the reviewer/executor return value carries a SEPARATE
**transient `rawContinuationToken`** field — IN-MEMORY only, distinct from the
persisted `DiscoveryDigest.continuation` (which holds only `{settleRef, tokenHash}`).
The controller is the ONLY component that touches the raw token, in an ORDERED,
crash-recoverable sequence (NOT one atomic op — the durable writes are distinct and
the crash windows between them are handled in §D): (a) compute the deterministic
`settleRef` + `tokenHash`; (b) write the secret-class **`settle-envelope`** — the
COMPLETE reviewer output `{status, approved, remainder, note, digest, items,
rawNextPageToken?}` keyed by `settleRef` FIRST; (c) DERIVE the `enumeration`
artifact and the page `step-result` from it. A crash after (b) is recoverable — the
deterministic `settleRef` re-reads the envelope and the settle is re-derived with NO
re-review (§D). There is ONE secret record (the envelope) — no separate `page-token`
write to collide at the key. The producer (reviewer/executor) NEVER writes the raw
token to a board/intent/log/indexed artifact — only via the transient field,
dropped after step (b).

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
  continuation (`artifact-offset` → the `enumeration` artifact; `tool` → the raw
  token in the durable `settle-envelope`, §D), windows it, and passes the
  bounded window to the planner. So neither an `enumeration` offset nor a `tool`
  token can be lost to board compaction — both live in durable, out-of-bundle
  stores (the `enumeration` artifact; the `settle-envelope` (its dedicated secret store), NOT an indexed artifact), never in the compactable board.

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
  | { kind: 'tool'; settleRef: string; tokenHash: string }            // CONTROLLER schedules a follow-up page executor step (no planner call); settleRef (= producing page's settle-envelope key) + tokenHash are durable non-secret locators; raw token lives only inside that settle-envelope
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
- **`tool` (only when the source itself paginates).** A tool-paginated discovery
  page is captured by a SINGLE durable secret record — the **`settle-envelope`** —
  in a DEDICATED secret namespace (NOT the LWW `SessionBundle`; NOT a board/plan
  artifact; NOT the semantically-indexed `KnowledgeBackend` — a render/log ban is
  not enough, an ordinary artifact could be embedded/RAG-queried/diagnostic-surfaced;
  the namespace is non-indexed, access-policied, controller-only — or encrypted).
  There is **NO separate `page-token` record** (that would collide at the same key
  and overwrite this one); the raw token is a FIELD of this single tagged record.
  - **`pageIndex` convention (fixed, used identically everywhere):** the settle of
    page `p` produces page `p`'s data and (optionally) a token OPENING page `p+1`.
    The `settle-envelope` is keyed by the PRODUCING page `p` (`settleRef` uses `p`);
    the `page` decision / page `stepId` for the page the token OPENS use
    `nextPageIndex = p + 1`, and that page decision references its parent's
    `settleRef` (= `p`'s) to read the token. Page 0 is the initial discovery (no
    token opened it).
  - **Identity = a DETERMINISTIC key (recovery needs no hash); ONE record per page
    settle.** The `settle-envelope` is keyed by **`settleRef = uuidv5(runId,
    discoveryChainId, pageIndex, attempt)`** (the producing page) — computable at
    recovery from the chain position + the claim-fixed attempt, WITHOUT the token or
    hash. A retry has a different `attempt` ⇒ a different `settleRef` ⇒ its OWN
    record (retries disambiguated by the key). The next page (`p+1`) dereferences its
    PARENT's `settleRef` to read the token; its `page` decision + the parent's
    `step-result` `continuation` carry `{ settleRef (= parent's), tokenHash }` —
    `tokenHash` is a VERIFICATION field (deref `settleRef`, check the stored hash),
    NOT the locator.
  - **The envelope holds the COMPLETE reviewer settle output — a token alone is not
    enough.** Recovery must rebuild not just the enumeration but the FULL
    `step-result`, so the envelope payload is the entire reviewer output:
    `{ status, approved (full content), remainder, note, digest, items,
    rawNextPageToken? }`. From it the controller DERIVES the `enumeration` artifact
    and the page `step-result` (`approved`→RAG, `digest`→board, continuation). A
    crash any time AFTER the envelope → resume
    the settle deterministically FROM the envelope (re-derive all three; idempotent;
    NO re-review of a possibly single-use cursor). Only a crash BEFORE the envelope
    re-runs discovery; if a single-use cursor cannot be reproduced there, the page
    settles a **fail-loud terminal** (`failed`), never a tokenless tool call.

  **Durable write order (fixed) — full settle captured FIRST, next page only after
  page-complete (capacity-gated, §B):**
  1. **`settle-envelope`** (secret-class, key = deterministic `settleRef`) — the
     COMPLETE reviewer output `{status, approved, remainder, note, digest, items,
     rawNextPageToken?}`. The single recovery source (no separate `page-token`).
  2. derive the `enumeration` artifact from the envelope.
  3. derive the current page's **`step-result`** (`approved`/`remainder`/`note`/
     `status` + `digest`) carrying the sanitized continuation
     `{ settleRef, tokenHash }` for the next page (durable continuation lives HERE).
  4. expand windows for THIS page are all **EMITTED** covering its enumeration to
     the end → the page is **page-complete** (the §E locked definition:
     page-complete = expand decisions cover the enumeration; it is about EMISSION,
     not the settling of every spawned step). The capacity gate only PACES emission
     (the next window waits for `activeCount` to free), but page-complete itself is
     emission coverage — the next page is scheduled once all of this page's windows
     are emitted, NOT after all their fanned-out steps settle.
  5. ONLY THEN, if the continuation is a `tool` token, the next
     `plan-decision{kind:'page'}` (refs the parent's `{settleRef, tokenHash}`) →
     `step-start` claim → durable `inFlightStep` → dispatch (reads the token from
     the parent's `settle-envelope`).

  Recovery splits at the `settle-envelope` write (step 1), NOT at the `step-result`:
  - **Crash BEFORE step 1** (no envelope yet) → nothing durable for this page;
    re-run discovery, and if a single-use cursor cannot be reproduced → fail-loud.
  - **Crash AFTER step 1, BEFORE the `step-result`** (steps 2–3) → the envelope
    EXISTS at the deterministic `settleRef`; the controller `get`s it and re-derives
    the `enumeration` and full `step-result` from its captured
    {items, digest, verdict, rawToken} — **NO re-review** of the cursor (the full
    settle was captured).
  - **Crash after the `step-result`** → continuation is durable; the next page is
    recoverable. The next page is NEVER scheduled before this page is page-complete.
  Recovery per crash window for the next-page scheduling tail: (a) continuation
  present, no page-decision → schedule it; (b) page-decision, no claim → claim; (c)
  claim, no in-flight → persist + dispatch; (d) in-flight → replay path. The
  follow-up page step is **controller-authored** with deterministic
  **`stepId = uuidv5(discoveryChainId, pageIndex)`** and **`decisionId = uuidv5(runId,
  'page', discoveryChainId, pageIndex, tokenHash)`** (the general `decisionId`
  formula's `anchorStepId / continuation / plannerOutput` do not apply).
  - **Canonical selection is PARENT-bound and the parent is CLAIM-FIXED (not
    precedence-recomputed).** A page decision carries its **`parent = {stepId, seq,
    attempt}`** — the PRIOR page's settle that emitted this token (its `settleRef`).
    Naively "filter to the precedence-canonical parent" is WRONG: precedence/
    `writeOrdinal` is not "the live parent token" — if parent `attempt 0 = ok`
    (token A) and a later `attempt 1 = ok` (token B) tie on rank, writeOrdinal would
    flip the canonical parent to B and retroactively make an ALREADY-CLAIMED page A
    ineligible. So the rule is the §F finality principle applied to the parent:
    **once a child page is `step-start`-claimed, its `parent` attempt is LOCKED**
    and never re-evaluated; a later retry of the parent discovery does NOT change an
    already-claimed page's parent. Consequently, **a settled discovery whose
    downstream (expand window or next page) has been claimed is FROZEN**, and this
    is enforced at the controller transition, not left to convention: a retry
    REQUEST for such a step is **rejected / no-op** (the general retry machinery may
    NOT mint a new `attempt` of a consumed `stepId`, which would change the board
    outcome out from under a claimed child). Genuinely new exploration starts a NEW
    chain (a fresh `discoveryStepId`), never a new attempt of the consumed step. For
    an as-yet-unclaimed next page, the parent is the claim-fixed lineage
    of the chain (the attempt whose token the chain has been consuming), not a
    precedence re-pick. So a page is always derived from the live, claim-fixed
    parent token — never silently re-pointed at a retry.

  **Secret-store contract (concrete, not "namespace-or-encrypted hand-wave").**
  The settle-envelope store is an injected dependency with a minimal interface —
  `put(sessionId, settleRef, value)`, `get(sessionId, settleRef) → value |
  undefined`, `deleteSession(sessionId)`. The LOCATOR is the deterministic
  `settleRef` ALONE (= `uuidv5(runId, discoveryChainId, pageIndex, attempt)` of the
  PRODUCING page — recovery-computable without the token/hash); the stored VALUE is
  the full settle output incl. `rawNextPageToken` + `tokenHash` (the hash is read
  back for verification, never used to locate).
  Requirements: (1)
  **durable** across process restart / bundle loss; (2) **never indexed** — it is
  NOT the semantic `KnowledgeBackend`, so values are never embedded/RAG-queried/
  surfaced by artifact or diagnostic APIs; (3) **session-scoped cleanup** — the
  server's `DELETE /v1/sessions/:id` and session GC MUST call `deleteSession` so
  tokens never outlive their session. **Production default = a durable DISK-backed
  store** (it MUST survive process restart — requirement (1)); an **in-memory impl
  is ONLY for tests / an explicit ephemeral mode**, never the production default
  (it would violate restart-durability). A deployment may swap an encrypted secret
  store behind the same interface. Wired into the controller deps alongside the
  `KnowledgeBackend`.

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

**A failed follow-up page gives the chain a TERMINAL outcome — it never hangs in
`expanding`.** If a follow-up page step settles `failed` (missing token, tool
error, retries exhausted), the chain does NOT stay `expanding` forever (terminal
page never reached). It transitions to a terminal chain outcome:
- **`partial`** (default) when ≥1 earlier page is page-complete: the already
  fanned-out work stands, and the controller routes a **replan** with a
  "pagination incomplete at page N (reason)" note in the digest, so the planner
  decides how to proceed with the partial enumeration (it knows what is missing).
- **`failed`** when NO page completed (the discovery produced nothing usable) →
  normal failed-step replan.
So chain states are `expanding | expanded | partial | failed`; a page failure
propagates to one of the terminal two, never an infinite `expanding`.

**The chain terminal is DURABLE, projected onto the ROOT discovery entry, with a
single idempotent replan.** A derived predicate alone is not enough — the
artifacts hold only the failed page step + prior decisions, so the terminal must
be written:
- The controller writes a **`chain-outcome` artifact** — `artifactType:
  'chain-outcome'`, payload `{ status:'partial'|'failed', failedPageStepId,
  attempt, failedPageIndex, note }`. It is the **idempotency TRIGGER** ("this chain
  owes exactly one replan"), and it is **WRITE-ONCE / FROZEN**: its `id = uuidv5(
  runId, discoveryChainId, failedPageStepId, attempt, status)` binds it to the
  canonical (claim-fixed lineage, §F) failed page, so a genuinely different terminal
  would have a different id; but a chain terminal, once written, is NOT mutated —
  an admin/recovery retry that would change the outcome must open a NEW chain, not
  rewrite this one.
  - **Canonical resolution (formal):** among `chain-outcome` artifacts for one
    `discoveryChainId`, the canonical one is the **FIRST written by deterministic
    order** — ascending `writeOrdinal`, tie-broken by ascending `id`. Because the
    terminal is FROZEN, every admissible duplicate must be byte-identical to it
    (idempotent re-write); a later artifact with a DIFFERENT `status`/`failedPage…`
    is a **contract violation** — it is inert (ignored — the first stands) and
    raises a loud diagnostic. (A legitimately different outcome must open a new
    chain, never a second terminal for this one.)
- **Board projection:** the chain terminal is shown on the ROOT discovery entry
  (`discoveryChainId` = page-0 `stepId`); its state becomes `partial`/`failed`, its
  digest carries `"pagination incomplete at page N (reason)"`. Per-page steps stay
  their own entries; the planner reads the chain terminal at the root.
- **Replan = AT-LEAST-ONCE planner invocation, EXACTLY-ONCE applied effect
  (trigger and decision are SEPARATE).** The deterministic part is the
  `chain-outcome` TRIGGER; the replan ITSELF is an ordinary
  `plan-decision{kind:'replan'}` that **carries `triggerId = chainOutcome.id` in
  its payload AND folds it into its `decisionId`** (`uuidv5(runId, 'replan',
  'trigger', triggerId, plannerOutput)` — same formula as the kind table in §F),
  and is keyed by a **trigger-specific slot
  `(runId, 'replan', 'trigger', triggerId)`** — NOT the failed-step replan slot
  `(runId, 'replan', 'anchor', anchorStepId)` (the `'anchor'`/`'trigger'`
  discriminator keeps the two slot kinds structurally distinct) — so hydrate
  unambiguously matches THIS replan to THIS chain-outcome and never confuses it
  with another replan of the same root step. Its `decisionId` is still
  a CONTENT hash (includes `plannerOutput`) — it cannot be output-independent, since
  two planner calls may emit different steps. The external LLM call and the durable write CANNOT
  be made atomic, so **exactly-once invocation is impossible**: a crash AFTER the
  planner responds but BEFORE the replan decision persists leaves the trigger with
  no decision, and the next hydrate re-CALLs. The honest guarantee is therefore:
  on hydrate, if a `plan-decision{replan}` referencing the trigger exists → done
  (no re-call); else re-call (possibly again). Multiple invocations are **deduped at
  the EFFECT level**: identical outputs collapse by content-hash `decisionId`, and
  when outputs differ the canonical selection (§F: first claim, else smallest
  `decisionId`) applies exactly one. So invocation is at-least-once; the APPLIED
  replan is exactly-once. (This is the same property as every planner decision —
  §F — never a fixed `decisionId` pretending to predate the LLM.)

The reviewer never FABRICATES a cursor: it either emits the structured enumeration
artifact (→ `artifact-offset`) or passes through a tool-native token (→ `tool`).
`truncated: true` WITHOUT a `continuation` is invalid (→ `partial`/replan). The
planner only fans out the window it is HANDED; the **CONTROLLER** then either
(artifact-offset) advances the offset locally and hands the next window, or (tool)
schedules the follow-up page executor step — until a digest returns `truncated:
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

DISCOVERY step only (sub-states of done — windowed fan-out / tool-pagination chain):
done(discovery) ──first window emitted──► expanding
                                            expanding ─┬─[chain fully-expanded: terminal page reached + all pages page-complete]─► expanded
                                                        ├─[follow-up page failed, ≥1 page complete]──────────────────────────────► partial  [→ one replan]
                                                        └─[follow-up page failed, no page complete]──────────────────────────────► failed   [→ replan]

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
- `expanding` (chain) ⇔ some page is not yet page-complete OR the terminal page is
  not reached, AND **no page has `failed`** (a failed page ends `expanding`).
- `expanded` (chain, fully) ⇔ terminal page reached AND all pages page-complete.
- `partial`/`failed` (chain, terminal) ⇔ a follow-up page `failed` (§D): `partial`
  if ≥1 page was page-complete (replan with the partial enumeration), else
  `failed`. So the chain always reaches a terminal state — never an infinite
  `expanding`.
- **Next within-page offset** = `prevOffset + prevWindow.len` (the ACTUAL recorded
  length, since windows are sized to available capacity — §D), while offset < page
  enumeration length, emitted under the §D capacity gate (idempotent — keyed by
  `(discoveryStepId, offset)`). When a page is page-complete AND it carried a
  next-page token, the controller instead schedules the follow-up discovery
  EXECUTOR step for the next page (§D), not another window.
Each `(discoveryStepId, offset)` window decision is emitted exactly once; the chain
transitions monotonically `done → expanding → {expanded | partial | failed}` — it
always reaches one of the three terminals (a failed follow-up page yields
`partial`/`failed` per §D), never an infinite `expanding`, and never a non-monotone
flap (no "expanded set exactly once" flag).

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
attempt-scoped resolution. Board reconstruction merges **FOUR sources** (the
fourth applies only to a discovery root entry):

1. **Structure** ← `plan-decision` artifacts (`stepId`, instructions, `slotId`).
2. **Terminal state** ← `step-result` artifacts (per-attempt; precedence-resolved
   among settled attempts) + digest.
3. **Transient state** ← `step-start` claim + the bundle's in-flight/`pending`
   (current-attempt `executing` / `awaiting-external`).
4. **Chain terminal** ← `chain-outcome` artifact, projected onto the ROOT discovery
   entry: it sets that entry's state to `partial`/`failed` and supplies the
   "pagination incomplete…" digest. **Full precedence for a discovery-root entry:
   `chain-outcome (4) > step-result (2) > transient (3) > structure (1)`** — a
   present `chain-outcome` OUTRANKS even the root's own `done` `step-result` (page 0
   settled `done`, but the CHAIN terminated `partial`/`failed`, and the chain
   terminal is what the planner must act on). For every NON-root entry source 4 is
   absent and the normal `(2) > (3) > (1)` precedence (above) applies.

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
transition as today. What becomes **additionally artifact-backed** is the BOARD
projection — the plan STRUCTURE and the step OUTCOMES — PLUS the small set of
durable execution data that recovery needs out-of-bundle: the `enumeration`
artifacts and the **`settle-envelope` records** (§D). (So it is not "only the
board": page tokens are artifact-backed execution state in a dedicated secret
namespace — the bundle remains authoritative for transcript/budgets/phase/etc.,
but the continuation secrets must survive a lost bundle, hence they are durable
out-of-bundle.) A torn plan/board write is thus recoverable:

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
steps + `stepId`s unrecoverable. `artifactType: 'plan-decision'`. The payload and
the `decisionId`/`slotId` keys are **KIND-SPECIFIC** (a single universal
`anchorStepId` formula is wrong — a chain-driven replan keys on `triggerId`, a page
on `discoveryChainId`). Every kind shares `{ kind, steps[] }` (each step: `stepId`,
`instructions`, `discovery?`, `supersedesStepId?`, fan-out `item.id`); the
kind-specific key fields and `decisionId`/`slotId`:

| kind | key fields in payload | `decisionId = uuidv5(...)` | `slotId` |
|------|----------------------|----------------------------|----------|
| `create` | — | `(runId,'create',plannerOutput)` | `(runId,'create')` |
| `replan` (failed step) | `anchorStepId` | `(runId,'replan','anchor',anchorStepId,plannerOutput)` | `(runId,'replan','anchor',anchorStepId)` |
| `replan` (chain-driven) | `triggerId` (= `chainOutcome.id`) | `(runId,'replan','trigger',triggerId,plannerOutput)` | `(runId,'replan','trigger',triggerId)` |
| `expand` | `discoveryStepId`, `continuation{offset,len}` | `(runId,'expand',discoveryStepId,offset,plannerOutput)` | `(runId,'expand',discoveryStepId,offset)` |
| `page` | `discoveryChainId`, `pageIndex`, parent's `{settleRef,tokenHash}`, `parent` | `(runId,'page',discoveryChainId,pageIndex,tokenHash)` | `(runId,'page',discoveryChainId,pageIndex)` |

`plannerOutput` is included for LLM-authored kinds (create/replan/expand — content
hash, §F) and ABSENT for the controller-authored `page` (deterministic). For a
`page` the raw token is NEVER in the payload — only the parent's `{settleRef,
tokenHash}`; the raw token lives in that parent `settle-envelope` (§D).

**Finality is fixed by EXECUTION, not by a hash race.** An executed step is
IMMUTABLE — the executed prefix of the plan is never rewritten. A new planner
decision is computed FORWARD from the board (it reads the digests of already-`done`
steps — "what is done" — and only appends or replaces NOT-yet-executed work; a
pure-retry keeps identity, a replacement uses a new `stepId` + `supersedesStepId`).
So a later decision can never overwrite a step whose outcome already committed.
The only ambiguity is the narrow window where two decisions for the same
not-yet-executed slot exist (a crash/re-call before any of their steps ran) — and
there NO history is at stake, so a deterministic pick is safe:

- A decision carries a content-hash `decisionId` computed from its **kind-specific
  key fields** (the per-kind formulas are tabulated above — e.g. `anchorStepId` for
  a failed-step replan, `triggerId` for a chain-driven replan, `discoveryStepId`+
  `offset` for an expand — NOT a single universal `anchorStepId` form). For
  LLM-authored kinds the hash includes `plannerOutput`: identical output → identical
  id (dedup); different output → different id. **Planner INVOCATION is at-least-once**
  (the external LLM call cannot be atomic with the durable write — a crash after
  the LLM responds but before the decision persists re-calls on hydrate); the
  content-hash `decisionId` + the canonical selection below make the APPLIED effect
  exactly-once regardless of how many times the LLM ran.
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
  - replan → `slotId = (runId, 'replan', 'anchor', anchorStepId)` for a failed-step
    replan; `slotId = (runId, 'replan', 'trigger', triggerId)` for a
    chain-outcome-driven replan — the explicit `'anchor'`/`'trigger'` discriminator
    segment keeps the two slot KINDS structurally distinct (both otherwise end in a
    UUID/string), so merge/typing never conflates their origin;
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
discovery done ──► CONTROLLER windows the durable ENUMERATION (≤maxFanOut)
               ──► hands the item window to the planner (expand-remainder) ──► planner fans out ──► plan-decision{expand,offset}
page-complete + next-page TOKEN ──► CONTROLLER schedules a follow-up PAGE executor step (token deref'd; NO planner call)
                                ──► that page yields the next enumeration ──► (windows resume as above)
```

## Components & boundaries

- **`outcome.ts` / reviewer** — the verdict gains a `digest` field (and, for
  discovery, a structured `enumeration`) that the reviewer RETURNS; the reviewer
  does NOT persist — the controller does (boundary preserved).
- **Step-state board** — a structured projection rendered into the planner prompt
  (replaces the payload-free `plannerPrivate` blob), merged from FOUR sources
  with the attempt-scoped resolution of §F: (1) `plan-decision` artifacts
  (structure) + (2) `step-result` artifacts (terminal state + digest) + (3) the
  `step-start` claim and the bundle's in-flight/`pending` (the TRANSIENT states
  `executing` / `awaiting-external` — do NOT omit these; a board without source 3
  cannot show a live or blocked step) + (4) the `chain-outcome` artifact, which
  projects a tool-pagination chain's `partial`/`failed` terminal (+ digest) onto
  the ROOT discovery entry. **Precedence for a discovery-root entry: chain-outcome
  (4) > step-result (2) > transient (3) > structure (1)** — a chain-outcome
  overrides even the root's own `done` step-result (§F); non-root entries use
  `(2) > (3) > (1)`. The BOARD portion of the bundle is a derived cache; MOST
  run-EXECUTION state (budgets, phase, transcript, resume counters, `pending`,
  `toolCallCount`) lives authoritatively in the SessionBundle — BUT the durable
  continuation execution state (the `enumeration` artifacts and `settle-envelope` secret records) lives OUT-OF-BUNDLE so it survives a lost snapshot (§F). The projection
  is EXTENSIBLE — further sources/states may be added as the system grows (the four
  above are the current set, not a closed limit).
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
  `step-result` artifacts (§F). The board portion of the bundle is thereby a
  derived cache; MOST run-execution state still lives in the bundle, EXCEPT the
  durable continuation state (`enumeration` artifacts + `settle-envelope` secret records) which is out-of-bundle so it survives a lost snapshot (§F).
- **`enumeration` artifact** — a new run-scoped artifact holding a discovery
  step's canonical `{id,label}[]` list (deterministic `enumerationId =
  uuidv5(runId,discoveryStepId,seq,attempt)`), windowed locally by the controller
  for `artifact-offset` continuation (§D).
- **`chain-outcome` artifact** — a new run-scoped, WRITE-ONCE artifact recording a
  tool-pagination chain's TERMINAL result (`id = uuidv5(runId, discoveryChainId,
  failedPageStepId, attempt, status)`, payload `{status:'partial'|'failed',
  failedPageStepId, attempt, failedPageIndex, note}`); the idempotency TRIGGER for
  the chain's single replan, projected onto the root discovery board entry. The
  replan it drives is an ordinary content-hashed `plan-decision{replan}` (§D).
- **`settle-envelope`** — the SINGLE secret-class durable record per discovery-page
  settle (there is NO separate `page-token` record — that would collide at the key).
  Keyed by the DETERMINISTIC **`settleRef = uuidv5(runId, discoveryChainId,
  pageIndex, attempt)`** (the PRODUCING page; recovery-computable without the
  token/hash; retries differ by `attempt`). Payload = the COMPLETE reviewer output
  `{status, approved, remainder, note, digest, items, rawNextPageToken?, tokenHash?}`.
  Written FIRST; the `enumeration` artifact and the full page `step-result` are
  DERIVED from it, so a crash after it resumes the settle with NO re-review (§D).
  Lives in a **dedicated non-indexed, access-policied secret namespace**
  (controller-only read; NOT the semantically-indexed `KnowledgeBackend`, never
  embedded/RAG-queried/surfaced by diagnostics) — or an encrypted store — so a lost
  bundle never breaks dereference and the raw token cannot leak via indexing/APIs.
  The next page (`p+1`) dereferences its PARENT's `settleRef` to read the token.
- **Secret store (`put`/`get`/`deleteSession`)** — a NEW injected dependency
  backing the `settle-envelope` records: durable across restart, never indexed, and
  cleaned up on `DELETE /v1/sessions/:id` + session GC (so tokens never outlive
  their session). **Production default = durable disk-backed**; an in-memory impl
  is tests/ephemeral-only (does not meet restart-durability). Swappable for an
  encrypted store (§D).
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
  transitions monotonically `done → expanding → {expanded | partial | failed}` —
  including the failed-page branch (assert a failed follow-up page yields chain
  `partial`/`failed` + a `chain-outcome` artifact, NOT an infinite `expanding`).
- **Tool-pagination chain tests.** A multi-page discovery: (a) each follow-up page
  is a `plan-decision{kind:'page', discoveryChainId, pageIndex}` with deterministic
  `stepId = uuidv5(discoveryChainId, pageIndex)` AND `decisionId = uuidv5(runId,
  'page', discoveryChainId, pageIndex, tokenHash)`, and a `step-start` claim on slot
  `(runId,'page',discoveryChainId,pageIndex)`; (b) **terminal-page completion** —
  the chain reaches `fully-expanded` only after the page with NO next-page token is
  reached AND every page is page-complete (NOT at the first page's last window);
  (c) **deterministic page replay/dedup** — a crash before/after the page-decision
  write, or a duplicate scheduling, collapses by `decisionId` (stepId alone is
  insufficient), never losing or duplicating a page; (d) **token redaction +
  ingress** — the raw token reaches the controller ONLY via the transient
  `rawContinuationToken` return field (NOT inside the persisted `DiscoveryDigest`);
  the controller is the only writer (secret-store `put`), and the raw token NEVER
  appears in the rendered board / any `intent` / logs / the indexed
  `KnowledgeBackend` (assert absent from RAG/embedding/diagnostic surfaces); only
  `(settleRef, tokenHash)` are in board/plan artifacts and on the page's
  `step-result` continuation; (e) **retry disambiguation** — a retry of the
  producing page (different `attempt`) ⇒ a different deterministic `settleRef` ⇒ its
  OWN `settle-envelope`; the next page's decision dereferences its parent's
  `settleRef` and the stored `tokenHash` verifies the exact token; AND
  **single-record / no key collision** — assert NO separate `page-token` write
  exists at the same key (one tagged `settle-envelope` per page settle); (f)
  **crash-recovery / ordering** — write order `settle-envelope (FULL
  {status,approved,remainder,note,digest,items,rawNextPageToken?}) → derive
  enumeration + step-result{continuation:{settleRef,tokenHash}} → (this page's
  windows page-complete) → next page-decision → claim → in-flight → dispatch`:
  assert THREE windows — (i) crash BEFORE the envelope → nothing durable → re-run /
  fail-loud (no recovery promise); (ii) crash AFTER the envelope but BEFORE the
  `step-result` → resume the FULL settle from the envelope (re-derive enumeration +
  the complete step-result incl. `approved`/`remainder`/`note`, NO re-review of the
  cursor); (iii) crash after the `step-result` (bundle snapshot LOST) → recover
  `(settleRef,tokenHash)` from the durable continuation + envelope and schedule the
  next page. The next page is NEVER scheduled before the current page is
  page-complete (EMISSION); (g) **missing-token fail-loud** — a genuinely absent record → the page
  step settles `failed` with a clear reason (no tokenless tool call, no silent
  stall); (h) **frozen-parent retry is REJECTED** — after page P is claimed on
  parent `attempt 0` (token A), issue a retry REQUEST for that parent discovery:
  assert the controller transition **rejects/no-ops it** — NO `attempt 1` step-result
  is minted, the parent outcome is unchanged, and P's parent stays `attempt 0`/token
  A. (A genuinely new exploration must open a NEW `discoveryChainId`, not a new
  attempt of the consumed step.)
- **Chain-failure / replan test.** A follow-up page that `failed` with ≥1 prior
  page complete → chain `partial`; a WRITE-ONCE `chain-outcome` artifact
  (`id=uuidv5(runId,discoveryChainId,failedPageStepId,attempt,status)`) is written
  and is NOT mutated by a later admin/recovery retry (which opens a new chain
  instead); the root discovery entry shows `partial` + the "pagination incomplete
  at page N" digest. **Replan is at-least-once invocation / exactly-once effect:**
  if a `plan-decision{replan}` referencing the trigger exists, hydrate does NOT
  re-call; if the trigger exists but no replan decision (crash before OR after the
  LLM responded but before the write), hydrate re-calls — assert the APPLIED replan
  is single (identical outputs dedup by content-hash `decisionId`; differing
  outputs collapse to the canonical one). The replan `decisionId` is a CONTENT hash
  (includes `plannerOutput`), not a fixed chain-only id.
- **Trigger-namespace contract.** Assert the chain-driven replan decision's payload
  carries `triggerId = chainOutcome.id`, its `decisionId` is
  `uuidv5(runId,'replan','trigger',triggerId,plannerOutput)`, and its `slotId` is
  `(runId,'replan','trigger',triggerId)`; and that this slot does NOT collide with a
  failed-step replan of the SAME root step (`(runId,'replan','anchor',anchorStepId)`)
  — the two coexist as distinct slots, neither shadowing the other.
- **Chain-outcome contention/replay.** Two `chain-outcome` artifacts for one
  `discoveryChainId`: an identical duplicate is idempotent (first-by-`writeOrdinal`,
  tie-broken by `id`, wins); a DIVERGENT second (different `status`/`failedPageIndex`)
  is inert (the first stands) and raises a loud diagnostic — the terminal is frozen,
  a real different outcome must open a new chain.
- **Root precedence: chain-outcome over root step-result.** The root discovery
  step's page 0 settled `done` (a `step-result` exists), AND a `chain-outcome`
  `partial` exists. On hydrate, assert the root entry projects to **`partial`** (the
  chain terminal), NOT `done` — i.e. source 4 outranks source 2 for the root entry
  (and the planner therefore sees the pagination-incomplete digest, not a false
  "done").
- **Secret-store cleanup tests.** Assert `DELETE /v1/sessions/:id` AND the actual
  session-GC path both call `secretStore.deleteSession(sessionId)` (page tokens do
  not outlive the session); and a reused `sessionId` never reads a prior session's
  token records.
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
