# Controller: tool errors reach the planner / consumer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a delivered MCP tool error (e.g. a locked SAP object) actually acted on — the controller cuts the step immediately on the first `isError:true` tool round, and the planner decides (replan within the prompt's freedom, or a new `error` decision that surfaces the real failure to the consumer) — closing the #213 retry/confabulation loop.

**Architecture:** Three layers on existing components. **Layer 1 (immediate cut):** at the `callMcp` site the handler already observes `result.isError` (PR #232); the first failing tool round now `return cutControlFailure(result.text)` — the executor tool-loop stops, the reviewer never runs, the step settles `failed`, and the durable `step-result` + `plannerPrivate` note carry the failure across resume. **Layer 2 (`error` decision):** `parsePlan`/`callPlan` widen to `Step[] | { kind:'error'; error:string } | null`; `SmartExecutorPlanner.next()` propagates it as a new `NextStep` variant; the handler terminates the run via `abortTerminal` returning the real tool error. A plan/replan prompt rule teaches the planner when to emit it. **Layer 3 (flat):** no new default code — the #232 enabler already makes the error visible (`ToolRound.meta.isError`, error text in tool content); deterministic surfacing stays the consumer's `IOutputValidator`.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 22, `node --test` + `tsx/esm`, Biome. Monorepo package: `@mcp-abap-adt/llm-agent-server-libs` (controller lives under `src/smart-agent/controller/`).

## Global Constraints

- **Branch:** `fix/issue-213-mcp-iserror` (extends PR #232). Do NOT create a new branch.
- **ESM only** — `.js` extensions in all relative imports; `"type":"module"`.
- **Canonical `error` wire shape (single, enforced):** the planner emits exactly `{ "kind": "error", "error": "<text>" }` in its plan/replan reply. A bare `{ "error": … }` without `kind` is NOT accepted → `parsePlan` returns `null` → format failure → planner retries.
- **No error taxonomy.** No built-in "lock→retryable / auth→fatal" classifier. The planner (an LLM) classifies by reasoning, or we defer to the consumer. Do NOT add a keyword/regex error classifier anywhere.
- **No run-level tool-call ceiling / repeat-detector.** Rejected earlier as a workaround; do not add one.
- **Immediate cut reuses `cutControlFailure`, never `settleStep` alone.** Order (mirroring the existing helper): `stepsUsed++` → `writeControlFailure(errorText)` (writes the durable `step-result` artifact, `status:'failed'`) → append to `bundle.plannerPrivate` → set `inFlightStep.controlFailure` → `settleStep('failed')`. `settleStep` alone does NOT write the step-result artifact — using it alone would lose the durable carrier.
- **Durable carrier = failed step-result + `plannerPrivate`, NOT the `mcp-result` artifact.** Under immediate cut the round may never reach `strategy.record(round)`, so `mcp-result` is not written. Do not rely on it for resume.
- **`error` is additive.** `NextStep`'s existing `next/done/rewind` behaviour is unchanged; `error` is a new fourth variant. `WeakExecutorPlanner` inherits everything from `SmartExecutorPlanner`.
- **Deterministic guarantee is controller-only.** The flat pipeline gets NO new default enforcement in this deliverable — only the already-shipped #232 visibility. Do not add flat-specific enforcement.
- **All artifacts in English** (code, comments, commits). Conventional Commits.
- Run a SINGLE test file: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/<file>.test.ts`. Run the controller test DIRECTORY: `… 'src/smart-agent/controller/__tests__/*.test.ts'`. Do NOT run the whole-package `npm test` (globs `src/**/*.test.ts`) — it is known to hang on the unrelated `chat-endpoint.test.ts` / `config-endpoints.test.ts` (see Task 6). Use targeted file/directory runs throughout.

---

## File map

| File | Responsibility | Tasks |
|------|----------------|-------|
| `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` | Layer 1 immediate cut at the callMcp site; Layer 2 `next.kind==='error'` terminal | 1, 3 |
| `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` | `NextStep` gains `{kind:'error';error:string}` | 2 |
| `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts` | `parsePlan`/`callPlan` widen; `next()` propagates error; CREATE/REPLAN prompt rule | 2, 4 |
| `packages/llm-agent-server-libs/src/smart-agent/controller/parser.ts` | keep test-only `parseNextStep` in sync with the new `NextStep` variant | 2 |
| `.../controller/__tests__/controller-coordinator-handler.test.ts` | immediate-cut + `error`-terminal handler tests; widen harness `callMcpReturns` type | 1, 3 |
| `.../controller/__tests__/planner.test.ts` | `parsePlan` error-decision parser tests + `next()` propagation | 2 |
| `.../controller/__tests__/prompts.test.ts` (or `planner.test.ts`) | prompt-rule assertion | 4 |

Layer 3 (flat) needs no implementation: the visibility guarantee already ships in `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` and is covered by `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-timing-log.test.ts` (`isError:true` on a failed call). Task 5 adds one focused assertion that the flat `ToolRound.meta.isError` is set, satisfying the spec's flat testing bullet.

---

## Task 1: Immediate cut at the callMcp site (Layer 1)

The highest-value, self-contained change: stop the #213 loop by cutting the step on the first `isError:true` tool round. No dependency on later tasks.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (insert after the `mcp_tool_call` success log, ~line 1631, before the `// Record this exchange…` round build at ~line 1632)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts` (widen harness `callMcpReturns` type; add the cut test)

**Interfaces:**
- Consumes (already in scope inside `runStep`): `cutControlFailure(reason: string): Promise<'advanced'|'failed'|'partial'>` (defined ~line 1289; it runs `stepsUsed++` → `writeControlFailure(note)` → `plannerPrivate` append → `settleStep('failed')`); `result: McpCallResult` with `{ text: string; isError: boolean }` (obtained at ~line 1584); the enclosing `while (true)` tool loop. Test-side: the injectable `h.deps.reviewer` (`IReviewer` from `./reviewer.js`, injected post-`harness()` per the pattern at test ~line 1459) and `h.rag.written` (the `KnowledgeEntry[]` capturing every artifact write).
- Produces: no new exported symbol — a behavioural change (`return cutControlFailure(result.text)` on a delivered tool error).

- [ ] **Step 1: Widen the harness `callMcpReturns` type so a test can deliver `isError:true`**

The harness already wraps a non-string into a `McpCallResult` (`typeof r === 'string' ? { text: r, isError: false } : r`) — only the TYPE annotation is `string`. In `controller-coordinator-handler.test.ts`, change the `harness` options type (~line 126):

```ts
  callMcpReturns?: string | { text: string; isError: boolean };
```

No other harness change is needed — the wrapping ternary at ~line 146 already handles the object case.

- [ ] **Step 2: Write the failing test — a delivered tool error cuts the step, no retry, no confabulation, and writes the durable carrier**

Add to `controller-coordinator-handler.test.ts` inside the `describe('ControllerCoordinatorHandler', …)` block. Follow the existing `harness` / `fakeCtx` / `hydrateBundle` patterns already used in the file. The reviewer spy uses the same `h.deps.reviewer = { async review() {…} }` injection pattern already used at ~line 1459 of this file (no harness change needed).

The durable-carrier assertion is LOAD-BEARING: an implementation that calls `settleStep('failed')` WITHOUT `writeControlFailure` would still set `stepsUsed`/`plannerPrivate` yet lose the board's `step-result` artifact. This test must fail such an implementation — so it asserts a `step-result` artifact with `status:'failed'` and the tool error text (via `metadata.note`) in `h.rag.written`, exactly as the existing control-failure tests do (see ~lines 2387, 2528).

```ts
  it('#213 cut: first isError:true tool round settles failed — no retry, no confabulation, no reviewer, durable step-result', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        // create-plan: one tool step
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'update the object' }],
          }),
        },
        // replan after the cut (lastOutcome='failed'): nothing left → finalize
        { kind: 'content', content: JSON.stringify({ plan: [] }) },
        // finalize text (plain text → done result)
        { kind: 'content', content: 'the object is locked; not updated' },
      ],
      executor: [
        toolCall('UpdateObj', { name: 'ZOBJ' }),
        // A confabulated "success" summary the executor WOULD emit on the next
        // round — must never be consumed, because the cut ends the tool loop.
        { kind: 'content', content: 'updated successfully' },
      ],
      selectTools: [{ name: 'UpdateObj', description: '', inputSchema: {} }],
      isExternalTool: () => false,
      callMcpReturns: { text: 'ZOBJ is locked by user ALICE', isError: true },
    });
    // Reviewer spy: proves the reviewer is NOT invoked for a cut step (the
    // executor tool-loop is cut before any content round reaches the reviewer).
    let reviewCalls = 0;
    h.deps.reviewer = {
      async review() {
        reviewCalls++;
        return {
          kind: 'outcome',
          outcome: { status: 'ok', approved: '', remainder: '' },
        };
      },
    };
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    // 1. The tool was called exactly once — NOT retried on the locked object.
    assert.equal(h.mcpCalls.length, 1);
    // 2. The reviewer was never invoked (the step was cut, not reviewed).
    assert.equal(reviewCalls, 0, 'reviewer must NOT run for a cut step');
    // 3. No confabulation: the run never surfaces the executor's "updated
    //    successfully" summary (that round is never reached).
    assert.ok(
      !captured.some((c) => c.ok && c.value.content === 'updated successfully'),
      'confabulated success summary must never be surfaced',
    );
    // 4. Durable carrier: a 'failed' step-result artifact carrying the tool
    //    error text was written (via writeControlFailure) — NOT settleStep alone.
    const failed = h.rag.written.filter(
      (e) =>
        e.metadata.artifactType === 'step-result' &&
        e.metadata.status === 'failed',
    );
    assert.ok(failed.length >= 1, 'a failed step-result artifact was written');
    assert.match(
      String(failed[0].metadata.note ?? ''),
      /ZOBJ is locked by user ALICE/,
      'the failed step-result carries the tool error text',
    );
    // 5. stepsUsed bumped + the tool error text is in the durable plannerPrivate.
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.stepsUsed, 1);
    assert.match(bundle.plannerPrivate, /ZOBJ is locked by user ALICE/);
    assert.match(bundle.plannerPrivate, /control-failed/);
  });
```

- [ ] **Step 3: Run the test to verify it FAILS**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: FAIL — without the cut, the executor is re-invoked after the failed tool round, `h.mcpCalls.length` may exceed 1 and/or "updated successfully" is surfaced, and `plannerPrivate` lacks the `control-failed` note.

- [ ] **Step 4: Implement the cut**

In `controller-coordinator-handler.ts`, immediately AFTER the `mcp_tool_call` success `logStep(...)` call closes (~line 1631) and BEFORE the `// Record this exchange as a coherent assistant→tool ROUND` comment (~line 1632), insert:

```ts
        // #213 immediate cut: a delivered tool-level error ends the step NOW.
        // The executor tool-loop does NOT continue (no further tool call, no
        // reviewer for this step); reuse cutControlFailure so the step settles
        // 'failed' with the tool's error text and the planner replans / surfaces
        // it. Read result.isError directly here — BEFORE the round reaches the
        // context strategy — so no Message/meta replay is needed. The durable
        // failed step-result + plannerPrivate note (written by cutControlFailure)
        // ARE the resume carrier; the mcp-result artifact is intentionally not
        // relied on (the cut may never call strategy.record).
        if (result.isError) {
          return cutControlFailure(result.text);
        }
```

- [ ] **Step 5: Run the test to verify it PASSES**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: PASS — the new test and all existing handler tests (a successful call has `isError:false`, so the cut never fires on the happy path).

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
git commit -m "fix(controller): cut the step on the first isError:true tool round (#213)"
```

---

## Task 2: The planner's `error` decision — `NextStep` variant + `parsePlan`/`callPlan`/`next()` (Layer 2 plumbing)

Widen the contract on the REAL path so the planner can emit an `error` decision that the handler will surface (Task 3 consumes it). Verified against code: `SmartExecutorPlanner.next()` uses `callPlan → parsePlan`, NOT the test-only `parseNextStep`.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` (`NextStep` union, ~line 62)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts` (`parsePlan` ~line 182; `callPlan` return type ~line 396 + return at ~432; `next()` create branch ~259 and replan branch ~302)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/parser.ts` (`parseNextStep` ~line 7 — keep the test-only parser in sync)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`

**Interfaces:**
- Produces:
  - `type PlanError = { kind: 'error'; error: string }` — new, exported from `types.ts`.
  - `NextStep = { kind:'next'; step:Step } | { kind:'done'; result:string } | { kind:'rewind'; reason:string } | { kind:'error'; error:string }`.
  - `parsePlan(content: string): Step[] | PlanError | null` (was `Step[] | null`).
  - `SmartExecutorPlanner.next(): Promise<NextStep | null>` may now return `{ kind:'error', error }`.
- Consumes: existing `extractJsonObject`, `validateRequires`, `Step`.

- [ ] **Step 1: Write the failing parser tests**

Add to `planner.test.ts` (it already imports `parsePlan` from `../planner.js`). Add a new `describe`:

```ts
describe('parsePlan — error decision (#213)', () => {
  it('parses the canonical {"kind":"error","error":…} to a PlanError', () => {
    const r = parsePlan(JSON.stringify({ kind: 'error', error: 'ZD is taken' }));
    assert.deepEqual(r, { kind: 'error', error: 'ZD is taken' });
  });

  it('rejects a bare {"error":…} without kind → null (format failure → retry)', () => {
    const r = parsePlan(JSON.stringify({ error: 'ZD is taken' }));
    assert.equal(r, null);
  });

  it('still parses a normal {"plan":[…]} to Step[] unchanged', () => {
    const r = parsePlan(
      JSON.stringify({ plan: [{ name: 's1', instructions: 'do' }] }),
    );
    assert.ok(Array.isArray(r));
    assert.equal((r as unknown[]).length, 1);
    assert.deepEqual(r, [{ name: 's1', instructions: 'do' }]);
  });

  it('rejects {"kind":"error"} with a non-string error → null', () => {
    const r = parsePlan(JSON.stringify({ kind: 'error', error: 42 }));
    assert.equal(r, null);
  });
});
```

- [ ] **Step 2: Run the parser tests to verify they FAIL**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/planner.test.ts`
Expected: FAIL — `parsePlan` currently returns `null` for `{"kind":"error",…}` (no `plan` array), so the first test fails.

- [ ] **Step 3: Add the `error` variant to `NextStep` and export `PlanError`**

In `types.ts`, replace the `NextStep` union (~line 62) with:

```ts
/** The planner's cannot-proceed decision: a failure it cannot fix within the
 *  consumer's constraints (a pinned name that is taken, an unauthorized op, a
 *  lock that will not clear). The handler terminates the run and returns this
 *  real error to the consumer — distinct from the generic abort reasons. */
export type PlanError = { kind: 'error'; error: string };

export type NextStep =
  | { kind: 'next'; step: Step }
  | { kind: 'done'; result: string }
  | { kind: 'rewind'; reason: string }
  | PlanError;
```

- [ ] **Step 4: Teach `parsePlan` and `callPlan` the error decision**

In `planner.ts`, import `PlanError` alongside the other type imports from `./types.js` (add `type PlanError,` to the existing import block ~lines 13-23).

Replace the `parsePlan` body (~line 182) so it recognises the canonical error shape BEFORE the plan-array check:

```ts
export function parsePlan(content: string): Step[] | PlanError | null {
  const json = extractJsonObject(content);
  if (json === null) return null;
  try {
    const obj = JSON.parse(json) as {
      plan?: unknown;
      kind?: unknown;
      error?: unknown;
    };
    // Canonical cannot-proceed decision. Enforced shape: BOTH kind:'error' AND a
    // string error. A bare {"error":…} without kind falls through to the plan
    // check → null → format failure → planner retries (per the spec).
    if (obj.kind === 'error' && typeof obj.error === 'string') {
      return { kind: 'error', error: obj.error };
    }
    if (!Array.isArray(obj.plan)) return null;
    const steps: Step[] = [];
    for (const raw of obj.plan) {
      const s = raw as Partial<Step>;
      if (typeof s.name !== 'string' || typeof s.instructions !== 'string') {
        return null; // malformed step → format failure (handler retries)
      }
      const req = validateRequires((raw as { requires?: unknown }).requires);
      if (req === false) return null; // malformed requires → format failure → retry
      const isWait = s.type === 'wait';
      const waitMs = (raw as { waitMs?: unknown }).waitMs;
      if (isWait && !isPositiveFiniteInt(waitMs)) return null;
      steps.push({
        name: s.name,
        instructions: s.instructions,
        ...(s.type ? { type: s.type } : {}),
        ...(req ? { requires: req } : {}),
        ...(isWait ? { waitMs: waitMs as number } : {}),
      });
    }
    return steps;
  } catch {
    return null;
  }
}
```

Widen `callPlan`'s return type (~line 396) and its final return already forwards `parsePlan`. Add a small type guard near the top of the file (after the imports, before `SmartExecutorPlanner`) so `next()` can discriminate:

```ts
/** True when a plan-response is the cannot-proceed error decision (§Layer 2). */
function isPlanError(x: Step[] | PlanError | null): x is PlanError {
  return x !== null && !Array.isArray(x) && x.kind === 'error';
}
```

Change the `callPlan` signature return type from `Promise<Step[] | null>` to `Promise<Step[] | PlanError | null>` (~line 396). Its body's final line `return parsePlan(res.content);` already returns the widened union — no other change inside `callPlan`.

- [ ] **Step 5: Propagate the error from `next()` at BOTH callPlan sites**

In `SmartExecutorPlanner.next()`:

Create branch — after `const plan = await this.callPlan(…)` (~line 259, before the `if (plan === null || plan.length === 0)` check at ~line 273), insert:

```ts
      if (isPlanError(plan)) return { kind: 'error', error: plan.error };
```

Replan branch — after `const rest = await this.callPlan(…)` (~line 302, before `if (rest === null) return null;` at ~line 312), insert:

```ts
      if (isPlanError(rest)) return { kind: 'error', error: rest.error };
```

(The subsequent `plan.length` / `rest === null` checks then operate on a `Step[] | null` as before, because the `PlanError` case has already returned.)

- [ ] **Step 6: Keep the test-only `parseNextStep` in sync**

In `parser.ts`, inside `parseNextStep` (~line 11), add the `error` case alongside `done`/`rewind` (before the `next` case), so the two parsers agree:

```ts
    if (obj.kind === 'error' && typeof obj.error === 'string')
      return { kind: 'error', error: obj.error };
```

- [ ] **Step 7: Add the `next()` propagation test**

Add to `planner.test.ts` (it already imports `SmartExecutorPlanner` and has a `planner(queue)` / `bundle()` helper):

```ts
describe('SmartExecutorPlanner.next — error propagation (#213)', () => {
  it('create-plan error decision → NextStep {kind:error}', async () => {
    const p = new SmartExecutorPlanner(
      planner([
        { kind: 'content', content: JSON.stringify({ kind: 'error', error: 'pinned name ZD_X is taken' }) },
      ]),
    );
    const b = bundle();
    const r = await p.next({ bundle: b, prompt: 'create ZD_X', retrying: false });
    assert.deepEqual(r, { kind: 'error', error: 'pinned name ZD_X is taken' });
  });

  it('replan error decision → NextStep {kind:error}', async () => {
    const p = new SmartExecutorPlanner(
      planner([
        { kind: 'content', content: JSON.stringify({ kind: 'error', error: 'lock will not clear' }) },
      ]),
    );
    const b = bundle();
    b.plan = [{ name: 's1', instructions: 'do' }];
    b.planCursor = 0;
    const r = await p.next({
      bundle: b,
      prompt: 'x',
      retrying: false,
      lastOutcome: 'failed',
    });
    assert.deepEqual(r, { kind: 'error', error: 'lock will not clear' });
  });
});
```

- [ ] **Step 8: Run the tests to verify they PASS**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/planner.test.ts src/smart-agent/controller/__tests__/types.test.ts`
Expected: PASS — parser recognises the canonical shape, rejects the bare `{"error":…}`, plans still parse; both `next()` propagation tests pass.

- [ ] **Step 9: Typecheck the handler still compiles against the widened `NextStep`**

Run: `cd packages/llm-agent-server-libs && npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`
Expected: a compile error at the `next.kind` handling in `controller-coordinator-handler.ts` IF the handler does not yet handle `error` (the `next.step` access after the `done`/`rewind` guards now includes the `error` case). This is EXPECTED and is fixed in Task 3. If `tsc` is clean here (the handler treats the fall-through as `next`), Task 3's terminal branch is still required for correct behaviour — proceed to Task 3 regardless.

- [ ] **Step 10: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/parser.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
git commit -m "feat(controller): planner error decision — parsePlan/next() emit {kind:error} (#213)"
```

---

## Task 3: Handler terminates on `next.kind === 'error'`, returning the real tool error (Layer 2 terminal)

Consume the new variant: an `error` decision ends the run and surfaces the actual failure text, distinct from the generic `abortTerminal` reasons and never `(no response)`.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (the `next.kind` switch, after the `next === null` check at ~line 848 and before the `done` branch at ~line 852)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`

**Interfaces:**
- Consumes: `NextStep`'s new `{ kind:'error'; error:string }` (Task 2); `this.abortTerminal(ctx, sessionId, bundle, error, now, terminalTtlMs, usage)` (~line 1843) which writes a terminal `{ kind:'error', error }`, sets `runState='terminal'`, and surfaces `Error: ${error}`; the in-scope `now` / `terminalTtlMs` / `usageNow()` used by the sibling abort sites (e.g. ~line 901).
- Produces: behavioural — an `error` decision → terminal run returning the tool failure to the consumer.

- [ ] **Step 1: Write the failing test — an `error` decision terminates with the real error**

Add to `controller-coordinator-handler.test.ts`:

```ts
  it('#213 planner error decision terminates the run with the real tool error', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        // create-plan emits the cannot-proceed error decision directly
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'error',
            error: 'domain ZD_YTEST already exists (name pinned by request)',
          }),
        },
      ],
      executor: [],
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    // The consumer receives the REAL failure, not (no response) / a generic abort.
    assert.ok(
      captured.some(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          /domain ZD_YTEST already exists/.test(c.value.content),
      ),
      'the real tool error must reach the consumer',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.runState, 'terminal');
  });
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: FAIL — without the terminal branch, `next.kind==='error'` falls through to the `next.kind === 'next'` path and dereferences `next.step` (undefined) or mishandles the decision; the real error never surfaces.

- [ ] **Step 3: Add the `error` terminal branch**

In `controller-coordinator-handler.ts`, immediately after `resumedExternal = false;` (~line 850) and BEFORE `if (next.kind === 'done') {` (~line 852), insert:

```ts
      if (next.kind === 'error') {
        // The planner saw a failure it cannot fix within the consumer's
        // constraints (a pinned name that is taken, an unauthorized op, a lock
        // that will not clear). Terminate the run and return the REAL tool error
        // to the consumer — distinct from the generic abortTerminal reasons and
        // never (no response). (#213)
        logDecision(ctx, 'planner-error', next.error);
        await this.abortTerminal(
          ctx,
          sessionId,
          bundle,
          next.error,
          now,
          terminalTtlMs,
          usageNow(),
        );
        return true;
      }
```

`logDecision(ctx, kind, reason, extra?)` is a local helper (defined ~line 95) taking a free-form `kind: string` — no tag allow-list — so `'planner-error'` is valid as-is (it becomes the session-step name `controller_decision_planner-error`). Reuse the same call shape as the sibling sites (e.g. ~line 900 `logDecision(ctx, 'retry-exhausted', reason)`).

- [ ] **Step 4: Run the test to verify it PASSES + typecheck**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: the new test passes, all existing handler tests pass, `tsc` is clean (the `next.step` access is now unreachable for the `error` case).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
git commit -m "feat(controller): terminate run on planner error decision, surface real tool error (#213)"
```

---

## Task 4: Plan/replan prompt rule teaching the error decision (Layer 2 behaviour)

Give the planner the reasoning: on a tool failure, decide whether it is fixable within what the consumer asked; if not, emit the `error` decision instead of a `{"plan":[…]}`. AGNOSTIC — no tool names, no error taxonomy.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts` (add a constant clause; append to `CREATE_PLAN_SYSTEM` ~line 80 and `REPLAN_SYSTEM` ~line 111)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`

**Interfaces:**
- Consumes: the existing exported prompt constants (`CREATE_PLAN_SYSTEM`, `REPLAN_SYSTEM`) and the derivation into `SMART_*` / `WEAK_*` (unchanged — they concatenate the base, so the rule flows into all four automatically).
- Produces: `ERROR_DECISION_RULE` (exported const) folded into both base prompts.

- [ ] **Step 1: Write the failing prompt test**

Add to `planner.test.ts` (it imports `CREATE_PLAN_SYSTEM`, `REPLAN_SYSTEM`, and the `SMART_*`/`WEAK_*` variants):

```ts
describe('error-decision prompt rule (#213)', () => {
  it('CREATE and REPLAN prompts teach the {"kind":"error"} decision', () => {
    for (const p of [CREATE_PLAN_SYSTEM, REPLAN_SYSTEM]) {
      assert.match(p, /"kind"\s*:\s*"error"/);
      assert.match(p, /fixable/i);
    }
  });

  it('the rule flows into all smart/weak variants', () => {
    for (const p of [
      SMART_CREATE_PLAN_SYSTEM,
      SMART_REPLAN_SYSTEM,
      WEAK_CREATE_PLAN_SYSTEM,
      WEAK_REPLAN_SYSTEM,
    ]) {
      assert.match(p, /"kind"\s*:\s*"error"/);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/planner.test.ts`
Expected: FAIL — the prompts do not yet mention `"kind":"error"`.

- [ ] **Step 3: Add the rule and fold it into both base prompts**

In `planner.ts`, add this constant just before `CREATE_PLAN_SYSTEM` (~line 79, after `WAIT_STEP_RULE`):

```ts
/** Error-decision clause (#213). On a tool FAILURE, the planner reasons whether
 *  the failure is fixable within the consumer's request: something WE chose (a
 *  self-picked object name that is taken) is fixable → replan; something the
 *  CONSUMER pinned (a name given in the request, an unauthorized operation, a
 *  lock that will not clear) is a constraint we cannot change → emit the error
 *  decision so the real failure reaches the consumer. AGNOSTIC: no tool names,
 *  no built-in error taxonomy — the planner classifies by reasoning. */
const ERROR_DECISION_RULE =
  ' On a tool FAILURE, decide whether it is fixable within what the consumer ' +
  'asked: if the problem is with something YOU chose (e.g. a name you picked ' +
  'that is already taken), fix it and return a normal {"plan":[…]}. If the ' +
  'problem is with a constraint the CONSUMER fixed in the request (a name they ' +
  'gave, an operation they are not allowed to perform, a lock that will not ' +
  'clear) and you CANNOT resolve it within the request, return exactly ' +
  '{"kind":"error","error":"<the failure, in the user\'s language>"} INSTEAD of ' +
  'a plan. Output JSON only.';
```

Append `+ ERROR_DECISION_RULE` to `CREATE_PLAN_SYSTEM` (after `ENGLISH_INSTRUCTIONS_RULE` at ~line 109) and to `REPLAN_SYSTEM` (after `ENGLISH_INSTRUCTIONS_RULE` at ~line 120):

```ts
// CREATE_PLAN_SYSTEM tail (~line 108):
  WAIT_STEP_RULE +
  ENGLISH_INSTRUCTIONS_RULE +
  ERROR_DECISION_RULE;

// REPLAN_SYSTEM tail (~line 120):
  ENGLISH_INSTRUCTIONS_RULE +
  ERROR_DECISION_RULE;
```

Do NOT touch `EXTERNAL_RESULT_REPLAN_SYSTEM` — an external result is explicitly NOT a failure, so the error-decision rule does not apply there. The `SMART_*` / `WEAK_*` constants derive by concatenation from the two base prompts, so the rule flows in automatically (the second test asserts this).

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/planner.test.ts`
Expected: PASS. Any existing prompt-snapshot test that pins the exact prompt text will now differ — update that snapshot to include the new clause (the change is intentional).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
git commit -m "feat(controller): teach planner the error-decision rule for unfixable tool failures (#213)"
```

---

## Task 5: Flat pipeline — regression assertion that a failed tool round sets `ToolRound.meta.isError` (Layer 3 scope)

Layer 3 adds NO new default behaviour. The existing `tool-loop-timing-log.test.ts` only covers a TRANSPORT failure (`ok:false`); it does NOT cover the actual #213 flat case — a DELIVERED tool result where `res.ok===true` but `res.value.isError===true` (the locked-object case). This task adds a real new signal: inject a spy context strategy via `ctx.toolLoopContextStrategyFactory`, run a tool that returns `{ ok:true, value:{ content:…, isError:true } }`, and assert the recorded `ToolRound.meta[0].isError === true`. Asserted on the INTERNAL round/meta — NOT on "the LLM receives isError" and NOT on the final answer wording (deterministic enforcement is the consumer's `IOutputValidator`, out of scope).

**Files:**
- Read-only reference: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` — the strategy is `ctx.toolLoopContextStrategyFactory ?? (() => new LegacyAccumulateContextStrategy())` (~line 140); the batch round is `{ assistant, results, meta: outcome.resultMeta }` recorded via `strategy.record(batchRound)` (~lines 903-908). `resultMeta[i].isError = !res.ok || (res.ok && !!res.value.isError)` (`tool-loop-core.ts:392`).
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-timing-log.test.ts` (add one test; reuse `makeCtx`/`SpyLogger`/`SpySessionLogger`/`makeSpan`/`ToolLoopHandler` already imported there)

**Interfaces:**
- Consumes:
  - `ctx.toolLoopContextStrategyFactory: ToolLoopContextStrategyFactory = (deps: { run?: unknown }) => IToolLoopContextStrategy` — the injection seam (default falls back to `LegacyAccumulateContextStrategy`).
  - `IToolLoopContextStrategy` (from `@mcp-abap-adt/llm-agent`): `record(round: ToolRound, options?): Promise<void>`; `form(base, options?): Promise<Message[]>`; `snapshot(): SerializableStrategyState`; `restore(state): void`.
  - `ToolRound.meta?: ToolResultMeta[]` where `ToolResultMeta = { identityKey?: string; isError: boolean }`.
  - `McpToolResult = { content: string | Record<string, unknown>; isError?: boolean }`.
- Produces: test-only coverage; no production change.

- [ ] **Step 1: Write the spy-strategy test asserting the delivered-error round meta**

Add to `tool-loop-timing-log.test.ts`. `makeCtx` returns a `PipelineContext`; assign the factory onto the returned ctx before running (it is not one of `makeCtx`'s params). The spy captures every recorded round.

```ts
test('#213 flat: a delivered tool result with isError:true sets ToolRound.meta.isError', async () => {
  const spy = new SpyLogger();
  const session = new SpySessionLogger();
  // A DELIVERED tool result (transport OK) that is a tool-level error.
  const ctx = makeCtx(
    {
      async callTool() {
        return {
          ok: true as const,
          value: { content: 'ZTAB is locked by user BOB', isError: true },
        };
      },
    },
    spy,
    session,
  );
  // Inject a spy context strategy to observe the recorded ToolRound(s).
  const rounds: ToolRound[] = [];
  (ctx as { toolLoopContextStrategyFactory?: unknown }).toolLoopContextStrategyFactory =
    () => ({
      async record(round: ToolRound) {
        rounds.push(round);
      },
      async form(base: { prefix: Message[] }) {
        return base.prefix;
      },
      snapshot() {
        return { version: 1 };
      },
      restore() {},
    });

  await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  // The recorded batch round carries the tool-level isError on its meta — the
  // executor answers over a VISIBLE failure, not a flattened false success.
  const failedRound = rounds.find((r) => r.meta?.some((m) => m.isError));
  assert.ok(failedRound, 'a recorded round must carry meta.isError:true');
  assert.equal(failedRound.meta?.[0]?.isError, true);
});
```

Add the `ToolRound` and `Message` type imports at the top of the file if not already present (import from `@mcp-abap-adt/llm-agent`).

- [ ] **Step 2: Run the test to verify it PASSES**

Run: `cd packages/llm-agent-libs && node --import tsx/esm --test --test-reporter=spec src/pipeline/handlers/__tests__/tool-loop-timing-log.test.ts`
Expected: PASS — the flat loop builds `batchRound.meta` from `resultMeta`, whose `isError` is `res.ok && !!res.value.isError` = `true` for the delivered error. If it were to FAIL (empty `rounds` or `isError` false), that would mean the flat visibility guarantee regressed — investigate before proceeding.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-timing-log.test.ts
git commit -m "test(flat): assert a delivered isError:true tool result sets ToolRound.meta.isError (#213 flat scope)"
```

---

## Task 6: Build + lint + targeted-test gate

**Known-unrelated pre-existing failures (do NOT let these block the gate):** in this workspace the WHOLE `llm-agent-server-libs` suite (`npm test` for that package, which globs `src/**/*.test.ts`) is known to fail and then HANG on `src/smart-agent/__tests__/chat-endpoint.test.ts` and `src/smart-agent/__tests__/config-endpoints.test.ts` — these are endpoint tests unrelated to #213 and this deliverable does not touch them. A whole-package/whole-workspace green run is therefore NOT the acceptance criterion; it would hang and obscure the #213 signal. The gate below is: full-workspace **build + lint** (neither hangs), plus a **targeted** test run over exactly the files this deliverable adds/changes, diffed against a fresh pre-change baseline of those same files.

**Files:** none (verification only)

- [ ] **Step 1: Capture a fresh pre-change baseline of the targeted files**

BEFORE relying on the gate, confirm the targeted suites are green on the current branch tip WITHOUT this work — do this once, at the start of execution, on a clean checkout of `fix/issue-213-mcp-iserror` before Task 1 (or by reading the counts and re-running after). Build first (workspace imports resolve to `dist/`):

```bash
cd /home/okyslytsia/prj/llm-agent && npm run build
cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec \
  'src/smart-agent/controller/__tests__/*.test.ts' 2>&1 | tail -5
cd ../llm-agent-libs && node --import tsx/esm --test --test-reporter=spec \
  src/pipeline/handlers/__tests__/tool-loop-timing-log.test.ts 2>&1 | tail -5
```

Record the baseline `# pass / # fail` for each. Expected: 0 fail on both targeted sets (they exclude the known-hanging endpoint tests). If the controller set already has a failure on the untouched branch, STOP and report — it is a pre-existing issue to disposition before layering #213 on top.

- [ ] **Step 2: Lint the whole workspace (Biome check — not format; catches import-sort)**

Run: `cd /home/okyslytsia/prj/llm-agent && npm run lint`
Expected: clean (auto-fixes applied; re-run `npm run lint:check` to confirm zero diffs remain). Lint does not run tests, so it does not hang.

- [ ] **Step 3: Build the whole workspace**

Run: `cd /home/okyslytsia/prj/llm-agent && npm run build`
Expected: TypeScript compiles ALL packages with no errors (this is the whole-workspace correctness gate; the widened `NextStep`/`parsePlan` types must compile everywhere they are consumed).

- [ ] **Step 4: Run the targeted test suites (the files this work touches)**

```bash
cd /home/okyslytsia/prj/llm-agent/packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec \
  'src/smart-agent/controller/__tests__/*.test.ts' 2>&1 | tail -8
cd ../llm-agent-libs && node --import tsx/esm --test --test-reporter=spec \
  src/pipeline/handlers/__tests__/tool-loop-timing-log.test.ts 2>&1 | tail -8
```

Expected: 0 failures on both sets, and the pass count is the Step-1 baseline PLUS the tests added by Tasks 1–5 (the immediate-cut test; the four parser/`next()` tests; the two prompt tests; the flat meta test). Any pre-existing pass that now fails is a real regression — investigate before proceeding. Do NOT run the whole `llm-agent-server-libs` package suite (it hangs on the unrelated endpoint tests noted above).

- [ ] **Step 5: Commit any lockfile/formatting churn**

```bash
cd /home/okyslytsia/prj/llm-agent
git add -A
git commit -m "chore: lint/build/targeted-test gate for controller error-to-planner (#213)" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|------------------|------|
| Layer 1 — immediate cut at callMcp site on first `isError:true`, reuse `cutControlFailure` (stepsUsed++ → writeControlFailure → plannerPrivate → settleStep) | Task 1 |
| Durable carrier = failed step-result + plannerPrivate, NOT mcp-result | Task 1 (test asserts a `status:'failed'` `step-result` artifact carrying the tool error text in `h.rag.written` — fails a `settleStep`-only impl — AND `plannerPrivate`) |
| Layer 2 — `parsePlan`/`callPlan` widen to `Step[] \| {kind:'error';error} \| null`; canonical `{"kind":"error",…}` accepted, bare `{"error":…}` rejected | Task 2 |
| Layer 2 — `next()` propagates as `NextStep` `error` variant | Task 2 |
| `NextStep` gains one `error` variant; `WeakExecutorPlanner` inherits | Task 2 |
| Parser tests on `parsePlan` (real path) + `parseNextStep` sync | Task 2 |
| Handler `next.kind==='error'` → terminal returning real error, not `(no response)` | Task 3 |
| Plan/replan prompt rule (fixable→replan, unfixable→error), agnostic, no taxonomy | Task 4 |
| Planner replans a self-chosen taken name; emits `error` on a pinned name | Task 4 (prompt rule) + Task 2 (mechanism; behavioural end-to-end is LLM-dependent, asserted at the mechanism level) |
| Confabulation cannot occur (cut pre-empts the success-summary round) | Task 1 test |
| No further tool call / reviewer not invoked after the failed round | Task 1 test (mcpCalls.length===1; injected reviewer spy asserts `reviewCalls===0`; confabulated summary never surfaced) |
| Resume carrier survives (failed step-result + plannerPrivate) | Task 1 test (asserts the durable `status:'failed'` `step-result` artifact + tool error text + `plannerPrivate` on the rehydrated bundle) |
| `error` decision terminates + returns tool failure text | Task 3 test |
| Flat — visibility only (meta.isError set, error text in content); NO deterministic enforcement | Task 5 (spy-strategy test asserts `ToolRound.meta[0].isError===true` on a delivered `ok:true,isError:true` result) |
| No plan-change regression | Task 6 targeted gate (controller/planner/flat test dirs, diffed vs pre-change baseline) + whole-workspace build/lint |
| No error classifier; no run-level ceiling | Enforced by Global Constraints; no task adds either |

**2. Placeholder scan:** No "TBD"/"handle appropriately"/"add error handling" — every code step shows the exact code and every test shows assertions. Task 5 injects a spy context strategy via the verified `ctx.toolLoopContextStrategyFactory` seam and asserts `ToolRound.meta[0].isError === true` on a delivered `ok:true,isError:true` result — a concrete new signal, no fallback/comment escape hatch.

**3. Type consistency:** `McpCallResult { text; isError }` (existing, from PR #232) is used verbatim in Tasks 1/3. `PlanError = { kind:'error'; error:string }` is defined in Task 2 (`types.ts`), consumed by `parsePlan`/`callPlan`/`next()` (Task 2) and by the handler `next.kind==='error'` branch (Task 3) — same property names (`kind`, `error`) throughout. `cutControlFailure(reason:string)` and `abortTerminal(…, error, …)` signatures match the code read at handler lines 1289 and 1843. `parsePlan` return type is widened identically in the `parsePlan` definition, the `callPlan` return type, and the `isPlanError` guard.
