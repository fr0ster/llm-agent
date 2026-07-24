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

**Layer 2 — Backstop (choke-point guard).** The single place that forms a success
terminal is `commitTerminalSuccess` (handler:2042) — the only caller of
`writeTerminal({ kind: 'success' })`, reached from both finalize paths (1959,
2028). The guard goes at its **top**: if `answer.trim()` is empty, call
`abortTerminal(capturedFailureText ?? GENERIC_NO_ANSWER)` and return, instead of
writing a success terminal and surfacing empty. Because every success terminal —
current and future callers — passes through this one method, the invariant does
not depend on any caller remembering to check. `surfaceFinal` additionally gets a
defensive guard so it can never yield `ok:true` with an empty body from any path.

Layer 1 provides the *right text* (the real tool error the user asked for) on the
known path; Layer 2 provides the *guarantee* regardless of path.

## Components

**1. `ControlFailure.note` — carry the raw text on the marker.** Today
`ControlFailure` is `{ reason: 'maxToolCalls' | 'step-timeout' |
'control-failure'; seq }` (`types.ts:105`) — a typed enum only. For a tool error,
`cutControlFailure(result.text)` (handler:1666) has the exact text
(`Class ZZ… not found`), writes it durably via `writeControlFailure` **and** into
`plannerPrivate`, but the marker keeps only the generic `'control-failure'`. The
`writeControlFailure` note lives in a RAG step-result artifact, **not** in the
`SessionBundle` — so a pure `helper(bundle)` cannot read it.

Add an optional `note?: string` to `ControlFailure` and have `cutControlFailure`
set it to `noteFor(reason)` — the exact string it already computes for the
durable `writeControlFailure` and the `plannerPrivate` append. `noteFor` maps a
typed code to its human string (`maxToolCalls → "tool-call budget exhausted
(maxToolCalls)"`) and passes anything else through, so for a tool error `note` is
the raw text (`Class ZZ… not found`) and for a budget cut it is the human
sentence. The marker is self-contained — the helper reads only it.

**2. `capturedFailureText(bundle): string | undefined` — pure helper.**
Reads **only** the `controlFailure` marker; it never touches `plannerPrivate`.

```ts
const cf = bundle.inFlightStep?.controlFailure;
if (!cf) return undefined;
if (cf.note) return cf.note;                    // primary, self-contained
// Legacy marker (persisted before `note` existed): only typed reasons have a
// safe human string. A generic 'control-failure' without a note has no
// bundle-local text we can trust, so the caller falls back to GENERIC_NO_ANSWER.
if (cf.reason === 'maxToolCalls')
  return 'tool-call budget exhausted (maxToolCalls)';
if (cf.reason === 'step-timeout')
  return 'step time budget exhausted (step-timeout)';
return undefined;
```

**Why not `plannerPrivate`.** It is an internal scratchpad holding, among other
things, `[external tool <name> result] <data>` and `[clarify answer] <user
text>` (handler:526, 552), plus rewind/board/step notes. Its tail is arbitrary
internal context — surfacing it could leak a sensitive tool result or private
input to the consumer. So the helper never parses it; a legacy generic marker
degrades to `GENERIC_NO_ANSWER` rather than risk leaking. Tested in isolation,
including negative cases.

**3. Dead-end detector (Layer 1).** At the handler site where a replan yields no
forward progress for the in-flight step, the step is a dead-end iff
`inFlight?.controlFailure` is set. No new state — it reads the marker
`cutControlFailure` already persists. On detection: `abortTerminal(ctx, …,
capturedFailureText(bundle) ?? GENERIC_NO_ANSWER, …)`.

**4. Success-answer guard (Layer 2), in `commitTerminalSuccess`.** This method is
the sole writer of `{ kind: 'success' }`; its signature already carries every
argument `abortTerminal` needs (`ctx, sessionId, bundle, now, terminalTtlMs,
usage`). At its top:

```ts
if (answer.trim().length === 0) {
  await this.abortTerminal(
    ctx, sessionId, bundle,
    capturedFailureText(bundle) ?? GENERIC_NO_ANSWER,
    now, terminalTtlMs, usage,
  );
  return;
}
```

Because the guard is on the sole write, a resume replay can never read back an
empty success — the durable record is always a non-empty success or an error.

**5. `surfaceFinal` defensive guard.** `surfaceFinal(content)` must never
`ctx.yield({ ok: true, ... })` with empty/whitespace `content`. If it is ever
reached with empty content it surfaces `GENERIC_NO_ANSWER` instead — a last-ditch
net so no code path can emit `ok:true` empty, independent of the callers.

**6. `GENERIC_NO_ANSWER` constant.** e.g. `"The run ended without an answer."`.
Ensures a non-empty body even when no failure text was captured.

**7. Empty-finalizer — covered by the guard, `finalize` logic unchanged.**
`finalize()` already retries an empty finalizer answer (`throw` inside a
`while (answer === undefined)` loop bounded by `maxFinalizeRetries`) then falls
back to a best-effort answer. We keep that. The success-answer guard (component 4)
runs on whatever answer results: if even best-effort is empty, it writes an error
terminal with the captured failure rather than a success terminal with an empty
body.

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

Backstop (any path that would form an empty success terminal):

```
commitTerminalSuccess(answer), answer.trim() === ''
  → abortTerminal(capturedFailureText ?? GENERIC_NO_ANSWER)   ← instead of writeTerminal(success)
```

Symptom B is Layer 1 with `capturedFailureText` = `controlFailure.note` =
`noteFor('maxToolCalls')` = `tool-call budget exhausted (maxToolCalls)`.

## Error handling / edge cases

- **Empty captured text** → `GENERIC_NO_ANSWER`. Body is never empty.
- **No double surface.** Layer 1 and the success-answer guard both funnel into
  `abortTerminal`, which writes a terminal and surfaces exactly once; they are
  mutually exclusive per run (Layer 1 fires before finalize is reached).
- **Suspend unaffected.** The guards are on forming a **terminal** answer; a
  legitimate external-tool suspend forms no terminal and surfaces nothing, so
  neither guard touches it — the external round-trip is unchanged.
- **Resume of an already-terminal run** reads the durable `writeTerminal` record;
  because the success-answer guard is on the **write**, a stored success is
  always non-empty, so the replay surface is never empty.
- **Empty finalizer** → `finalize`'s own retry + best-effort runs first
  (unchanged); if it still yields empty, the success-answer guard writes an error
  terminal instead of an empty success. No `finalize` retry-logic change.

## Testing

Controller-handler unit tests, alongside `controller/__tests__`.

- `ControlFailure.note`: `cutControlFailure` sets it to `noteFor(reason)` — raw
  text for a tool error, human sentence for a typed cut.
- `capturedFailureText`: `note` wins; legacy typed reason maps to its human
  sentence; a legacy generic marker or no marker → `undefined`.
- **Negative (leak) tests:** with `controlFailure.note` unset and
  `plannerPrivate` ending in `[external tool … result] …`, `[clarify answer] …`,
  or `[rewind] …`, `capturedFailureText` returns `undefined` (never that text),
  and the backstop surfaces `GENERIC_NO_ANSWER` — the private tail is never
  surfaced.
- **Symptom A:** a failed step (tool error) + empty replan → terminal carries
  `Class … not found`, `surfaceFinal` called with `Error: …`, body non-empty.
- **Symptom B:** a `maxToolCalls` cut + empty replan → terminal carries
  `tool-call budget exhausted (maxToolCalls)`.
- **Success-answer guard:** `commitTerminalSuccess('')` writes an **error**
  terminal (captured/generic) and surfaces it, never a success terminal with an
  empty body; a resume then replays the error, not an empty success. Exercised
  through both finalize callers (1959, 2028) **and** a direct
  `commitTerminalSuccess('')` call, so the guarantee holds at the choke point.
- **`surfaceFinal` defensive guard:** called with empty content → yields
  `GENERIC_NO_ANSWER`, never `ok:true` empty.
- **Suspend unaffected:** an external-tool suspend forms no terminal and surfaces
  nothing; neither guard fires.

Invariant the tests pin: no run ever writes a success terminal with an empty
answer, and `surfaceFinal` never yields `ok:true` with an empty body.

## Out of scope (tracked separately)

- The planner choosing the `error` decision (not `replan`) for a tool-level
  failure the step was asked to report — a planner-prompt/classification change.
- A run-level tool-call ceiling — new budget mechanics.

Both are quality improvements; this change delivers *visibility* deterministically
from the handler.

## Delivery

One PR:

- `types.ts` — add `ControlFailure.note?: string`.
- `controller-coordinator-handler.ts` — `cutControlFailure` sets `note`; the
  dead-end detector (Layer 1); the success-answer guard at the top of
  `commitTerminalSuccess`; the `surfaceFinal` defensive guard;
  `capturedFailureText` helper; `GENERIC_NO_ANSWER`.

`finalize`'s retry/best-effort logic and `planner.ts` are unchanged. Additive; no
public interface changes.
