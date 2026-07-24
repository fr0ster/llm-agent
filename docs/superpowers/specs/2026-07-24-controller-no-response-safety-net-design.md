# Controller: never terminate a run with `(no response)` — safety-net design

Issue: [#243](https://github.com/fr0ster/llm-agent/issues/243)

## Problem

On 20.8.0 the `isError` propagation from #213/#232 works: a tool-level MCP error
reaches the controller as a `control-failure` decision carrying the real error
text. But the next hop is lossy — `control-failure → replan` can terminate the
run with **no surfaced answer or error**, returning an empty completion (0
tokens, rendered `(no response)` by the OpenAI surface) and discarding the
captured failure text.

Two triggers reach the same dead end:

- **A — deterministic:** a tool-level error (object not found). The exact error
  string is captured but never delivered, even when the user explicitly asks to
  be told the error.
- **B — intermittent under 2-way concurrency (~1 in 6):** per-step `maxToolCalls`
  exhaustion funnels into the same `control-failure → replan → (no response)`.

Both reduce to: a **failed step whose replan cannot make progress** terminates
without surfacing what went wrong.

### Where it happens (verified in source)

- A tool error runs `cutControlFailure` (`controller-coordinator-handler.ts`):
  it sets `inFlight.controlFailure = { reason, seq }`, writes a durable
  `writeControlFailure(note)`, appends the note to `plannerPrivate`, then
  `settle('failed')`.
- On the next planner turn the replan branch (`planner.ts:340-364`) can return
  an empty plan for a failed step. It then **clears the failure marker**
  (`bundle.lastOutcome = undefined`, line 361) and calls `stepAtCursor`, which
  finalizes against an empty remaining plan — an empty body, the captured
  failure gone.
- `abortTerminal` (the existing surface-to-consumer path) is never reached on
  this branch; it already does `writeTerminal{kind:'error'}` +
  `surfaceFinal('Error: <text>')`, exactly what is needed.

## Scope

**Safety-net only** (maintainer's decision). This change guarantees the consumer
always receives an answer or a surfaced error — never `(no response)` — for both
triggers. It does **not** change how the planner classifies `replan`-vs-`error`,
and does **not** add a run-level tool-call ceiling; those are quality
improvements tracked separately.

The surface text is delivered via the existing `abortTerminal` (raw
`Error: <captured text>`), **not** a fresh finalizer LLM pass: it is
deterministic, adds no LLM call that could itself return empty (the same bug
recursively), and the captured string (e.g. `Class ZZ… not found`) already
answers "tell me plainly what the error was".

## Architecture

Two layers, both built on the existing `abortTerminal`.

**Layer 1 — Primary (targeted).** When the handler receives a replan that cannot
make progress for a failed step — an empty plan on a step whose
`inFlight.controlFailure` is set — route it to `abortTerminal` with the captured
failure text, instead of clearing the marker and finalizing empty. This is the
deterministic equivalent of the planner's `error` decision, driven from the
handler by reading the durable `controlFailure` marker; the planner itself is
left unchanged.

**Layer 2 — Backstop (invariant).** A single invariant enforced as `execute()`
concludes a turn: the run never reaches a **terminal** state without a surfaced
answer or error. If it would, `abortTerminal(capturedFailureText ?? GENERIC_NO_ANSWER)`.
This catches any other empty path, so the guarantee does not depend on having
enumerated every branch.

Layer 1 provides the *right text* (the real tool error the user asked for) on the
known path; Layer 2 provides the *guarantee* regardless of path.

## Components

**1. `capturedFailureText(bundle): string | undefined` — pure helper.**
Returns the best available failure text in priority order:

1. `inFlight.controlFailure` reason (typed: `maxToolCalls` / `step-timeout` /
   `control-failure`, mapped to a human string),
2. the last `writeControlFailure` note,
3. the tail of `plannerPrivate`.

`undefined` when none is present. Tested in isolation.

**2. Dead-end detector (Layer 1).** At the handler site where a replan yields no
forward progress for the in-flight step, the step is a dead-end iff
`inFlight?.controlFailure` is set. No new state — it reads the marker
`cutControlFailure` already persists. On detection: `abortTerminal(ctx, …,
capturedFailureText(bundle) ?? GENERIC_NO_ANSWER, …)`.

**3. Terminal-exit invariant (Layer 2).** A local `surfaced` flag, set by
`surfaceFinal`. Before `execute()` returns in a way that concludes the run
(i.e. `bundle.runState === 'terminal'` and `!surfaced`), emit
`abortTerminal(capturedFailureText ?? GENERIC_NO_ANSWER)`. A **suspend** return
(external-tool round-trip) leaves `runState` non-terminal, so the invariant does
not fire — this boundary is load-bearing.

**4. `GENERIC_NO_ANSWER` constant.** e.g. `"The run ended without an answer."`.
Ensures a non-empty body even when no failure text was captured.

**5. Empty-finalizer — covered, not rewritten.** `finalize()` already retries an
empty finalizer answer (`throw` inside a `while (answer === undefined)` loop
bounded by `maxFinalizeRetries`) and then falls back to a best-effort answer.
We do **not** change that. The backstop (component 3) is the final guarantee: if
even the best-effort answer is empty, the terminal-exit invariant surfaces
`capturedFailureText ?? GENERIC_NO_ANSWER` rather than letting an empty body
through. No new behaviour in `finalize` itself.

## Data flow

Symptom A (deterministic tool error):

```
executor tool error → cutControlFailure (controlFailure marker + writeControlFailure)
  → settle('failed')
  → main loop → planner.next() → replan → empty plan on a failed step   ← Layer 1 detects
  → abortTerminal(capturedFailureText)
  → surfaceFinal("Error: Class ZZ… not found")
```

replaces the current `lastOutcome = undefined → finalize-empty`.

Backstop (any other terminal path):

```
execute() about to conclude the run, runState = 'terminal', surfaced = false
  → abortTerminal(capturedFailureText ?? GENERIC_NO_ANSWER)
```

Symptom B is the same path with `capturedFailureText` =
`tool-call budget exhausted (maxToolCalls)`.

## Error handling / edge cases

- **Empty captured text** → `GENERIC_NO_ANSWER`. Body is never empty.
- **Double surface.** `abortTerminal` sets `runState = 'terminal'` and calls
  `surfaceFinal` (which sets `surfaced`), so the backstop is a no-op when Layer 1
  already surfaced. Idempotent.
- **Suspend ≠ terminal.** A legitimate external-tool suspend returns `true` with
  `runState` non-terminal; the backstop keys on `terminal && !surfaced`, so it
  never fires on suspend — this must not regress the external round-trip.
- **Resume of an already-terminal run** reads the durable `writeTerminal` record
  and surfaces without recomputation.
- **Empty finalizer** → `finalize`'s own retry + best-effort runs first
  (unchanged); only if that still yields empty does the backstop surface
  captured/generic. No `finalize` behaviour change.

## Testing

Controller-handler unit tests, alongside `controller/__tests__`.

- `capturedFailureText`: the priority chain; empty → `undefined`.
- **Symptom A:** a failed step (tool error) + empty replan → terminal carries
  `Class … not found`, `surfaceFinal` called with `Error: …`, body non-empty.
- **Symptom B:** a `maxToolCalls` cut + empty replan → terminal carries
  `tool-call budget exhausted (maxToolCalls)`.
- **Backstop:** a run that reaches terminal without a surface → the gate emits
  captured/generic, never `ok:true` with an empty body.
- **Suspend unaffected:** an external-tool suspend returns `true`, no backstop
  fire, no premature terminal.
- **Empty finalizer** → best-effort runs first; a still-empty result is caught by
  the backstop, never `ok:true` empty.

Invariant the tests pin: every terminal `surfaceFinal` has non-empty content, and
no run-termination path leaves `ok:true` with an empty body.

## Out of scope (tracked separately)

- The planner choosing the `error` decision (not `replan`) for a tool-level
  failure the step was asked to report — a planner-prompt/classification change.
- A run-level tool-call ceiling — new budget mechanics.

Both are quality improvements; this change delivers *visibility* deterministically
from the handler.

## Delivery

One PR, confined to `controller-coordinator-handler.ts` (dead-end detector +
terminal-exit invariant + `surfaced` flag + `capturedFailureText` helper +
`GENERIC_NO_ANSWER`). `finalize` and `planner.ts` are unchanged. Additive; no
public interface changes.
