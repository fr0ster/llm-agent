# Controller `wait` step — LLM-free waiting

**Status:** design, approved for implementation
**Scope:** deliverable 1 of 2. Deliverable 2 (failure classification +
`IStepFailureStrategy` + run-level ceiling) is a separate spec.

## Problem

The controller has no notion of time. When a plan creates an object in a real
ABAP system and a later step uses it, nothing accounts for the system needing
time to settle — so the executor discovers the object is locked or inactive and
starts hammering it.

Live evidence (issue #213 repro, 3 concurrent heavy prompts against a real
system, trace `.run/eval/sessions-controller3001`, 2026-07-20):

- one request spent **488 422 tokens** and ended with
  "the planner did not return a valid decision";
- of its 62 MCP calls, **27 returned** `MCP error -32603: SAP Error: User
  OKYSLYTSIA is currently editing ZI_MCP_SHR_RTABL`;
- the executor called `UpdateDdl` 24 times, `ActivateDdl` 8 times;
- it also called a `wait` tool **10 times** (55 s actually waited) — out of
  **75 LLM calls** in that one request.

That last line is this spec's target. The executor *did* wait. But waiting was
expressed as an MCP tool the model has to **choose**, so every pause costs at
least two LLM round-trips — decide to wait, then interpret "Waited 5s" — each
carrying the full, growing context. Waiting is a control-flow concern being
paid for at inference prices.

(The retry loop itself — 24 `UpdateDdl` against a locked object — is deliverable
2. This spec does not attempt to fix it.)

## Design

Waiting becomes a first-class plan step executed by the deterministic
dispatcher. No LLM call, no MCP call, no tokens.

| role | responsibility | LLM |
|---|---|---|
| planner | emits `wait` steps where a created object is used later | yes |
| step dispatcher | executes `wait` — a timer, nothing else | **no** |
| executor | never sees a `wait` step | — |
| reviewer | never sees a `wait` step | — |

### Step shape

`Step` already carries an optional `type?: string`
(`controller/types.ts:23`). This spec gives it its first meaningful value:

```ts
{ name: string, type: 'wait', waitMs: number, instructions: string }
```

`instructions` stays required and human-readable ("wait for ZI_… activation to
settle") so the board and digest remain legible; it is never sent to a model.

### Dispatch

In the controller's step loop, a step with `type === 'wait'` short-circuits
**before** evidence recall, tool selection, executor and reviewer:

1. sleep `waitMs`, interruptible by the caller's abort signal;
2. record a step-result marking the step settled, so the board and the
   planner's view of progress stay coherent;
3. advance.

Cancellation: an aborted request must interrupt the sleep immediately, not
after `waitMs`.

### Bounds

`waitMs` is clamped by the engine to `[0, maxWaitMs]`, `maxWaitMs` configurable
under `pipeline.config.budgets` with a conservative default (30 s). A planner
that emits `waitMs: 3600000` must not hold a request for an hour. A clamp is
logged, never silent.

Cumulative wait per run is bounded by its own budget, `maxTotalWaitMs` (default
120 s). Once spent, further `wait` steps settle immediately instead of
sleeping, and the fact is recorded. This deliverable defines its own cap rather
than borrowing the run-level ceiling from deliverable 2, which does not exist
yet.

### What this spec does NOT do

**It does not remove any MCP tool from the catalog.** The reporter's catalog
happens to contain a tool named `wait`, and it would be tempting to filter it
out. The engine hardcodes no tool names — that is a standing invariant
(`CLAUDE.md`, MCP-agnostic principle): tool-usage concerns are solved in MCP
tool descriptions or by consumer configuration, never by the engine knowing a
name. If a consumer wants their `wait` tool excluded from selection, that is
consumer-side configuration and out of scope here.

The expectation is that a planner-emitted `wait` reduces the executor's need to
reach for such a tool, not that the engine forbids it.

## Planner contract

The planner prompt gains one rule: when a step creates or activates an object
that a later step consumes, insert a `wait` step between them. The planner
already emits English instructions (hard invariant), so this adds no language
concern.

Note the planner cannot predict *unexpected* contention — a lock held by
another user or a concurrent request appears only at execution time. Handling
that is deliverable 2. This spec covers the *predictable* case: the plan's own
create → use ordering.

## Testing

- a plan containing `type: 'wait'` settles the step with **zero** LLM calls and
  **zero** MCP calls (asserted against spies, not by timing);
- the wait is interrupted by an abort signal rather than running to completion;
- `waitMs` beyond `maxWaitMs` is clamped and the clamp is reported;
- a `wait` step produces a step-result the board reflects;
- a plan with no `wait` steps behaves exactly as before (no regression in the
  existing controller suites).

Timing assertions use an injected clock/timer seam rather than real sleeps, so
the suite stays fast and deterministic.

## Architecture principles check

1. **Build on existing components** — extends the existing `Step.type` and the
   existing controller dispatch loop; adds no parallel mechanism.
2. **The app is the example** — the behaviour lands in the controller pipeline
   library, not in SmartServer.
3. **Interfaces** — no new concrete class is exposed to consumers here; the
   swappable failure/retry policy arrives in deliverable 2 as its own focused
   interface.
4. **ISP** — nothing is added to an existing interface; `Step.type` already
   existed.
5. **Strategies** — the wait *duration policy* is the planner's; the *clamp* is
   an engine safety bound, deliberately not consumer-pluggable in this
   deliverable.
6. **File size** — dispatch of the wait branch goes into a small focused module
   rather than growing `controller-coordinator-handler.ts`, which is already
   oversized.
7. **Don't break components** — `type` is optional and previously unused for
   dispatch; plans without it are unaffected.
