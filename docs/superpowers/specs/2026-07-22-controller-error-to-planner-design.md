# Controller: tool errors reach the planner, which decides — or the consumer does

**Status:** design, pending review
**Branch:** `fix/issue-213-mcp-iserror` (extends PR #232 — the isError-propagation enabler)
**Relates:** #213 (root), #231 (adapter/wrapper isError, done in this PR)

## Problem

PR #232 threads the MCP tool-level `isError` from the wire to the trace and to
the live `ToolRound.meta`. External review (correctly) found this is only an
**enabler**, not a behavioural fix:

- the executor's view of a tool result is built by the context strategies
  (`window-context-strategy.ts`, `rag-recall-context-strategy.ts`), which replay
  `assistant + results` where a result is only `content: text` — **`meta` (with
  `isError`) never reaches the executor or planner**;
- the controller RagRecall writer (`pipelines/controller.ts`) persists
  `identityKey + content` but **not `isError`** — lost on recall/resume;
- **no default path branches on `round.meta.isError`.**

So for a delivered tool error (a locked SAP object), the executor/planner see
the same text as before and nothing acts on the failure. The #213 retry loop is
not yet fixed behaviourally.

## Design — who decides, and how

The principle (from the maintainer): the **consumer owns HOW they build a
pipeline**; WE provide (a) the seam to build one, and (b) **default
implementations that behave as intended**. For tool errors:

- **A planner exists (controller):** the **planner decides** — using its own LLM
  reasoning over the error text AND the consumer's prompt. It either fixes the
  failure within its degrees of freedom (replan) or, if it cannot, surfaces the
  error to the consumer.
- **No planner (flat/simple):** the error goes straight to the **consumer**.
- **We do NOT hardcode an error taxonomy.** There is no built-in "lock →
  retryable, auth → fatal" classifier. Either the planner (an LLM) classifies by
  reasoning, or we do not classify at all and report to the consumer.

### Degrees of freedom = the consumer's prompt

The "constraints" the planner respects are **implicit in the prompt** — there is
no separate constraints config. The planner reasons about what it may change:

- Consumer: *"create a CHAR domain length 40, description 'Test'"* (no name
  given) → tool error *"cannot create an object with name X"* → the name was
  chosen by us, so it is **fixable**: the planner replans with a new name
  (following any naming principle the consumer stated).
- Consumer: *"create domain ZD_YTEST …"* (name pinned) → same tool error → the
  name is the **consumer's constraint**; we cannot change it → the planner
  emits the new `error` decision and the failure goes to the consumer.

### Layer 1 — plumbing: make the failure visible to the planner

The planner decides from the board / step outcomes / `plannerPrivate`. The
failure reaches it deterministically, not through the LLM reviewer:

1. **Immediate cut at the callMcp site (chosen — no LLM in the loop).** The
   controller already observes `result.isError` at the callMcp site
   (`controller-coordinator-handler.ts`, where PR #232 records it). The **first**
   tool round in an attempt that returns `isError:true` **cuts the step
   immediately**: the executor tool-loop does NOT continue, the reviewer does
   NOT run for that step, and the step settles as `failed` with the failing
   tool's error text as the reason — reusing the existing control-failure
   settle path (`cutControlFailure`-style: `stepsUsed++`, `plannerPrivate` note,
   `settleStep('failed')`). The planner then sees a failed step + the error and
   decides.

   **Why immediate cut, not a delayed "attempt-has-error" flag.** The two are
   mutually exclusive and this spec picks immediate cut:

   - it directly stops the #213 loop — the executor never gets to retry the
     locked object or confabulate an "updated successfully" summary, because the
     tool-loop is cut on the first failed call;
   - it removes the LLM entirely from the failure decision — there is no
     executor summary and no reviewer verdict to override, so no "success can't
     rescue it" edge case exists (the delayed-flag approach would run the whole
     attempt and then discard it, wasting the calls and re-opening the exact
     confabulation window we are closing);
   - over-triggering is safe: if a step legitimately could have recovered from a
     tool error, cutting to `failed` simply hands the planner a `rewind`/replan
     opportunity — the planner recovers, no wrong final answer.

   No `Message` extension and no context-strategy `meta` replay are needed for
   the cut — it reads `result.isError` directly at the callMcp site before the
   round is handed to the context strategy.

2. **Durable recall carrier — the failed step-result + `plannerPrivate`, NOT the
   mcp-result.** The immediate cut settles via `settleStep('failed')`, which
   already writes a durable `step-result` artifact with `status:'failed'` + the
   tool error text, sets `bundle.lastOutcome='failed'`, and appends the failure
   to `bundle.plannerPrivate` — all durable. That IS the resume carrier: a run
   that crashes after the cut rehydrates a `failed` step and the planner sees it.

   The `mcp-result` artifact is deliberately NOT relied on here: under immediate
   cut the round may never reach `strategy.record(round)` (the RagRecall writer),
   so persisting `isError` on the `mcp-result` would be a carrier that sometimes
   isn't written. No new `KnowledgeEntryMetadata` field is needed — `Message` is
   unchanged, and the step-result/`plannerPrivate` the cut already writes carry
   the failure across resume. (PR #232's `round.meta.isError` remains for the
   live trace, but it is not the load-bearing durable carrier.)

### Layer 2 — the planner's new `error` decision

`NextStep` today is `next | done | rewind`. Add:

```ts
| { kind: 'error'; error: string }   // cannot proceed within the prompt's freedom → surface to consumer
```

- `rewind` stays "replan within the goal" (fix a name we chose, schedule a wait
  for a settling lock, …).
- `error` is new: the planner has seen a failure it cannot fix within the
  consumer's constraints (a pinned name that is taken, an unauthorized
  operation, a lock that will not clear) → the controller terminates the run and
  **returns the actual tool error to the consumer**, distinct from the generic
  `abortTerminal` reasons (budget exhausted, planner-invalid). The consumer gets
  the real failure, not `(no response)`.

**Canonical wire shape (single, enforced).** The planner emits exactly
`{ "kind": "error", "error": "<the failure, in the consumer's language>" }` —
the same discriminated shape as every other decision. A bare `{ "error": … }`
without `kind` is NOT accepted. The parser (`parser.ts`) recognises
`kind: 'error'` and rejects the bare/legacy shape; parser tests must cover both
the accepted shape and the rejected `{ "error": … }` (parses to `null` →
format failure → planner retries, exactly like a malformed `next`/`done`).

The plan-creation / replan prompt gains a rule teaching this reasoning: on a
tool failure, decide whether it is fixable within what the consumer asked; if
not, return `{ "kind": "error", "error": "<the failure, in the consumer's
language>" }`.

### Layer 3 — the consumer seam (the tool)

The consumer can override HOW errors are handled without forking:

- a consumer that wants different handling swaps the planner (already injectable)
  or its prompt/hint — the decision lives in the planner, so overriding the
  planner overrides the policy;
- a flat pipeline (no planner) surfaces the error to the consumer by default —
  the pipeline passes the tool error up rather than swallowing it.

No new strategy interface is added unless review shows the planner-override seam
is insufficient — the planner IS the decision seam (avoids a parallel
`IStepFailureStrategy` that would duplicate the planner's role).

## What this deliberately does NOT do

- No built-in error classifier (lock/auth/…): the planner reasons, or we defer
  to the consumer. Adding a taxonomy would be the hardcoded approach we rejected.
- No run-level tool-call ceiling / repeat-detector: rejected earlier as a
  workaround that masks the loop instead of removing its cause.

## Flat pipeline (no planner) — scope is honest, not over-claimed

The **deterministic** guarantee of this deliverable is **controller-only** (the
immediate cut above). The flat pipeline is LLM-driven: after a tool call it
feeds the tool result to the LLM, which writes the answer. We CANNOT
deterministically force that LLM to report failure from inside this deliverable
without an enforcement mechanism, and the reviewer is right that "the final
answer must reflect the failure" is not enforceable by merely passing a
`role:'tool'` message.

So flat's scope here is precise and limited:

- **What we guarantee:** the tool error is no longer *hidden*. With the #232
  wrapper/adapter fix the flat tool-loop no longer flattens a failed call into a
  false success — the round's `ToolRound.meta.isError` is set and the tool
  result **content** carries the real error text. The LLM sees that error
  **text** in the `role:'tool'` message content (it does NOT receive an `isError`
  field — `Message` has none, and `form()` replays only `assistant + results`).
  So the model is answering over a visible failure, not a fabricated success.
  That is the enabler, already in this PR.
- **What we do NOT add here:** a deterministic "the final answer must reflect
  the failure" enforcement. That belongs to the existing consumer seam
  `IOutputValidator` (a consumer that needs the guarantee plugs in a validator
  that rejects a success answer when a tool round failed) — NOT a new
  flat-specific mechanism baked into the default pipeline.
- **Rejected: raw-error bypass** (return the raw tool error as terminal output,
  no LLM). That converts flat from an LLM-answering pipeline into a
  pass-through — out of scope; a consumer who wants it builds it on the seam.

Rationale: forcing behaviour on an LLM-driven pipeline is exactly the consumer's
`HOW`, which the maintainer said the consumer owns. The default flat pipeline
makes the failure *visible*; deterministic *enforcement* is the consumer's via
`IOutputValidator`. The controller pipeline is where we ship the deterministic
default, because it has a planner to decide.

## Testing

- **immediate cut (no LLM in the decision):** the FIRST tool round returning
  `isError:true` settles the step as `failed` with the tool error text, sets
  `bundle.lastOutcome`, and appends the failure to `plannerPrivate` — asserted
  directly on the durable bundle. Assert with a spy that **no further tool call
  is made** after the failed one and that **the reviewer is NOT invoked** for
  that step (the executor tool-loop is cut);
- **confabulation cannot occur:** a mock executor that WOULD produce an
  "updated successfully" summary after a failed tool round never reaches that
  point — the step is already `failed` (proves the cut pre-empts the
  confabulation window, replacing the old "override reviewer ok" test which no
  longer applies under immediate cut);
- **resume carrier:** after a cut, the durable `step-result` (`status:'failed'`
  + error text), `bundle.lastOutcome='failed'`, and the `plannerPrivate` note
  survive persist + rehydrate, so a resumed run sees the failed step (asserted on
  the rehydrated bundle — NOT on an `mcp-result` artifact, which the cut may not
  write);
- **parser:** `{ "kind": "error", "error": "…" }` parses to the `error`
  decision; a bare `{ "error": "…" }` (no `kind`) parses to `null` → format
  failure → planner retries;
- the planner, given a failure it can fix within the prompt's freedom (a
  self-chosen name that is taken), replans; given a failure it cannot (a pinned
  name), returns the `error` decision;
- an `error` decision terminates the run and returns the tool's failure text to
  the consumer (NOT `(no response)`, NOT a generic abort reason);
- **flat (scoped):** with the #232 fix a flat tool-loop's failed round sets
  `ToolRound.meta.isError` and the tool result content carries the real error
  text (not a flattened false success) — asserted on the **internal**
  `ToolRound.meta` / the tool result content / logs, NOT on "the LLM receives
  `isError`" (it receives only the error text in the message content). This
  deliverable does NOT assert the LLM's final answer wording — deterministic
  enforcement is the `IOutputValidator` seam, out of scope here;
- a plan with no tool error behaves byte-identically (no regression).

## Architecture principles check

1. **Build on components** — reuses the planner as the decision point, the
   reviewer/board as the failure carrier, the existing terminal machinery for
   `error`; no bespoke error-handling engine.
2. **The app is the example** — default behaviour lands in the controller
   pipeline library.
3. **Interfaces** — the decision seam is the injectable planner; no parallel
   strategy interface unless proven necessary.
4. **ISP** — `NextStep` gains one variant; nothing else grows.
5. **Strategies / variation** — the consumer varies handling by swapping the
   planner (or its prompt); the flat default surfaces to the consumer.
7. **Don't break components** — `error` is additive; existing `next/done/rewind`
   unchanged; `isError` carriers are additive optional fields.
