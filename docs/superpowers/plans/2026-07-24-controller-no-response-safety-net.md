# Controller No-Response Safety-Net Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The controller never terminates a run with `(no response)`; a failed step whose replan cannot progress surfaces the real tool error (before any finalizer call), and no path can emit an empty success.

**Architecture:** Layer 1 — `planner.next()` returns a new `{ kind: 'dead-end' }` `NextStep` on an empty replan over a control-failed step, **before** `stepAtCursor` issues the finalizer LLM call; the handler dispatches it to the existing `abortTerminal`. Layer 2 — a guard at the top of `commitTerminalSuccess` (the sole writer of a success terminal) rejects an empty answer, plus `surfaceFinal` routes through a pure `nonEmptyBody`. The captured text is read only from the `controlFailure` marker.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22, `node:test` via `tsx`, Biome.

**Spec:** `docs/superpowers/specs/2026-07-24-controller-no-response-safety-net-design.md`

**Issue:** [#243](https://github.com/fr0ster/llm-agent/issues/243)

## Global Constraints

- All artifacts (code, comments, commit messages) in **English**.
- ESM only — relative imports end in `.js`.
- TypeScript strict; avoid `any` (Biome warns).
- Additive only. The new `NextStep` union member is **internal**: `NextStep` is not re-exported from the package barrel (`llm-agent-server-libs/src/index.ts`), so no external consumer switches on it — the change cannot break an outside exhaustive switch. It stays internal to the controller.
- Biome gate: `npm run lint:check` (a **check**, not `format`).
- Test command: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs`.
- `capturedFailureText` reads **only** the `controlFailure` marker — never `plannerPrivate` (it holds external-tool results and clarify answers; surfacing its tail would leak private context).
- Build before running: `npm run build`.

## File Structure

- `controller/types.ts` — `ControlFailure.note?: string`; `NextStep` gains `{ kind: 'dead-end' }`.
- `controller/planner.ts` — early `dead-end` return in the replan branch.
- `controller/controller-coordinator-handler.ts` — `cutControlFailure` sets `note`; `dead-end` dispatch; `commitTerminalSuccess` guard; `surfaceFinal` via `nonEmptyBody`; `capturedFailureText`, `nonEmptyBody`, `GENERIC_NO_ANSWER`.
- Tests:
  - `controller/__tests__/captured-failure-text.test.ts` (new) — pure helpers.
  - `controller/__tests__/controller-no-response.test.ts` (new) — Symptoms A/B, guards, replay, leak negatives, via `execute()`.

**Why note is not unit-tested in isolation:** both `abortTerminal` and `commitTerminalSuccess` clear `bundle.inFlightStep` (handler:1897, 2062), so a post-`execute()` assertion on `inFlightStep.controlFailure.note` is always `undefined`. `note` is therefore proven end-to-end: the Symptom A surfaced body **is** the note text, which only appears if `cutControlFailure` set it and `capturedFailureText` read it.

---

### Task 1: `ControlFailure.note` field

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts:105-108`

**Interfaces:**
- Consumes: nothing.
- Produces: `ControlFailure.note?: string`.

**Note:** the `NextStep` `dead-end` variant is added in Task 3, together with the
planner return and the handler dispatch, in one commit. Adding it here alone
would break compilation — the handler narrows the residual branch to
`kind: 'next'` (uses `next.step` at handler:909 without an explicit
`kind === 'next'` guard), so a new union member with no dispatch makes `next.step`
non-`'next'`-narrowed and fails `tsc`. Every task must end with a clean build.

- [ ] **Step 1: Add the `note` field (optional — compiles clean on its own)**

In `types.ts`, extend `ControlFailure`:

```ts
export interface ControlFailure {
  reason: 'maxToolCalls' | 'step-timeout' | 'control-failure';
  seq: number;
  /** Human/raw failure text (noteFor(reason)); the surface source for #243.
   *  Optional: bundles persisted before this field degrade to a typed-reason
   *  mapping or GENERIC_NO_ANSWER (see capturedFailureText). */
  note?: string;
}
```

- [ ] **Step 2: Build (clean)**

Run: `npm run build 2>&1 | tail -3`
Expected: clean — an optional field breaks nothing.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts
git commit -m "feat(controller): add ControlFailure.note (#243)"
```

---

### Task 2: Pure helpers — `capturedFailureText`, `nonEmptyBody`, `GENERIC_NO_ANSWER`

**Files:**
- Modify: `controller/controller-coordinator-handler.ts` (module-level exports, near the `parseNextStep` re-export ~line 219)
- Test: `controller/__tests__/captured-failure-text.test.ts` (create)

**Interfaces:**
- Consumes: `ControlFailure.note` (Task 1), `SessionBundle`.
- Produces:
  - `export const GENERIC_NO_ANSWER = 'The run ended without an answer.'`
  - `export function capturedFailureText(bundle: SessionBundle): string | undefined`
  - `export function nonEmptyBody(content: string): string`

- [ ] **Step 1: Write the failing test**

Create `controller/__tests__/captured-failure-text.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionBundle } from '../types.js';
import {
  capturedFailureText,
  GENERIC_NO_ANSWER,
  nonEmptyBody,
} from '../controller-coordinator-handler.js';

function bundleWith(cf: unknown, plannerPrivate = ''): SessionBundle {
  return {
    inFlightStep: cf ? { controlFailure: cf } : undefined,
    plannerPrivate,
  } as unknown as SessionBundle;
}

describe('capturedFailureText', () => {
  it('returns the trimmed note when present', () => {
    assert.equal(
      capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0, note: '  Class X not found  ' })),
      'Class X not found',
    );
  });
  it('treats a blank note as absent', () => {
    assert.equal(capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0, note: '' })), undefined);
    assert.equal(capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0, note: ' \n\t ' })), undefined);
  });
  it('maps a legacy typed reason (no note) to its human sentence', () => {
    assert.equal(capturedFailureText(bundleWith({ reason: 'maxToolCalls', seq: 0 })), 'tool-call budget exhausted (maxToolCalls)');
    assert.equal(capturedFailureText(bundleWith({ reason: 'step-timeout', seq: 0 })), 'step time budget exhausted (step-timeout)');
  });
  it('a legacy generic marker or no marker → undefined', () => {
    assert.equal(capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0 })), undefined);
    assert.equal(capturedFailureText(bundleWith(undefined)), undefined);
  });
  it('NEVER surfaces plannerPrivate — external tool / clarify / rewind tail', () => {
    for (const tail of [
      '\n[external tool ReadClass result] SECRET-PAYLOAD',
      '\n[clarify answer] my private prompt',
      '\n[rewind] backtracking',
    ]) {
      assert.equal(capturedFailureText(bundleWith(undefined, tail)), undefined);
      assert.equal(capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0 }, tail)), undefined);
    }
  });
});

describe('nonEmptyBody', () => {
  it('passes non-empty content through', () => {
    assert.equal(nonEmptyBody('Error: Class X not found'), 'Error: Class X not found');
  });
  it('replaces empty/whitespace with GENERIC_NO_ANSWER', () => {
    assert.equal(nonEmptyBody(''), GENERIC_NO_ANSWER);
    assert.equal(nonEmptyBody('   \n\t '), GENERIC_NO_ANSWER);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A3 "capturedFailureText\|nonEmptyBody"`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the helpers**

In `controller-coordinator-handler.ts`, at module level (below the `parseNextStep`
re-export, ~line 219):

```ts
/** Consumer-facing fallback when no failure text was captured. */
export const GENERIC_NO_ANSWER = 'The run ended without an answer.';

/**
 * The failure text to surface for a dead-ended run, read ONLY from the
 * controlFailure marker — never plannerPrivate, which holds external-tool
 * results and clarify answers whose tail would leak private context.
 * A non-blank note wins (trimmed); a blank note is treated as absent; a legacy
 * typed reason maps to its human sentence; a legacy generic marker → undefined.
 */
export function capturedFailureText(bundle: SessionBundle): string | undefined {
  const cf = bundle.inFlightStep?.controlFailure;
  if (!cf) return undefined;
  if (cf.note?.trim()) return cf.note.trim();
  if (cf.reason === 'maxToolCalls')
    return 'tool-call budget exhausted (maxToolCalls)';
  if (cf.reason === 'step-timeout')
    return 'step time budget exhausted (step-timeout)';
  return undefined;
}

/** #243 last-ditch net: an empty/whitespace body becomes GENERIC_NO_ANSWER, so
 *  no code path can yield ok:true with an empty body. */
export function nonEmptyBody(content: string): string {
  return content.trim().length === 0 ? GENERIC_NO_ANSWER : content;
}
```

`SessionBundle` is already imported in the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A2 "capturedFailureText\|nonEmptyBody"`
Expected: PASS — 7 + 2 tests.

- [ ] **Step 5: Build + lint, commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/captured-failure-text.test.ts
git commit -m "feat(controller): capturedFailureText + nonEmptyBody helpers, marker-only source (#243)"
```

---

### Task 3: Layer 1 — early dead-end signal (note + planner signal + dispatch)

**Files:**
- Modify: `controller/controller-coordinator-handler.ts` — `cutControlFailure` sets `note` (~1327); `dead-end` dispatch before `if (next.kind === 'done')` (~871).
- Modify: `controller/planner.ts` — early `dead-end` return in the replan branch (~351).
- Test: `controller/__tests__/controller-no-response.test.ts` (create)

**Interfaces:**
- Consumes: `ControlFailure.note` (Task 1), `capturedFailureText`, `GENERIC_NO_ANSWER` (Task 2), `abortTerminal` (existing).
- Produces: `NextStep | { kind: 'dead-end' }`; a control-failed step whose replan is empty terminates with the captured error, before any finalizer call.

This task adds the `dead-end` union member, the planner return, and the handler
dispatch **together**, so the build is clean at the single commit boundary.

- [ ] **Step 1: Write the failing test**

Create `controller-no-response.test.ts`. Copy the scaffolding (`fakeCtx`,
`scriptedClient`, `stubRag`, `stubEmbedder`, `baseConfig`, `harness`, `toolCall`)
from `controller-coordinator-handler.test.ts` lines 1-166, add
`import { hydrateBundle } from '../session-bundle.js';`,
`import { readTerminal } from '../run-scope.js';`.

**Adjust the copied `Harness` to expose the typed planner.** `ControllerHandlerDeps.planner`
is statically `ISubagentClient` (no `calls`), so `h.deps.planner.calls` does not
compile — the `& { calls }` from `scriptedClient` is erased when assigned into
`deps`. Keep a separate reference:

```ts
interface Harness {
  deps: ControllerHandlerDeps;
  planner: ReturnType<typeof scriptedClient>; // typed, exposes .calls
  rag: ReturnType<typeof stubRag>;
  backend: InMemoryKnowledgeBackend;
  mcpCalls: Array<{ name: string; args: unknown }>;
}
// inside harness():
const planner = scriptedClient(opts.planner);
const deps: ControllerHandlerDeps = { /* … */ planner, /* … */ };
return { deps, planner, rag, backend, mcpCalls };
```

Then add:

```ts
function surfacedContent(captured: ReturnType<typeof fakeCtx>['captured']): string | undefined {
  const c = captured.find(
    (x): x is { ok: true; value: { content: string } } =>
      x.ok === true && typeof (x.value as { content?: unknown }).content === 'string',
  );
  return c?.value.content;
}

describe('#243 Layer 1 dead-end', () => {
  it('Symptom A: tool error → empty replan surfaces the real error, before any finalizer', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: read a class, report errors' }],
      planner: [
        { kind: 'content', content: JSON.stringify({ plan: [{ name: 's1', instructions: 'read' }] }) },
        { kind: 'content', content: JSON.stringify({ plan: [] }) },        // replan → empty
        { kind: 'content', content: 'I could not find anything relevant.' }, // finalize — must NOT run
      ],
      executor: [toolCall('ReadClass', { name: 'ZZ_QX9B7' })],
      isExternalTool: () => false,
      selectTools: [{ name: 'ReadClass', description: '', inputSchema: {} }],
      callMcpReturns: { text: 'Class ZZ_QX9B7 not found', isError: true },
    });
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const body = surfacedContent(captured);
    assert.ok(body);
    assert.match(body, /Class ZZ_QX9B7 not found/);
    assert.doesNotMatch(body, /could not find anything relevant/); // finalizer never composed
    assert.equal(h.planner.calls, 2, 'finalizer LLM call never happened (2 planner calls: plan + replan)');

    // Durable terminal is an ERROR, not an empty/other success.
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    const term = await readTerminal(h.backend, 'sess-1', bundle.runId!, new Date().toISOString());
    assert.equal(term?.kind, 'error');
  });

  it('Symptom B: maxToolCalls cut → empty replan surfaces the budget message', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: look it up' }],
      planner: [
        { kind: 'content', content: JSON.stringify({ plan: [{ name: 's1', instructions: 'look' }] }) },
        { kind: 'content', content: JSON.stringify({ plan: [] }) },
        { kind: 'content', content: 'done anyway' }, // finalize — must NOT run
      ],
      executor: [toolCall('Look', {}), toolCall('Look', {}), toolCall('Look', {})],
      isExternalTool: () => false,
      selectTools: [{ name: 'Look', description: '', inputSchema: {} }],
      config: baseConfig({ maxToolCalls: 2 }),
    });
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const body = surfacedContent(captured);
    assert.ok(body);
    assert.match(body, /tool-call budget exhausted \(maxToolCalls\)/);
    assert.doesNotMatch(body, /done anyway/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A4 "Layer 1 dead-end"`
Expected: FAIL — the finalizer answer is surfaced (`could not find…`), `planner.calls === 3`, and no dead-end interception.

- [ ] **Step 3: Add the `dead-end` NextStep variant**

In `types.ts`, extend `NextStep` (build stays red until Steps 4-5 add the
producer and dispatch — that is expected within this one task; the commit at the
end is the first clean build):

```ts
export type NextStep =
  | { kind: 'next'; step: Step }
  | { kind: 'done'; result: string }
  | { kind: 'rewind'; reason: string }
  | { kind: 'dead-end' }
  | PlanError;
```

- [ ] **Step 4: Set `note` in `cutControlFailure`**

In `controller-coordinator-handler.ts`, where the marker is built:

```ts
          inFlight.controlFailure = {
            reason: typedReason,
            seq: inFlight.seq,
            note: noteFor(reason),
          };
```

`noteFor` is in scope (~line 1042).

- [ ] **Step 5: Emit `dead-end` from `planner.next()`**

In `planner.ts`, in the replan branch immediately after
`const mintedRest = mintReplanStepIds(...)` (~line 351), before
`bundle.plan = [...]`:

```ts
      // #243 Layer 1: an empty replan over a control-failed step is a dead end —
      // nothing to retry. Signal it BEFORE stepAtCursor (which would issue the
      // finalizer LLM call), leaving the controlFailure marker for the handler.
      if (mintedRest.length === 0 && bundle.inFlightStep?.controlFailure) {
        return { kind: 'dead-end' };
      }
```

- [ ] **Step 6: Dispatch `dead-end` in the handler**

In `controller-coordinator-handler.ts`, immediately **before**
`if (next.kind === 'done') {` (~line 871):

```ts
      if (next.kind === 'dead-end') {
        const failure = capturedFailureText(bundle) ?? GENERIC_NO_ANSWER;
        logDecision(ctx, 'dead-end', failure);
        await this.abortTerminal(
          ctx,
          sessionId,
          bundle,
          failure,
          now,
          terminalTtlMs,
          usageNow(),
        );
        return true;
      }
```

`logDecision`, `now`, `terminalTtlMs`, `usageNow` are all in scope (the adjacent
`next.kind === 'error'` branch uses the same set). If Task 1 Step 3 flagged a
non-exhaustive `switch`, this branch resolves it.

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A4 "Layer 1 dead-end"`
Expected: PASS — both symptoms surface the real error; `planner.calls === 2`; terminal `kind === 'error'`.

- [ ] **Step 8: Full suite + baseline**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. A legit `done` after a successful recovery still finalizes — the dead-end fires only when `mintedRest` is empty AND `controlFailure` is set. If a pre-existing test fails, confirm it fails on `main`.

- [ ] **Step 9: Build + lint, commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-no-response.test.ts
git commit -m "feat(controller): planner emits dead-end before the finalizer; handler surfaces the real error (#243)"
```

---

### Task 4: Layer 2 — empty-success guard + `surfaceFinal` net

**Files:**
- Modify: `controller/controller-coordinator-handler.ts` — guard at top of `commitTerminalSuccess` (~2042); `surfaceFinal` routes through `nonEmptyBody` (~2082).
- Test: `controller/__tests__/controller-no-response.test.ts` (append)

**Interfaces:**
- Consumes: `capturedFailureText`, `GENERIC_NO_ANSWER`, `nonEmptyBody` (Task 2), `abortTerminal` (existing).
- Produces: no path writes a success terminal with an empty answer; `surfaceFinal` never yields an empty body; a dead-end replay returns the same non-empty error.

- [ ] **Step 1: Write the failing test**

Append to `controller-no-response.test.ts`:

```ts
describe('#243 Layer 2 empty-success guard', () => {
  it('an empty finalizer answer → error terminal + non-empty body, and replay returns the same', async () => {
    // A run that reaches finalize with an empty answer (finalize reply ''), no
    // captured failure → GENERIC_NO_ANSWER.
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do it' }],
      planner: [
        { kind: 'content', content: JSON.stringify({ plan: [{ name: 's1', instructions: 'go' }] }) },
        { kind: 'content', content: '' }, // finalize → EMPTY
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
    });
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const body = surfacedContent(captured);
    assert.ok(body);
    assert.notEqual(body.trim(), '', 'never an empty body');
    assert.match(body, new RegExp(GENERIC_NO_ANSWER));

    // Durable terminal is an error, never an empty success.
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    const term = await readTerminal(h.backend, 'sess-1', bundle.runId!, new Date().toISOString());
    assert.equal(term?.kind, 'error');

    // Replay the stored terminal → same non-empty error. The handler reads an
    // explicit key from `ctx.options.runId` (handler:307); with a terminal
    // present, classifyRequest returns `replay` (run-scope.ts:142).
    const replay = fakeCtx({ options: { runId: bundle.runId } } as never);
    await new ControllerCoordinatorHandler(h.deps).execute(replay.ctx, {}, undefined);
    const replayBody = surfacedContent(replay.captured);
    assert.ok(replayBody);
    // Replay must return the SAME durable error, not merely something non-empty.
    // abortTerminal surfaces `Error: ${error}` (handler:1901); here the error is
    // GENERIC_NO_ANSWER, and replay re-surfaces the stored error (handler:361).
    assert.equal(replayBody, body);
    assert.equal(replayBody, `Error: ${GENERIC_NO_ANSWER}`);
  });
});
```

Import `GENERIC_NO_ANSWER` at the top of the file:
`import { GENERIC_NO_ANSWER } from '../controller-coordinator-handler.js';`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A4 "Layer 2 empty-success"`
Expected: FAIL — the surfaced body is empty (`commitTerminalSuccess('')` wrote an empty success).

- [ ] **Step 3: Guard at the top of `commitTerminalSuccess`**

Insert immediately after the opening brace, before `await writeTerminal(...)`:

```ts
    // #243: never form a success terminal with an empty body. Route to an error
    // terminal carrying the captured failure (or a generic message).
    if (answer.trim().length === 0) {
      await this.abortTerminal(
        ctx,
        sessionId,
        bundle,
        capturedFailureText(bundle) ?? GENERIC_NO_ANSWER,
        now,
        terminalTtlMs,
        usage,
      );
      return;
    }
```

- [ ] **Step 4: Route `surfaceFinal` through `nonEmptyBody`**

```ts
  private surfaceFinal(
    ctx: PipelineContext,
    content: string,
    usage?: TerminalUsage,
  ): void {
    ctx.yield({
      ok: true,
      value: {
        content: nonEmptyBody(content),
        finishReason: 'stop',
        ...(usage ? { usage } : {}),
      },
    });
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A4 "Layer 2 empty-success"`
Expected: PASS.

- [ ] **Step 6: Full suite**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0` — existing terminal tests pass (non-empty content passes through unchanged).

- [ ] **Step 7: Build + lint, commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-no-response.test.ts
git commit -m "feat(controller): guard the success-terminal choke point + surfaceFinal net (#243)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `CHANGELOG.md`, `docs/TROUBLESHOOTING.md`
- Delete: the spec and this plan.

- [ ] **Step 1: CHANGELOG entry**

Under the unreleased `### Fixed`:

```markdown
- **Controller never terminates a run with `(no response)` (#243).** A tool-level
  error (object not found) or a per-step `maxToolCalls` cut could drive
  `control-failure → replan → empty`, returning an empty completion and
  discarding the captured error. The planner now signals a dead end on an empty
  replan over a control-failed step — before any finalizer call — and the
  controller surfaces the real failure text; no path can emit an empty success
  terminal (guarded at the single commit point plus a defensive net in the final
  surface). The captured text is read only from the failure marker, never from
  the internal planner scratchpad.
```

- [ ] **Step 2: TROUBLESHOOTING entry**

```markdown
### `controller` returns `(no response)` / empty body on a tool error or under concurrency

**Cause (before #243):** a failed step whose replan could not make progress
(`object not found`, or a per-step `maxToolCalls` cut under concurrency)
terminated the run with an empty body.

**Fix:** upgrade to the release containing #243. The controller surfaces the real
error (`Error: Class … not found`, or `tool-call budget exhausted (maxToolCalls)`).
A generic `The run ended without an answer.` means the failure predates the
marker (a resumed older bundle) — re-run the request.
```

- [ ] **Step 3: Verify documented claims against source**

```bash
grep -n "GENERIC_NO_ANSWER = " packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts
grep -n "kind: 'dead-end'" packages/llm-agent-server-libs/src/smart-agent/controller/types.ts packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts
```

- [ ] **Step 4: Delete spec and plan**

```bash
git rm docs/superpowers/specs/2026-07-24-controller-no-response-safety-net-design.md docs/superpowers/plans/2026-07-24-controller-no-response-safety-net.md
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/
git commit -m "docs: controller no-response safety-net (#243)"
```

---

## Final Verification

- [ ] `npm run build` — clean.
- [ ] `npm run lint:check` — clean (check, not format).
- [ ] `npm test` — compare against a `main` baseline before attributing any failure to this branch.
- [ ] Live gate (maintainer, both repros from #243): (A) a controller + SAP AI Core request reading a non-existent class → the response carries `Class … not found`, not `(no response)`, with **no finalizer token line** in the trace; (B) two concurrent single-tool lookups, repeated ~6×, → no `(no response)`, the budget-exhausted one surfaces the budget message.
- [ ] External code review before merge; merge only on the maintainer's explicit word.
