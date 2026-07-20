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
dispatcher. Serving the step costs no LLM call, no MCP call and no tokens.

| role | responsibility | LLM |
|---|---|---|
| planner | emits `wait` steps where a created object is used later | yes |
| **controller** (the plan interpreter) | executes `wait` itself, reports the step settled OK | **no** |
| executor | never sees a `wait` step | — |
| reviewer | never sees a `wait` step | — |

**The controller IS the plan interpreter.** It is the component that walks the
plan and hands each step to the executor, and a `wait` step is the one kind it
never hands over: it serves the step itself — sleep, then report "step done,
OK" into the plan's progress — without invoking the executor.

So this behaviour belongs in the controller's own step loop by definition, not
as a delegation to some other component.

**A `wait` step is never an MCP tool call.** That is the whole point: routing a
pause through the tool catalog means the LLM must *decide* to wait and then
*read back* the result, which is exactly the two-round-trip cost this
deliverable removes. No code path serves a `type: 'wait'` step by calling an MCP client, the
executor or the reviewer. (The step still appears on the board afterwards, and
the board reaches the planner — see the step-shape section.)

The dispatch lives in `controller-coordinator-handler.ts`. Because that file is
already oversized, the wait branch itself goes into a small focused module that
the dispatch consumes (principle 6) — a file-size measure, not a role
boundary. The stepper composition's separate `IInterpreter` interface is
unrelated to this deliverable and is not touched.

### Step shape

`Step` already carries an optional `type?: string`
(`controller/types.ts:23`). This spec gives it its first meaningful value:

```ts
{ name: string, type: 'wait', waitMs: number, instructions: string }
```

`instructions` stays required and human-readable ("wait for ZI_… activation to
settle") so the board and digest remain legible.

Precisely: a wait step's `instructions` is never sent to the **executor or
reviewer** — it is not an executable instruction, and nothing dispatches it as
one. It *is* carried into the board like any other step (`board.ts:298`
renders it into the board line) and therefore does reach the planner and
finalizer through `boardText` (`planner.ts:342`). That is intended and must
not be "fixed": the planner needs to see that it scheduled a wait and why,
otherwise it cannot reason about the plan it built.

Stated as a rule for the implementer: **do not strip a wait step from the
board or shorten its instructions** in the name of saving tokens. The
zero-token claim of this deliverable is about the wait's *dispatch* — no
executor call, no reviewer call, no MCP call — not about the step being
invisible to every model afterwards.

### Runtime contract (must be implemented, not inferred)

`Step` today carries `type?: string` and **no duration field**, and
`parsePlan()` (`planner.ts:172`) rebuilds each step from exactly four
properties — `name`, `instructions`, `type`, `requires`. A `waitMs` the planner
emits would therefore be silently dropped before dispatch. This deliverable
must:

1. add `waitMs?: number` to `Step`;
2. preserve it in `parsePlan()` alongside the existing four;
3. validate it.

Validation, consistent with how `parsePlan` already treats a malformed `name`,
`instructions` or `requires`: **a planner-authored `waitMs` must be a positive,
finite integer.** Absent, non-numeric, `NaN`, infinite, negative, **zero** or
fractional makes the **plan** malformed → `parsePlan` returns `null` → format
failure → the planner retries. A silent default would let a planner that forgot
the duration produce a zero-length "wait" that looks like it worked.

Zero is rejected for exactly that reason, not as pedantry: `waitMs: 0` reaches
dispatch, settles OK, and reports to the planner that the system was given time
to settle when it was given none — the same failure mode as a dropped `waitMs`,
just spelled explicitly.

**Zero is legal internally**, and only there: when the run's `maxTotalWaitMs` is
already spent, or when a resumed deadline has already passed, the controller
computes a remaining duration of `0` and settles the step without sleeping.
That value is produced by the controller's own arithmetic, never accepted from
a plan, and it is recorded as the "skipped" or resumed case rather than as a
normal wait — so the distinction stays visible in the artifact instead of
hiding behind an identical-looking success.

`waitMs` on a step that is *not* `type: 'wait'` is ignored. A `type` value
other than `'wait'` dispatches exactly as today — `type` is currently free-form
and unused for dispatch, and that must stay true (principle 7).

### Step budget

A settled `wait` **consumes one `stepsUsed` unit**, like any other step. The
main loop is gated by `while (bundle.budgets.stepsUsed < cfg.maxSteps)`
(`controller-coordinator-handler.ts:594`); a wait branch that short-circuits
without incrementing would let a plan of wait steps bypass `maxSteps`
entirely.

### Durable wait accounting

`maxTotalWaitMs` is a per-run cap, so it must survive suspend/resume. The
durable bundle currently carries only `budgets: { stepsUsed, rewindsUsed }`
(`types.ts:123`) — it needs `waitMsUsed: number`.

The budget is charged **once, before sleeping**, and persisted with the same
write that records the step as in-flight. It is never charged again for that
step.

**Resume contract — deadline, not duration.** The deadline fields live on
`InFlightStep` (`types.ts:96`), which is already the durable per-step record
(it carries `seq`, `attempt`, `resumeCount`, `toolCallCount`,
`controlFailure`). It gains:

```ts
waitStartedAt?: number;   // epoch ms, set when the sleep begins
appliedWaitMs?: number;   // post-clamp duration actually being served
```

Both optional, so bundles written before this change deserialize unchanged.
On resume, the controller sleeps only the remainder:

```
remaining = max(0, waitStartedAt + appliedWaitMs - now)
```

So an outage longer than the wait settles the step immediately, and a short
outage costs only the time genuinely left. This is chosen over the alternatives
deliberately:

- re-sleeping the full duration would double the wall-clock cost of a crash and
  could exceed the wait the planner asked for;
- settling unconditionally on resume would report the system as settled after a
  1-second outage of a 360-second wait — the exact lie the aborted-wait rule
  above exists to prevent.

Real elapsed time is what the planner is actually buying, and elapsed time
keeps running during an outage. The deadline honours that; a duration does not.

Missing `waitStartedAt` / `appliedWaitMs` on an in-flight wait (a bundle
written before this change, or a torn write) is treated as an aborted wait —
not settled — so the planner is never told a wait completed that cannot be
proven.

Missing `waitMsUsed` on a bundle written before this change reads as `0`
(backward compatible).

### Step-result shape

A settled wait writes a normal `step-result` artifact through the same
`writeArtifact` call the controller already uses for step outcomes
(`controller-coordinator-handler.ts:1160`), with that call's exact metadata
shape:

```ts
{ ...meta, artifactType: 'step-result', task: step.name, runId, seq, attempt,
  status, note, remainder, stepId, digest, writeOrdinal, content }
```

`writeOrdinal` comes from `bundle.writeOrdinal` (incremented per write, not per
step) exactly as the existing writers do — the wait branch must not invent its
own ordering.

It must not be an empty-content `ok` result: empty `content` is what the
control-failure writer uses for a `failed` outcome, and an `ok` with empty
content risks being carried into approved content and surfacing in the final
answer as a blank executed step.

Five canonical cases, all `status: 'ok'` except the last:

| case | content / digest | note |
|---|---|---|
| normal | states the step waited and for how long | — |
| clamped | states the requested and the applied duration | clamp reason |
| skipped (total cap spent) | states no wait was performed | cap reason |
| resumed after deadline | states the deadline had already elapsed during the outage and no further sleep was performed | resume reason |
| aborted mid-wait | not settled — reported as a cancellation | — |

The resumed case is deliberately its own row rather than being folded into
`normal` or `skipped`. Recording it as `normal` would claim a sleep that never
happened on this run; recording it as `skipped` would claim the wait was never
served, when in fact the full duration did elapse — just while the process was
down. Only a distinct case keeps the artifact honest about both.

An aborted wait is **not** a settled step: reporting it as done would tell the
planner the system had time to settle when it did not.

### Dispatch

In the controller's step loop, a step with `type === 'wait'` short-circuits
**before** evidence recall, tool selection, executor and reviewer:

1. compute the applied duration:
   `applied = min(waitMs, maxWaitMs, remaining maxTotalWaitMs)` — this is where
   a clamp or a total-cap skip is decided, and `applied` may be `0`;
2. charge `waitMsUsed += applied` and persist it together with
   `waitStartedAt = now` and `appliedWaitMs = applied` on the in-flight step,
   BEFORE any sleeping;
3. sleep `max(0, waitStartedAt + appliedWaitMs - now)`, interruptible by
   `CallOptions.signal`. On a first dispatch this is simply `applied`; on a
   resume it is whatever remains of the persisted deadline, which may be `0`;
4. record the step-result for whichever of the five cases applies, so the board
   and the planner's view of progress stay coherent;
5. advance.

Step 2 preceding step 3 is what makes a crash mid-sleep safe: the deadline is
already durable, so the resumed run serves the remainder instead of restarting
the wait or double-charging the cap.

**Cancellation — exact scope.** The sleep is interruptible by
`CallOptions.signal`, and that is *all* this deliverable promises. When a
signal is present, the sleep ends immediately instead of running to the
deadline.

It must NOT be described as "an aborted HTTP request interrupts the wait",
because today it does not. The chat route builds its options without a signal
(`http/chat-route-handler.ts:158`), and the agent only merges one when a signal
is already supplied or a `timeoutMs` exists (`agent.ts:610`). So a client
disconnect or a proxy timeout does **not** currently reach the controller, and
a 360-second wait keeps sleeping after the caller has gone.

Wiring client-disconnect into `CallOptions.signal` is a SmartServer change with
its own blast radius (it makes every long-running request cancellable, not just
waits) and is deliberately out of scope here. It is worth doing — a wait makes
the gap more visible, since a request can now sit idle for minutes by design —
but as its own task, tested at the route level.

Consequence to accept knowingly: until that task lands, the practical bound on
an abandoned waiting request is the server's own request timeout, not the
client's.

### Bounds

**The planner decides how long to wait.** It knows what it just asked the
system to do — a DDL activation and a transport release do not settle on the
same timescale — so 30 s, 90 s, 120 s and 360 s are all legitimate values it
may emit. The engine does not second-guess them.

The clamp exists only to bound absurdity, and is therefore set well above the
planner's working range: `maxWaitMs` default **600 000 ms**, `maxTotalWaitMs`
default **1 800 000 ms** per run, both configurable under
`pipeline.config.budgets`.

Both knobs must be added to `ControllerConfig['budgets']` **and** to the
defaults block in `ControllerPipelinePlugin.parseConfig()`
(`pipelines/controller.ts:120`), which is the single place every other budget
default lives and where `...budgetsRaw` applies the operator's overrides.
Defaulting anywhere else — in the wait helper, at the call site — would put
two sources of truth in the codebase and silently ignore YAML overrides.

**Operator-provided values are validated at load:**

- `maxWaitMs` — a **positive** finite integer;
- `maxTotalWaitMs` — a **non-negative** finite integer (`0` is meaningful: it
  disables waiting, and every wait step settles as skipped).

Anything else — a string from YAML, `NaN`, a negative, a fraction — throws
during `parseConfig`, matching how that method already rejects a missing
`subagents.<role>` and the removed `planner:` key (`controller.ts:86,100`).
These two knobs drive an actual `sleep`, so a nonsensical value does not
degrade gracefully: `maxWaitMs: -1` would clamp every wait to a negative
duration, and `maxWaitMs: "600000"` from unquoted-YAML habits would compare as
a string. Failing at load is far better than a plan that silently stops
waiting in production.

Scope note: the *existing* budget fields are not validated today —
`...budgetsRaw` is cast blindly, so `maxSteps: "abc"` also passes through. That
is a real pre-existing gap, but fixing it means touching every controller
budget and its tests; this deliverable validates only the two fields it
introduces rather than growing into a config-hardening change.
A planner that emits an hour is clipped; a planner that emits 360 s is obeyed.
Clamping is recorded, never silent. Once the cumulative budget is spent,
further `wait` steps settle immediately rather than sleeping, and that is
recorded too.

This deliverable defines its own cap rather than borrowing the run-level
ceiling from deliverable 2, which does not exist yet.

**Consequence to be explicit about:** a wait blocks the request. A plan with
two 360 s waits holds an HTTP connection for over twelve minutes, which will
outlive typical client, proxy and load-balancer timeouts long before it
outlives our own budgets. So the ceiling that matters in practice is the
deployment's request timeout, not `maxTotalWaitMs`. Operators raising
`maxWaitMs` must raise their request timeout to match; the documentation says
so, and a wait clamped by an abort is reported as a cancellation, not as a
settled step.

### What this spec does NOT do

**It does not remove any MCP tool from the catalog.** This is about what the
executor may still reach for *during an ordinary step* — it does not weaken the
rule above that a `wait` step itself never touches MCP. The reporter's catalog
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

- serving a `type: 'wait'` step makes **zero** executor, reviewer and MCP calls
  (asserted against spies, not by timing) — this is the load-bearing test of the
  whole deliverable. It asserts the DISPATCH, not that the step is absent from
  later board-derived prompts, which it must not be;
- the settled `wait` step reports success into the plan's progress, so the
  planner sees "step done, OK" exactly as for an executed step;
- the wait is interrupted by an abort signal rather than running to completion;
- `parseConfig()` defaults `maxWaitMs` to `600_000` and `maxTotalWaitMs` to
  `1_800_000`, and an explicit YAML value for either overrides the default —
  the guard against the defaults drifting into the wait helper;
- `parseConfig()` THROWS for `maxWaitMs` given as a string, `NaN`, a fraction,
  a negative or `0`, and for `maxTotalWaitMs` given as a string, `NaN`, a
  fraction or a negative;
- `maxTotalWaitMs: 0` is accepted and disables waiting: every wait step settles
  as skipped without sleeping;
- a planner-chosen duration inside the working range (30 s / 90 s / 120 s /
  360 s) is honoured exactly, not clipped;
- `waitMs` beyond `maxWaitMs` is clamped and the clamp is reported;
- once `maxTotalWaitMs` is spent, a further `wait` settles immediately and
  records that it was skipped;
- a `wait` step produces a step-result the board reflects;
- `parsePlan()` preserves `waitMs` — the regression that would otherwise make
  every wait zero-length;
- a `type: 'wait'` step with absent / non-numeric / `NaN` / infinite / negative
  / **zero** / fractional `waitMs` fails the plan format and triggers a planner
  retry, rather than defaulting — `0` included, since it settles OK while
  granting no settle time at all;
- a controller-computed remaining duration of `0` (total cap spent, or a
  resumed deadline already passed) settles WITHOUT sleeping and is recorded as
  the skipped/resumed case, not as a normal wait — the one place zero is legal;
- a settled wait increments `stepsUsed`, so a plan of wait steps still hits
  `maxSteps`;
- `waitMsUsed` is charged before the sleep and persisted, charged exactly once
  per step, and a bundle written without the field resumes as `0`;
- resume sleeps only the remaining time to the persisted deadline: an outage
  longer than the wait settles immediately AS THE `resumed after deadline` case
  (not as `normal`, which would claim a sleep that did not happen on this run,
  and not as `skipped`, which would claim the wait was never served), a short
  outage sleeps the remainder, and neither re-charges the budget;
- an in-flight wait missing `waitStartedAt` / `appliedWaitMs` resumes as
  aborted, not settled;
- `waitMs` present on a NON-wait step, and an unknown `type` value, both leave
  dispatch behaviour byte-identical to today (principle 7 regression guard);
- each of the four step-result cases (normal / clamped / skipped / aborted)
  writes its canonical artifact, and an aborted wait is NOT settled;
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
4. **ISP** — **four** optional fields are added to existing types, all additive
   so no consumer breaks (principle 7):

   | field | type | why |
   |---|---|---|
   | `Step.waitMs` | `number?` | `Step.type` alone cannot carry a duration |
   | `SessionBundle.budgets.waitMsUsed` | `number?` | per-run cap must survive resume |
   | `InFlightStep.waitStartedAt` | `number?` | deadline resume contract |
   | `InFlightStep.appliedWaitMs` | `number?` | deadline resume contract |

   This supersedes two earlier undercounts in this document's history (first
   "nothing is added", then "two fields"). The deadline contract cannot be
   implemented without a durable home for its two fields, and leaving that
   unstated invites an ad-hoc implementation or a forgotten migration.
5. **Strategies** — the wait *duration* is the planner's decision, not the
   engine's; the *clamp* is only an absurdity bound, set above the planner's
   working range and configurable, deliberately not a pluggable policy in this
   deliverable.
6. **File size** — dispatch of the wait branch goes into a small focused module
   rather than growing `controller-coordinator-handler.ts`, which is already
   oversized.
7. **Don't break components** — `type` is optional and previously unused for
   dispatch; plans without it are unaffected.
