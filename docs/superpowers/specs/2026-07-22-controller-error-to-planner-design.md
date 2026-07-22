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

The planner decides from the board / step outcomes / `plannerPrivate`, which are
fed by the reviewer's judgement of each step's result. Two carriers must stop
dropping the signal:

1. **The failure must become legible to the planner.** This is the crux and has
   three candidate mechanisms — the plan must pick one; recommendation noted:

   - **(a) controller marks the step failed on `isError` (deterministic).** When
     a tool round returns `isError:true` and the executor cannot produce a valid
     result from it, the controller records the step outcome as failed with the
     tool's error text, WITHOUT relying on the LLM reviewer to notice. The
     planner then sees a failed step + the error and decides. Robust against the
     executor confabulating a "success" summary (the exact #213 failure: a
     locked object reported as "updated successfully"). **Recommended.**
   - **(b) reviewer sees the round `isError`.** Feed the failed round's flag into
     the reviewer's evidence so its verdict reflects it. More LLM-dependent (the
     reviewer may still be talked into "ok").
   - **(c) executor stops and reports the error as its step result.** Requires
     the executor's tool-loop to break on `isError:true` — but the executor is
     an LLM and may keep trying; less deterministic.

   Under any choice, the context strategies and RagRecall writer must stop
   dropping `isError` (carry the flag on the replayed round + persist it), so
   whichever consumer reads it actually receives it. The plan nails the exact
   "cannot produce a valid result from it" condition for (a).
2. **Durable recall** — the RagRecall writer persists `isError` on the
   `mcp-result` artifact so a resumed run still knows the call failed.

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

The plan-creation / replan prompt gains a rule teaching this reasoning: on a
tool failure, decide whether it is fixable within what the consumer asked; if
not, return `{ "error": "<the failure, in the consumer's language>" }`.

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

## Testing

- a step whose tool call returns `isError:true` is legible to the reviewer as a
  failed step (not a delivered result) — asserted on the reviewer's evidence/verdict;
- `isError` survives a RagRecall persist + rehydrate;
- the planner, given a failure it can fix within the prompt's freedom (a
  self-chosen name that is taken), replans; given a failure it cannot (a pinned
  name), returns `{ kind: 'error' }`;
- an `error` decision terminates the run and returns the tool's failure text to
  the consumer (NOT `(no response)`, NOT a generic abort reason);
- a flat pipeline (no planner) surfaces a tool error to the consumer;
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
