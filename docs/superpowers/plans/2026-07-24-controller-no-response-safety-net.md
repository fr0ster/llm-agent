# Controller No-Response Safety-Net Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The controller never terminates a run with `(no response)`; a failed step whose replan cannot progress surfaces the real tool error, and no path can emit an empty success.

**Architecture:** Two layers in `controller-coordinator-handler.ts`, both routing through the existing `abortTerminal`. Layer 1 (dead-end detector) surfaces the captured failure the moment a replan finalizes over an unresolved `control-failure`. Layer 2 (choke-point guard) rejects an empty answer inside `commitTerminalSuccess` — the sole writer of a success terminal — plus a defensive guard in `surfaceFinal`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22, `node:test` via `tsx`, Biome.

**Spec:** `docs/superpowers/specs/2026-07-24-controller-no-response-safety-net-design.md`

**Issue:** [#243](https://github.com/fr0ster/llm-agent/issues/243)

## Global Constraints

- All artifacts (code, comments, commit messages) in **English**.
- ESM only — relative imports end in `.js`.
- TypeScript strict; avoid `any` (Biome warns).
- Additive only — no existing exported signature becomes incompatible; new fields/params optional.
- Biome gate: `npm run lint:check` (a **check**, not `format`).
- Test command: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs` → `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`.
- `capturedFailureText` reads **only** the `controlFailure` marker — never `plannerPrivate` (it holds external-tool results and clarify answers; surfacing its tail would leak private context).
- Build before running: `npm run build` (workspace imports resolve to `dist/`).

## File Structure

- `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` — add optional `ControlFailure.note`.
- `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` — `cutControlFailure` sets `note`; `capturedFailureText` + `GENERIC_NO_ANSWER` (module-level, exported); Layer 1 detector; Layer 2 guard in `commitTerminalSuccess`; defensive guard in `surfaceFinal`.
- Tests:
  - `controller/__tests__/captured-failure-text.test.ts` (new) — pure helper.
  - `controller/__tests__/controller-no-response.test.ts` (new) — Symptoms A/B, guards, leak negatives, via `execute()` orchestration.

---

### Task 1: `ControlFailure.note` carries the failure text

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts:105-108`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (`cutControlFailure`, ~1313-1335)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-no-response.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `ControlFailure.note?: string`, set by `cutControlFailure` to `noteFor(reason)`.

- [ ] **Step 1: Write the failing test**

Create `controller/__tests__/controller-no-response.test.ts`. Copy the scaffolding
(`fakeCtx`, `scriptedClient`, `stubRag`, `stubEmbedder`, `baseConfig`, `harness`,
`toolCall`) from `controller-coordinator-handler.test.ts` lines 1-166, then add:

```ts
import { hydrateBundle } from '../session-bundle.js';

describe('#243 ControlFailure.note', () => {
  it('a tool-error control-failure records the raw text on the marker', async () => {
    // Executor asks for a tool; the MCP call returns a tool-level error.
    // That drives cutControlFailure(result.text) → note = the raw text.
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: read a class' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({ plan: [{ name: 's1', instructions: 'read' }] }),
        },
        { kind: 'content', content: JSON.stringify({ plan: [] }) }, // replan → empty
      ],
      executor: [toolCall('ReadClass', { name: 'ZZ_QX9B7' })],
      isExternalTool: () => false,
      selectTools: [{ name: 'ReadClass', description: '', inputSchema: {} }],
      callMcpReturns: { text: 'Class ZZ_QX9B7 not found', isError: true },
    });
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx, {}, undefined,
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.inFlightStep?.controlFailure?.note, 'Class ZZ_QX9B7 not found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A3 "ControlFailure.note"`
Expected: FAIL — `controlFailure.note` is `undefined` (field does not exist / not set).

- [ ] **Step 3: Add the `note` field**

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

- [ ] **Step 4: Set `note` in `cutControlFailure`**

In `controller-coordinator-handler.ts`, inside `cutControlFailure` where the
marker is built (`inFlight.controlFailure = { reason: typedReason, seq: inFlight.seq }`),
add `note`:

```ts
          inFlight.controlFailure = {
            reason: typedReason,
            seq: inFlight.seq,
            note: noteFor(reason),
          };
```

`noteFor` is already in scope (defined ~line 1042): it maps `maxToolCalls` /
`step-timeout` to their human sentences and passes any other string (a raw tool
error) through unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A3 "ControlFailure.note"`
Expected: PASS.

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-no-response.test.ts
git commit -m "feat(controller): record raw failure text on ControlFailure.note (#243)"
```

---

### Task 2: `capturedFailureText` helper + `GENERIC_NO_ANSWER`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (module-level exports)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/captured-failure-text.test.ts` (create)

**Interfaces:**
- Consumes: `ControlFailure.note` (Task 1), `SessionBundle`.
- Produces:
  - `export const GENERIC_NO_ANSWER = 'The run ended without an answer.'`
  - `export function capturedFailureText(bundle: SessionBundle): string | undefined`

- [ ] **Step 1: Write the failing test**

Create `controller/__tests__/captured-failure-text.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionBundle } from '../types.js';
import { capturedFailureText } from '../controller-coordinator-handler.js';

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

  it('treats a blank note as absent (falls through, no whitespace surface)', () => {
    assert.equal(capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0, note: '' })), undefined);
    assert.equal(capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0, note: ' \n\t ' })), undefined);
  });

  it('maps a legacy typed reason (no note) to its human sentence', () => {
    assert.equal(
      capturedFailureText(bundleWith({ reason: 'maxToolCalls', seq: 0 })),
      'tool-call budget exhausted (maxToolCalls)',
    );
    assert.equal(
      capturedFailureText(bundleWith({ reason: 'step-timeout', seq: 0 })),
      'step time budget exhausted (step-timeout)',
    );
  });

  it('a legacy generic marker (no note) → undefined', () => {
    assert.equal(capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0 })), undefined);
  });

  it('no marker → undefined', () => {
    assert.equal(capturedFailureText(bundleWith(undefined)), undefined);
  });

  it('NEVER surfaces plannerPrivate — external tool result / clarify / rewind tail', () => {
    // No marker note, but plannerPrivate ends in private context. Must stay undefined.
    for (const tail of [
      '\n[external tool ReadClass result] SECRET-PAYLOAD',
      '\n[clarify answer] my private prompt',
      '\n[rewind] backtracking',
    ]) {
      assert.equal(capturedFailureText(bundleWith(undefined, tail)), undefined);
      assert.equal(
        capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0 }, tail)),
        undefined,
      );
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A3 "capturedFailureText"`
Expected: FAIL — `capturedFailureText` is not exported.

- [ ] **Step 3: Implement the helper**

In `controller-coordinator-handler.ts`, at module level (near the other exports,
e.g. below the `parseNextStep` re-export line 219):

```ts
/** Consumer-facing fallback text when no failure text was captured. */
export const GENERIC_NO_ANSWER = 'The run ended without an answer.';

/**
 * The failure text to surface for a dead-ended run, read ONLY from the
 * controlFailure marker — never plannerPrivate, which holds external-tool
 * results and clarify answers whose tail would leak private context.
 *
 * A non-blank `note` wins (returned trimmed). A blank note is treated as absent.
 * A legacy marker without a note maps a typed reason to its human sentence; a
 * legacy generic marker has no bundle-local text we can trust → undefined, and
 * the caller falls back to GENERIC_NO_ANSWER.
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
```

Confirm `SessionBundle` is already imported in the file (it is — used
throughout). No new import needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A2 "capturedFailureText"`
Expected: PASS — 6 tests.

- [ ] **Step 5: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/captured-failure-text.test.ts
git commit -m "feat(controller): capturedFailureText reads only the marker, never plannerPrivate (#243)"
```

---

### Task 3: Layer 2 — success-answer guard in `commitTerminalSuccess`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (`commitTerminalSuccess`, ~2042-2065)
- Test: `controller/__tests__/controller-no-response.test.ts` (append)

**Interfaces:**
- Consumes: `capturedFailureText`, `GENERIC_NO_ANSWER` (Task 2), `abortTerminal` (existing).
- Produces: `commitTerminalSuccess` writes an error terminal for an empty answer, never a success terminal with an empty body.

- [ ] **Step 1: Write the failing test**

Append to `controller-no-response.test.ts`. This drives a real run where the
finalizer yields empty content — the scripted planner's finalize reply is `''`
(the `scriptedClient` default), and no captured failure exists, so the guard must
surface `GENERIC_NO_ANSWER`.

```ts
import { GENERIC_NO_ANSWER } from '../controller-coordinator-handler.js';

describe('#243 empty-success guard', () => {
  it('an empty finalizer answer surfaces GENERIC_NO_ANSWER, never an empty body', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do it' }],
      planner: [
        { kind: 'content', content: JSON.stringify({ plan: [{ name: 's1', instructions: 'go' }] }) },
        { kind: 'content', content: '' }, // finalize → EMPTY answer
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
    });
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const surfaced = captured.find(
      (c): c is { ok: true; value: { content: string } } =>
        c.ok === true && typeof (c.value as { content?: unknown }).content === 'string',
    );
    assert.ok(surfaced, 'a final chunk was surfaced');
    assert.notEqual(surfaced.value.content.trim(), '', 'body is never empty');
    assert.match(surfaced.value.content, new RegExp(GENERIC_NO_ANSWER));

    // Durable terminal is an error, not an empty success.
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.runState, 'terminal');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A4 "empty-success guard"`
Expected: FAIL — the surfaced content is empty (`(no response)`); `finalize`/`commitTerminalSuccess` wrote an empty success.

- [ ] **Step 3: Add the guard at the top of `commitTerminalSuccess`**

In `controller-coordinator-handler.ts`, `commitTerminalSuccess` begins:

```ts
  private async commitTerminalSuccess(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    answer: string,
    now: () => string,
    terminalTtlMs: number,
    usage?: TerminalUsage,
  ): Promise<void> {
```

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A4 "empty-success guard"`
Expected: PASS.

- [ ] **Step 5: Full suite (no regression on existing terminal tests)**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. Compare against a `main` baseline if any pre-existing failure appears.

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-no-response.test.ts
git commit -m "feat(controller): reject an empty success terminal at the commit choke point (#243)"
```

---

### Task 4: `surfaceFinal` defensive guard via a pure `nonEmptyBody`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (module-level `nonEmptyBody`; `surfaceFinal` uses it, ~2082-2090)
- Test: `controller/__tests__/captured-failure-text.test.ts` (append — same pure-helper file)

**Interfaces:**
- Consumes: `GENERIC_NO_ANSWER` (Task 2).
- Produces: `export function nonEmptyBody(content: string): string` — used by `surfaceFinal` so no path yields `ok:true` with empty/whitespace content.

Rationale for a pure helper: `surfaceFinal` is private, and the empty path that
would reach it (`replay` of a legacy empty-success terminal) needs an explicit
run key — without one, `classifyRequest` routes a post-terminal same-request call
to `fresh`, not `replay` (`run-scope.ts`). Extracting the trim decision into a
pure function makes the guarantee deterministically testable and keeps
`surfaceFinal` a one-liner over it.

- [ ] **Step 1: Write the failing test**

Append to `captured-failure-text.test.ts`:

```ts
import { nonEmptyBody, GENERIC_NO_ANSWER } from '../controller-coordinator-handler.js';

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

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A3 "nonEmptyBody"`
Expected: FAIL — `nonEmptyBody` is not exported.

- [ ] **Step 3: Implement `nonEmptyBody` and use it in `surfaceFinal`**

Add at module level, beside `GENERIC_NO_ANSWER`:

```ts
/** #243 last-ditch net: an empty/whitespace body becomes GENERIC_NO_ANSWER, so
 *  no code path can yield ok:true with an empty body. */
export function nonEmptyBody(content: string): string {
  return content.trim().length === 0 ? GENERIC_NO_ANSWER : content;
}
```

Change `surfaceFinal` to route through it:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A2 "nonEmptyBody"`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0` — existing terminal tests still pass (non-empty content is passed through unchanged).

- [ ] **Step 6: Build + lint, then commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/captured-failure-text.test.ts
git commit -m "feat(controller): surfaceFinal routes through nonEmptyBody — never an empty body (#243)"
```

---

### Task 5: Layer 1 — dead-end detector surfaces the real error

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (before `if (next.kind === 'done')`, ~871)
- Test: `controller/__tests__/controller-no-response.test.ts` (append)

**Interfaces:**
- Consumes: `capturedFailureText`, `GENERIC_NO_ANSWER` (Task 2), `abortTerminal`, `ControlFailure.note` (Task 1).
- Produces: a replan that finalizes over an unresolved `control-failure` terminates with the captured failure text, not a finalizer pass.

- [ ] **Step 1: Write the failing test**

Append the two symptoms. Without Layer 1, Task 3's guard already prevents an
*empty* body — but if the finalizer returns non-empty hallucinated content the
consumer would get that instead of the real error. Layer 1 guarantees the real
tool error is surfaced. Script the finalize reply as non-empty to prove Layer 1
(not Layer 3) is doing the work.

```ts
describe('#243 dead-end detector (Layer 1)', () => {
  it('Symptom A: tool error → replan-empty surfaces the real error, not a finalizer answer', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: read a class, report errors' }],
      planner: [
        { kind: 'content', content: JSON.stringify({ plan: [{ name: 's1', instructions: 'read' }] }) },
        { kind: 'content', content: JSON.stringify({ plan: [] }) },       // replan → empty
        { kind: 'content', content: 'I could not find anything relevant.' }, // finalize (should NOT be used)
      ],
      executor: [toolCall('ReadClass', { name: 'ZZ_QX9B7' })],
      isExternalTool: () => false,
      selectTools: [{ name: 'ReadClass', description: '', inputSchema: {} }],
      callMcpReturns: { text: 'Class ZZ_QX9B7 not found', isError: true },
    });
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const surfaced = captured.find(
      (c): c is { ok: true; value: { content: string } } =>
        c.ok === true && typeof (c.value as { content?: unknown }).content === 'string',
    );
    assert.ok(surfaced);
    assert.match(surfaced.value.content, /Class ZZ_QX9B7 not found/);
    assert.doesNotMatch(surfaced.value.content, /could not find anything relevant/);
  });

  it('Symptom B: maxToolCalls cut → replan-empty surfaces the budget message', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: look it up' }],
      planner: [
        { kind: 'content', content: JSON.stringify({ plan: [{ name: 's1', instructions: 'look' }] }) },
        { kind: 'content', content: JSON.stringify({ plan: [] }) },  // replan → empty
        { kind: 'content', content: 'done anyway' },                 // finalize (should NOT be used)
      ],
      executor: [
        toolCall('Look', {}), toolCall('Look', {}), toolCall('Look', {}),
      ],
      isExternalTool: () => false,
      selectTools: [{ name: 'Look', description: '', inputSchema: {} }],
      config: baseConfig({ maxToolCalls: 2 }),
    });
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const surfaced = captured.find(
      (c): c is { ok: true; value: { content: string } } =>
        c.ok === true && typeof (c.value as { content?: unknown }).content === 'string',
    );
    assert.ok(surfaced);
    assert.match(surfaced.value.content, /tool-call budget exhausted \(maxToolCalls\)/);
    assert.doesNotMatch(surfaced.value.content, /done anyway/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A4 "dead-end detector"`
Expected: FAIL — the finalizer answer (`could not find…` / `done anyway`) is surfaced instead of the real error, because nothing intercepts the finalize-over-control-failure.

- [ ] **Step 3: Insert the Layer 1 detector**

In `controller-coordinator-handler.ts`, immediately **before** `if (next.kind === 'done') {` (~line 871):

```ts
      // #243 Layer 1: the planner is finalizing (done) but the in-flight step
      // control-failed and the replan produced no forward progress — a dead end.
      // Surface the captured failure instead of letting the finalizer compose an
      // answer over a failure. planner.ts does not clear inFlightStep, so the
      // marker is still here.
      if (next.kind === 'done' && bundle.inFlightStep?.controlFailure) {
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

`logDecision`, `now`, `terminalTtlMs`, `usageNow` are all in scope at this site
(the neighbouring `next.kind === 'error'` branch uses the same set).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -A4 "dead-end detector"`
Expected: PASS — both symptoms surface the real error.

- [ ] **Step 5: Full suite + baseline check**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. If a pre-existing controller test now fails, confirm it fails on `main` too before attributing it here — a legit `done` after a successful recovery must still finalize (the detector only fires when `controlFailure` is set, i.e. the last step was an unresolved failure).

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-no-response.test.ts
git commit -m "feat(controller): surface the real error when a replan dead-ends over a control-failure (#243)"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Delete: the spec and this plan.

- [ ] **Step 1: CHANGELOG entry**

Under the unreleased `### Fixed`:

```markdown
- **Controller never terminates a run with `(no response)` (#243).** A tool-level
  error (object not found) or a per-step `maxToolCalls` cut could drive
  `control-failure → replan → empty`, returning an empty completion and
  discarding the captured error. The controller now surfaces the real failure
  text when a replan dead-ends over a control-failure, and no path can emit an
  empty success terminal (guarded at the single commit point plus a defensive
  net in the final surface). The captured text is read only from the failure
  marker, never from the internal planner scratchpad.
```

- [ ] **Step 2: TROUBLESHOOTING entry**

Follow the symptom → cause → fix format:

```markdown
### `controller` returns `(no response)` / empty body on a tool error or under concurrency

**Cause (before #243):** a failed step whose replan could not make progress
(`object not found`, or a per-step `maxToolCalls` cut under concurrency)
terminated the run with no finalizer and an empty body.

**Fix:** upgrade to the release containing #243. The controller surfaces the real
error (`Error: Class … not found`, or `tool-call budget exhausted (maxToolCalls)`)
instead of an empty completion. If you still see a generic
`The run ended without an answer.`, the failure predates the marker (a resumed
older bundle) — re-run the request.
```

- [ ] **Step 3: Verify every documented claim against source**

```bash
grep -n "GENERIC_NO_ANSWER = " packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts
grep -n "note?: string" packages/llm-agent-server-libs/src/smart-agent/controller/types.ts
```

Confirm the surfaced strings in the docs match the code (`GENERIC_NO_ANSWER`
value, the `maxToolCalls` human sentence from `noteFor`).

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
- [ ] Live gate (maintainer, both repros from #243): (A) a controller + SAP AI Core request reading a non-existent class → the response carries `Class … not found`, not `(no response)`; (B) two concurrent single-tool lookups, repeated ~6×, → no `(no response)`, the budget-exhausted one surfaces the budget message.
- [ ] External code review before merge; merge only on the maintainer's explicit word.
