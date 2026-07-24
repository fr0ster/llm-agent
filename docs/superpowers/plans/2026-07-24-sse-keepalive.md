# Transport-level SSE keep-alive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No SSE stream goes silent during a long tool-execution phase under any pipeline; one shared `heartbeatIntervalMs` normalization disables safely on invalid values on every path.

**Architecture:** A reusable idle watchdog (`createIdleHeartbeat`/`attachSseKeepAlive`) wired into BOTH streaming HTTP surfaces (`/v1/chat/completions`, `/v1/messages`) emits an SSE keep-alive comment when the client stream is idle longer than the interval. One `normalizeHeartbeatMs` authority (undefined→5000; finite>0→it; else→null=disabled) is applied at the two transport call sites AND the two existing flat tool-loop callers, fixing a pre-existing busy loop on `0`/`NaN`. No `StreamChunk`, coordinator, or `SmartAgent.process()` change.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22, `node:test` via `tsx`, Biome.

**Spec:** `docs/superpowers/specs/2026-07-24-sse-keepalive-design.md`

**Issue:** [#246](https://github.com/fr0ster/llm-agent/issues/246)

## Global Constraints

- All artifacts (code, comments, commit messages) in **English**.
- ESM only — relative imports end in `.js`.
- TypeScript strict; avoid `any` (Biome warns).
- Biome gate: `npm run lint:check` (a **check**, not `format`) must be clean of NEW errors.
- Build gate: `npm run build` clean before each commit.
- Test commands (from repo root):
  - single file: `npx tsx --test <path/to/file.test.ts>`
  - a package suite: `npm test --workspace @mcp-abap-adt/llm-agent-libs` (or `…-server-libs`)
- `normalizeHeartbeatMs` is the SOLE authority for interval semantics; no call site repeats `?? 5000` or any validation.
- Additive only; no breaking public change. Widening the internal `heartbeatMs` core param to `number | null` is internal.
- This work folds into the held, unpublished **v20.9.0** (already version-bumped). Do NOT bump versions again.

## File Structure

**`@mcp-abap-adt/llm-agent-libs`:**
- Create `src/pipeline/handlers/normalize-heartbeat-ms.ts` — the normalizer (one responsibility).
- Create `src/pipeline/handlers/normalize-heartbeat-ms.test.ts` — its unit test.
- Modify `src/index.ts` — re-export `normalizeHeartbeatMs` (server-libs imports it).
- Modify `src/pipeline/handlers/tool-loop-core.ts` — `heartbeatMs` param `number → number | null`; disabled path.
- Modify `src/pipeline/handlers/tool-loop.ts` — caller #1 normalizes.
- Modify `src/agent.ts` — caller #2 normalizes.
- Modify `src/__tests__/heartbeat.test.ts` — regression for the disabled interval.

**`@mcp-abap-adt/llm-agent-server-libs`:**
- Create `src/smart-agent/http/sse-heartbeat.ts` — `createIdleHeartbeat` + `attachSseKeepAlive`.
- Create `src/smart-agent/http/sse-heartbeat.test.ts` — unit test.
- Modify `src/smart-agent/smart-server.ts` — `SmartServerAgentConfig.heartbeatIntervalMs?`; pass interval to `handleAdapterRequest`.
- Modify `src/smart-agent/http/chat-route-handler.ts` — consume in the streaming branch.
- Modify `src/smart-agent/http/adapter-route-handler.ts` — new param; consume in the streaming loop.
- Create `src/smart-agent/http/keepalive-integration.test.ts` — both-endpoint integration.
- Modify `src/smart-agent/resolve-config-sections.ts` — warn on a disabled configured value (observability).

**Docs:** `CHANGELOG.md`, `docs/TROUBLESHOOTING.md`, `docs/ARCHITECTURE.md`.

---

### Task 1: `normalizeHeartbeatMs` — the single config-semantics authority

**Files:**
- Create: `packages/llm-agent-libs/src/pipeline/handlers/normalize-heartbeat-ms.ts`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/normalize-heartbeat-ms.test.ts`
- Modify: `packages/llm-agent-libs/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function normalizeHeartbeatMs(raw: number | undefined): number | null` — returns a finite positive interval, or `null` when keep-alive is disabled.

- [ ] **Step 1: Write the failing test**

Create `normalize-heartbeat-ms.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeHeartbeatMs } from './normalize-heartbeat-ms.js';

describe('normalizeHeartbeatMs', () => {
  it('undefined → the fixed default 5000', () => {
    assert.equal(normalizeHeartbeatMs(undefined), 5000);
  });
  it('finite positive → itself', () => {
    assert.equal(normalizeHeartbeatMs(1), 1);
    assert.equal(normalizeHeartbeatMs(5000), 5000);
    assert.equal(normalizeHeartbeatMs(30000), 30000);
  });
  it('zero and negatives → null (disabled)', () => {
    assert.equal(normalizeHeartbeatMs(0), null);
    assert.equal(normalizeHeartbeatMs(-1), null);
    assert.equal(normalizeHeartbeatMs(-5000), null);
  });
  it('non-finite (NaN / ±Infinity) → null (disabled), never a value', () => {
    assert.equal(normalizeHeartbeatMs(Number.NaN), null);
    assert.equal(normalizeHeartbeatMs(Number.POSITIVE_INFINITY), null);
    assert.equal(normalizeHeartbeatMs(Number.NEGATIVE_INFINITY), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent-libs/src/pipeline/handlers/normalize-heartbeat-ms.test.ts`
Expected: FAIL — module `./normalize-heartbeat-ms.js` not found.

- [ ] **Step 3: Implement the normalizer**

Create `normalize-heartbeat-ms.ts`:

```ts
/**
 * The single authority for `heartbeatIntervalMs` semantics, shared by the flat
 * tool-loop and the transport SSE keep-alive.
 *
 * @returns a finite positive interval in ms, or `null` when keep-alive is
 * disabled. Never returns `0`, a negative, `NaN`, or `±Infinity` — a value that
 * would spin `setTimeout` at (near) zero delay.
 */
export function normalizeHeartbeatMs(raw: number | undefined): number | null {
  if (raw === undefined) return 5000;
  if (Number.isFinite(raw) && raw > 0) return raw;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent-libs/src/pipeline/handlers/normalize-heartbeat-ms.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Re-export from the package barrel**

In `packages/llm-agent-libs/src/index.ts`, add near the other `pipeline/handlers` exports (search the file for an existing `export … from './pipeline/handlers/…js'` line and place it beside them):

```ts
export { normalizeHeartbeatMs } from './pipeline/handlers/normalize-heartbeat-ms.js';
```

- [ ] **Step 6: Build + lint, commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-libs/src/pipeline/handlers/normalize-heartbeat-ms.ts packages/llm-agent-libs/src/pipeline/handlers/normalize-heartbeat-ms.test.ts packages/llm-agent-libs/src/index.ts
git commit -m "feat(agent): normalizeHeartbeatMs — single heartbeat-interval authority (#246)"
```

---

### Task 2: Flat tool-loop core disabled path + BOTH callers normalize

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts:226` (param) and the `while (!settled)` race (~311-332)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts:119-122` (caller #1)
- Modify: `packages/llm-agent-libs/src/agent.ts:1346` (caller #2)
- Test: `packages/llm-agent-libs/src/__tests__/heartbeat.test.ts` (append)

**Interfaces:**
- Consumes: `normalizeHeartbeatMs` (Task 1).
- Produces: `IExecuteToolBatchArgs.heartbeatMs: number | null`; when `null`, the batch executor schedules no timer and yields no heartbeat.

**Why both callers in one task:** the core param change is meaningless until a caller passes `null`, and `number` is assignable to `number | null` so the compiler will NOT flag a missed caller — both flat call sites (`tool-loop.ts`, `agent.ts`) must be updated together, proven by the same regression.

- [ ] **Step 1: Write the failing test**

Append to `heartbeat.test.ts` (it already has `makeMcpClient`-style slow-tool stubs, `makeToolCallingLlm`, `collectStream`, and builds `new SmartAgent(deps, config)` — reuse them; match the exact helper names already in the file):

```ts
describe('Heartbeat — disabled interval (#246)', () => {
  it('heartbeatIntervalMs: 0 → tool completes, no heartbeat chunk, no busy loop', async () => {
    // A tool that takes ~120ms. With a 5000ms interval no heartbeat fires anyway,
    // so use a value that WOULD have busy-looped before the fix: 0.
    const deps = makeDeps({ Slow: { delayMs: 120 } }); // mirror the file's existing deps builder
    const agent = new SmartAgent(deps, { heartbeatIntervalMs: 0 });
    const started = Date.now();
    const { heartbeats, content } = await collectStream(agent, 'call Slow');
    // Completed (did not hang) and produced the final content.
    assert.ok(Date.now() - started < 4000, 'must not hang / busy-loop');
    assert.equal(heartbeats.length, 0, 'disabled → no heartbeat chunks');
    assert.ok(content.length > 0);
  });

  it('heartbeatIntervalMs: NaN → same (disabled), no busy loop', async () => {
    const deps = makeDeps({ Slow: { delayMs: 120 } });
    const agent = new SmartAgent(deps, { heartbeatIntervalMs: Number.NaN });
    const { heartbeats } = await collectStream(agent, 'call Slow');
    assert.equal(heartbeats.length, 0);
  });
});
```

> Adapt `makeDeps({...})` / the message string / the config shape to the exact
> helpers already in `heartbeat.test.ts` (e.g. the existing "yields heartbeat
> chunks while tool is executing" test at ~line 135 shows the precise deps and
> config it uses — copy that shape, changing only `heartbeatIntervalMs`).
>
The two tests above drive caller #2 (`SmartAgent.streamProcess` → `agent.ts:1360`).
Caller #1 (pipeline `ToolLoopHandler` → `tool-loop.ts:840`) gets its own test in the
next step — the spec matrix requires BOTH.

- [ ] **Step 1b: Write the failing caller #1 test (pipeline `ToolLoopHandler`)**

Add to the EXISTING harness file
`packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-stream.test.ts` —
it already builds a `ToolLoopHandler` and a `PipelineContext` via `makeCtx(streamFn,
onPartial)` (config carries `heartbeatIntervalMs: 5000`). To reach
`executeToolBatchWithHeartbeat`, the batch must contain an INTERNAL tool call (a tool
present in `toolClientMap`, not in `externalTools`). Copy the internal-tool-call
driving shape from `tool-loop-external.test.ts` / `tool-loop-mcp-unavailable.test.ts`
in the same `__tests__` dir (their streams yield `{ toolCalls: [...], finishReason:
'tool_calls' }` and populate `toolClientMap`), then add a `makeCtx` override for
`heartbeatIntervalMs` and a slow client:

`ToolLoopHandler.execute` is `execute(ctx, config, parentSpan): Promise<boolean>` — NOT
an async generator. Run it exactly as the existing tests in this file do
(`const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan())`, lines 180/204),
and collect client-facing chunks via `ctx.yield` (the harness's `yield` pushes to a
local array — capture it by overriding `ctx.yield` after `makeCtx` returns):

```ts
test('#246 caller #1: ToolLoopHandler with heartbeatIntervalMs 0 → no heartbeat, no busy loop', async () => {
  // ctx built like the file's makeCtx, but with: config.heartbeatIntervalMs = 0;
  // a "Slow" INTERNAL tool in toolClientMap whose callTool awaits ~120ms; and
  // a streamFn that (round 1) yields { toolCalls: [Slow], finishReason: 'tool_calls' }
  // then (round 2) yields final content. Copy the internal tool-call + slow-client
  // shape from tool-loop-external.test.ts / heartbeat.test.ts in the same dirs.
  const ctx = makeSlowInternalToolCtx({ heartbeatIntervalMs: 0, toolDelayMs: 120 });

  // Capture what the handler yields to the client stream.
  const captured: Result<LlmStreamChunk, unknown>[] = [];
  (ctx as { yield: (c: Result<LlmStreamChunk, unknown>) => void }).yield = (c) => {
    captured.push(c);
  };

  const started = Date.now();
  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  assert.equal(ok, true);
  assert.ok(Date.now() - started < 4000, 'must not busy-loop');
  assert.equal(
    captured.filter(
      (c) => c.ok && (c.value as { heartbeat?: unknown }).heartbeat !== undefined,
    ).length,
    0,
    'disabled interval → no heartbeat chunk from the batch executor',
  );
});
```

> `makeSlowInternalToolCtx` = the file's existing `makeCtx` shape with three deltas:
> `config.heartbeatIntervalMs` from the arg; a `toolClientMap` entry for `Slow` whose
> `callTool` awaits `toolDelayMs` (copy the slow-client stub from `heartbeat.test.ts`);
> and `selectedTools`/`activeTools`/`mcpTools` listing `Slow` so the loop offers and
> internally executes it (NOT in `externalTools`). The `streamFn`/`llmCallStrategy.call`
> must be stateful: first round → a `tool_calls` chunk for `Slow`; second round →
> final content (model the two-round shape on `tool-loop-external.test.ts`). Add
> `Result`/`LlmStreamChunk` to the file's type imports if not already present.

This file MUST be added to Task 2's `git add` (Step 8).

- [ ] **Step 2: Run both new tests to verify they fail**

Run: `npx tsx --test packages/llm-agent-libs/src/__tests__/heartbeat.test.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-stream.test.ts`
Expected: FAIL — before the fix, `heartbeatIntervalMs: 0` makes the batch executor busy-loop and emit many heartbeat chunks (`heartbeats.length` / heartbeat-chunk count > 0), and the run may not settle promptly, for BOTH callers.

- [ ] **Step 3: Widen the core param**

In `tool-loop-core.ts`, change the `IExecuteToolBatchArgs` field (line ~226):

```ts
  heartbeatMs: number | null;
```

- [ ] **Step 4: Guard the race with the disabled branch**

In `tool-loop-core.ts`, replace the `while (!settled) { … }` block (~311-332) with:

```ts
  if (heartbeatMs === null) {
    // #246: keep-alive disabled → no heartbeat timer, just await completion.
    // Prevents a 0/NaN interval from busy-looping the tick race.
    results = await allDone;
  } else {
    while (!settled) {
      const winner = await Promise.race([
        allDone.then((r) => ({ tag: 'done' as const, results: r })),
        new Promise<{ tag: 'tick' }>((resolve) =>
          setTimeout(() => resolve({ tag: 'tick' }), heartbeatMs),
        ),
      ]);
      if (winner.tag === 'done') {
        results = winner.results;
        settled = true;
      } else {
        for (const tool of pendingTools) {
          yield {
            ok: true,
            value: {
              content: '',
              heartbeat: { tool, elapsed: Date.now() - toolStartTime },
            },
          };
        }
      }
    }
  }
```

(`results` and `settled` are already declared just above this block; the disabled branch simply assigns `results` and skips the loop.)

- [ ] **Step 5: Normalize caller #1 (pipeline `ToolLoopHandler`)**

In `tool-loop.ts`, add the import at the top (beside the existing `executeToolBatchWithHeartbeat` import from `./tool-loop-core.js`). Import the sibling module DIRECTLY — never the package barrel `../../index.js`, which would create an internal import cycle through the exports subtree:

```ts
import { normalizeHeartbeatMs } from './normalize-heartbeat-ms.js';
```

Replace the `heartbeatMs` resolution (lines 119-122):

```ts
    const heartbeatMs = normalizeHeartbeatMs(
      (config.heartbeatIntervalMs as number | undefined) ??
        ctx.config.heartbeatIntervalMs,
    );
```

- [ ] **Step 6: Normalize caller #2 (direct `SmartAgent.streamProcess`)**

In `agent.ts`, add the import at the top (beside other `./pipeline/handlers/...` imports):

```ts
import { normalizeHeartbeatMs } from './pipeline/handlers/normalize-heartbeat-ms.js';
```

Replace line 1346:

```ts
      const heartbeatMs = normalizeHeartbeatMs(this.config.heartbeatIntervalMs);
```

- [ ] **Step 7: Run both regressions + the full libs suite**

Run: `npx tsx --test packages/llm-agent-libs/src/__tests__/heartbeat.test.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-stream.test.ts`
Expected: PASS — both callers' disabled-interval tests pass; the existing "yields heartbeat chunks" (default 5000), "no heartbeat for fast tools", and the existing tool-loop-stream tests still pass.

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. If a pre-existing test fails, confirm it also fails on `main`.

- [ ] **Step 8: Build + lint, commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/__tests__/heartbeat.test.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-stream.test.ts
git commit -m "fix(agent): disable flat heartbeat on <=0/invalid interval, no busy loop (#246)"
```

---

### Task 3: `createIdleHeartbeat` + `attachSseKeepAlive`

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/http/sse-heartbeat.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/http/sse-heartbeat.test.ts`

**Interfaces:**
- Consumes: `normalizeHeartbeatMs` from `@mcp-abap-adt/llm-agent-libs` (Task 1).
- Produces:
  - `interface IdleHeartbeat { reset(): void; stop(): void }`
  - `interface IdleHeartbeatOptions { intervalMs: number | undefined; onBeat: () => void; schedule?: (cb: () => void, ms: number) => unknown; cancel?: (h: unknown) => void }`
  - `function createIdleHeartbeat(opts: IdleHeartbeatOptions): IdleHeartbeat`
  - `function attachSseKeepAlive(res: ServerResponse, intervalMs: number | undefined): IdleHeartbeat`

- [ ] **Step 1: Write the failing test**

Create `sse-heartbeat.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachSseKeepAlive, createIdleHeartbeat } from './sse-heartbeat.js';

/** A manual scheduler: records the pending callback so the test fires it. */
function manualClock() {
  let pending: { cb: () => void; ms: number } | undefined;
  return {
    schedule: (cb: () => void, ms: number) => {
      pending = { cb, ms };
      return pending;
    },
    cancel: (_h: unknown) => {
      pending = undefined;
    },
    /** Fire the currently-armed timer, if any. */
    tick() {
      const p = pending;
      pending = undefined;
      p?.cb();
    },
    get armed() {
      return pending !== undefined;
    },
  };
}

describe('createIdleHeartbeat', () => {
  it('beats after one idle interval, and repeats', () => {
    const clock = manualClock();
    let beats = 0;
    createIdleHeartbeat({
      intervalMs: 100,
      onBeat: () => beats++,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    clock.tick();
    assert.equal(beats, 1);
    clock.tick(); // re-armed
    assert.equal(beats, 2);
  });

  it('reset() before the interval cancels the pending beat and re-arms', () => {
    const clock = manualClock();
    let beats = 0;
    const hb = createIdleHeartbeat({
      intervalMs: 100,
      onBeat: () => beats++,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    hb.reset();
    clock.tick();
    assert.equal(beats, 1, 'still armed after reset');
  });

  it('stop() prevents further beats and is idempotent', () => {
    const clock = manualClock();
    let beats = 0;
    const hb = createIdleHeartbeat({
      intervalMs: 100,
      onBeat: () => beats++,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    hb.stop();
    hb.stop();
    assert.equal(clock.armed, false);
    hb.reset(); // no-op after stop
    assert.equal(clock.armed, false);
    clock.tick();
    assert.equal(beats, 0);
  });

  it('stop() called synchronously DURING onBeat does not re-arm', () => {
    const clock = manualClock();
    let beats = 0;
    let hb: import('./sse-heartbeat.js').IdleHeartbeat;
    hb = createIdleHeartbeat({
      intervalMs: 100,
      onBeat: () => {
        beats++;
        hb.stop(); // e.g. res 'close' fires while we write the beat
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    clock.tick(); // fires onBeat → beats=1 → stop()
    assert.equal(beats, 1);
    assert.equal(clock.armed, false, 'must NOT re-arm after stop during beat');
    clock.tick(); // nothing armed → no further beat
    assert.equal(beats, 1);
  });

  it('disabled intervals never arm a timer: 0, negative, NaN, ±Infinity, and via undefined→default it DOES arm', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const clock = manualClock();
      let beats = 0;
      const hb = createIdleHeartbeat({
        intervalMs: bad,
        onBeat: () => beats++,
        schedule: clock.schedule,
        cancel: clock.cancel,
      });
      assert.equal(clock.armed, false, `interval ${bad} must not arm`);
      hb.reset();
      clock.tick();
      assert.equal(beats, 0, `interval ${bad} must never beat`);
    }
    // undefined → normalized to 5000 → armed
    const clock = manualClock();
    createIdleHeartbeat({
      intervalMs: undefined,
      onBeat: () => {},
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    assert.equal(clock.armed, true, 'undefined → default → armed');
  });
});

describe('attachSseKeepAlive', () => {
  it('registers a res "close" handler and stop() is safe after disconnect', () => {
    // attachSseKeepAlive owns timer creation (no injected clock here); the timer
    // mechanics are covered by the createIdleHeartbeat tests above. This asserts
    // the SSE binding: a close handler is registered, and disconnect + stop are safe.
    const listeners: Record<string, () => void> = {};
    const res = {
      write: () => true,
      on: (ev: string, cb: () => void) => {
        listeners[ev] = cb;
      },
    } as unknown as import('node:http').ServerResponse;

    const hb = attachSseKeepAlive(res, 100);
    assert.equal(typeof listeners.close, 'function');
    listeners.close(); // simulate client disconnect
    hb.stop(); // idempotent / no throw
  });
});
```

> The `attachSseKeepAlive` beat-write is covered indirectly (its `onBeat` is a
> one-liner `res.write(': keep-alive\n\n')`); the timer mechanics are fully
> covered by the `createIdleHeartbeat` tests with the injected clock. The
> integration test in Task 6 asserts the actual `: keep-alive` bytes over a real
> (short-interval) stream through the handlers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent-server-libs/src/smart-agent/http/sse-heartbeat.test.ts`
Expected: FAIL — module `./sse-heartbeat.js` not found.

- [ ] **Step 3: Implement the module**

Create `sse-heartbeat.ts`:

```ts
import type { ServerResponse } from 'node:http';
import { normalizeHeartbeatMs } from '@mcp-abap-adt/llm-agent-libs';

export interface IdleHeartbeat {
  /** Re-arm the idle timer. Call on every real chunk written to the client. */
  reset(): void;
  /** Cancel the timer permanently. Idempotent. */
  stop(): void;
}

export interface IdleHeartbeatOptions {
  /** Raw configured interval (may be undefined). Normalized internally. */
  intervalMs: number | undefined;
  /** Invoked once each time the stream stays idle for the normalized interval. */
  onBeat: () => void;
  /** Timer injection for deterministic tests. Default: global setTimeout/clearTimeout. */
  schedule?: (cb: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

const NOOP: IdleHeartbeat = {
  reset() {},
  stop() {},
};

export function createIdleHeartbeat(opts: IdleHeartbeatOptions): IdleHeartbeat {
  const ms = normalizeHeartbeatMs(opts.intervalMs);
  if (ms === null) return NOOP;

  const schedule =
    opts.schedule ?? ((cb: () => void, d: number) => setTimeout(cb, d));
  const cancel =
    opts.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let handle: unknown;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return; // never schedule after stop
    handle = schedule(() => {
      if (stopped) return; // a stop() between scheduling and firing
      opts.onBeat();
      if (stopped) return; // onBeat() may have stopped us synchronously (e.g. res close)
      arm();
    }, ms);
  };
  const clear = (): void => {
    if (handle !== undefined) {
      cancel(handle);
      handle = undefined;
    }
  };

  arm();

  return {
    reset() {
      if (stopped) return;
      clear();
      arm();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clear();
    },
  };
}

/**
 * Wire an idle keep-alive to an SSE response: `onBeat` writes a keep-alive
 * comment and `res 'close'` stops the timer. `intervalMs` is the RAW configured
 * value (may be undefined) — normalization happens inside `createIdleHeartbeat`.
 */
export function attachSseKeepAlive(
  res: ServerResponse,
  intervalMs: number | undefined,
): IdleHeartbeat {
  const hb = createIdleHeartbeat({
    intervalMs,
    onBeat: () => res.write(': keep-alive\n\n'),
  });
  res.on('close', () => hb.stop());
  return hb;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent-server-libs/src/smart-agent/http/sse-heartbeat.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + lint, commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/http/sse-heartbeat.ts packages/llm-agent-server-libs/src/smart-agent/http/sse-heartbeat.test.ts
git commit -m "feat(server): idle SSE keep-alive helper (createIdleHeartbeat/attachSseKeepAlive) (#246)"
```

---

### Task 4: Type the config field + wire the chat-route surface

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts:188-212` (`SmartServerAgentConfig`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts` (streaming branch ~262-395)

**Interfaces:**
- Consumes: `attachSseKeepAlive` (Task 3); `cfg.agent?.heartbeatIntervalMs`.
- Produces: `SmartServerAgentConfig.heartbeatIntervalMs?: number`; the `/v1/chat/completions` stream never idles past the interval.

- [ ] **Step 1: Declare the config field**

In `smart-server.ts`, add to the `SmartServerAgentConfig` interface (after the existing `mcpSharedClient?: boolean;` field, before the closing brace at ~line 212):

```ts
  /** SSE keep-alive / tool-loop heartbeat interval (ms). Default 5000; `<= 0` or
   *  invalid disables. Already populated from yaml by resolveAgentSection. */
  heartbeatIntervalMs?: number;
```

- [ ] **Step 2: Add the import to chat-route-handler**

At the top of `chat-route-handler.ts` (beside the other local `./` imports):

```ts
import { attachSseKeepAlive } from './sse-heartbeat.js';
```

- [ ] **Step 3: Wire the streaming branch**

In the `if (body.stream) { … }` branch, immediately after the existing
`for await (const chunk of stream)` loop is set up, restructure so the loop is
wrapped and each chunk re-arms. Concretely:

1. Right after `const stream = smartAgent.streamProcess(...)` (~line 272-283) and
   the `res.writeHead(200, { 'Content-Type': 'text/event-stream', … })`, add:

```ts
    const keepAlive = attachSseKeepAlive(res, cfg.agent?.heartbeatIntervalMs);
```

2. Wrap the existing `for await (const chunk of stream) { … }` … `res.write('data: [DONE]\n\n')` in `try { … } finally { keepAlive.stop(); }`, and make `keepAlive.reset()` the FIRST statement inside the `for await` body:

```ts
    try {
      for await (const chunk of stream) {
        keepAlive.reset();
        // … all existing chunk handling unchanged …
      }
      res.write('data: [DONE]\n\n');
    } finally {
      keepAlive.stop();
    }
    res.end();
```

> Do not change any existing chunk-writing logic (content, `value.heartbeat`,
> `value.timing`, tool_calls, errors, `[DONE]`). Only add the `attachSseKeepAlive`
> line, the `try/finally`, and the first-line `keepAlive.reset()`.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: clean.

- [ ] **Step 5: Commit** (the integration test lands in Task 6 alongside the adapter surface)

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts
git commit -m "feat(server): SSE keep-alive on /v1/chat/completions + type heartbeatIntervalMs (#246)"
```

---

### Task 5: Wire the adapter-route surface (`/v1/messages`)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/http/adapter-route-handler.ts:15-98`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (the `handleAdapterRequest(...)` call site)

**Interfaces:**
- Consumes: `attachSseKeepAlive` (Task 3); the new param.
- Produces: `handleAdapterRequest(req, res, agent, adapter, session, heartbeatIntervalMs)` — the `/v1/messages` stream never idles past the interval.

- [ ] **Step 1: Add the import + parameter**

At the top of `adapter-route-handler.ts`:

```ts
import { attachSseKeepAlive } from './sse-heartbeat.js';
```

Extend the `handleAdapterRequest` signature (lines 15-21) with a trailing param:

```ts
export async function handleAdapterRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agent: SmartAgent,
  adapter: ILlmApiAdapter,
  session: { sessionId: string; traceId: string; graph: SessionGraph } | undefined,
  heartbeatIntervalMs: number | undefined,
): Promise<void> {
```

- [ ] **Step 2: Wrap the streaming loop**

Around the streaming `for await (const event of adapter.transformStream(agent.streamProcess(...)))` loop (lines 66-98), after `res.writeHead(200, { 'Content-Type': 'text/event-stream', … })`:

```ts
    const keepAlive = attachSseKeepAlive(res, heartbeatIntervalMs);
    try {
      for await (const event of adapter.transformStream(
        agent.streamProcess(sanitizedMessages, augmentedOptions),
      )) {
        keepAlive.reset();
        const eventLine = /* existing */ event.event ? `event: ${event.event}\n` : '';
        res.write(`${eventLine}data: ${event.data}\n\n`);
      }
    } finally {
      keepAlive.stop();
    }
```

> Keep the exact existing `eventLine`/`res.write` expression from lines 74-77 —
> only add `attachSseKeepAlive`, the `try/finally`, and the first-line
> `keepAlive.reset()`.

- [ ] **Step 3: Pass the interval at the call site**

In `smart-server.ts`, the `handleAdapterRequest(` call is at ~line 2628 (verify with
`grep -n "handleAdapterRequest(" packages/llm-agent-server-libs/src/smart-agent/smart-server.ts`). Add the final argument:

```ts
        this.cfg.agent?.heartbeatIntervalMs,
```

(Use the same `cfg`/`this.cfg` accessor the surrounding call already uses.)

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/http/adapter-route-handler.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "feat(server): SSE keep-alive on /v1/messages (adapter surface) (#246)"
```

---

### Task 6: Both-endpoint integration test — invoke the REAL handlers

**Files:**
- Test: `packages/llm-agent-server-libs/src/smart-agent/http/keepalive-integration.test.ts` (create)

**Interfaces:**
- Consumes: `handleChat` (from `./chat-route-handler.js`), `handleAdapterRequest` (from `./adapter-route-handler.js`), a real `AnthropicApiAdapter`.

**Why real handlers:** the test MUST call `handleChat`/`handleAdapterRequest` so it
catches missing wiring, a wrong config parameter, or a missing `reset()` in the real
loops — a helper-only simulation would not. Use a real Node `Readable` for the request
body (satisfies `readBody`'s `req.on('data'/'end')`), a fake `ServerResponse`, a stub
`SmartAgent` whose `streamProcess` stays idle then yields content, and a REAL adapter
for the `/v1/messages` path.

- [ ] **Step 1: Write the failing test**

Create `keepalive-integration.test.ts`:

```ts
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { SessionRequestLogger } from '@mcp-abap-adt/llm-agent-libs';
import { AnthropicApiAdapter } from '@mcp-abap-adt/llm-agent';
import { handleAdapterRequest } from './adapter-route-handler.js';
import { handleChat } from './chat-route-handler.js';

/**
 * A request whose body is `json`; drives readBody via a real Readable. Sets
 * `headers` because handleChat reads `req.headers['x-session-id']` when no
 * session is supplied (chat-route-handler.ts:118) — without it the handler
 * throws before the keep-alive assertion.
 */
function makeReq(json: unknown): IncomingMessage {
  const req = Readable.from([
    Buffer.from(JSON.stringify(json)),
  ]) as unknown as IncomingMessage;
  (req as { headers: Record<string, string> }).headers = {};
  return req;
}

/** Fake ServerResponse capturing writes + listeners. */
function fakeRes() {
  const writes: string[] = [];
  const listeners: Record<string, () => void> = {};
  const res = {
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    on: (ev: string, cb: () => void) => {
      listeners[ev] = cb;
    },
    end: () => {},
    writeHead: () => res,
  } as unknown as ServerResponse;
  return { res, writes, listeners };
}

/** Stub SmartAgent: streamProcess idles `idleMs`, then yields one content chunk. */
function idleAgent(idleMs: number) {
  return {
    async *streamProcess() {
      await new Promise((r) => setTimeout(r, idleMs));
      yield { ok: true, value: { content: 'hello', finishReason: 'stop' } };
    },
  } as never; // cast to SmartAgent at the call site
}

/**
 * Stub SmartAgent: yields `count` chunks each `gapMs` apart (no single gap is
 * long). Used to prove the handler calls `reset()` per chunk: with reset, no gap
 * reaches the interval → NO keep-alive; WITHOUT reset the watchdog fires on its
 * initial arm regardless → a keep-alive appears. `gapMs` must be << the interval.
 */
function steadyAgent(count: number, gapMs: number) {
  return {
    async *streamProcess() {
      for (let i = 0; i < count; i++) {
        await new Promise((r) => setTimeout(r, gapMs));
        yield { ok: true, value: { content: `x${i}` } };
      }
      yield { ok: true, value: { content: '', finishReason: 'stop' } };
    },
  } as never;
}

const noop = () => {};

describe('#246 SSE keep-alive — /v1/chat/completions', () => {
  it('emits ": keep-alive" during an idle gap before the first data line', async () => {
    const { res, writes } = fakeRes();
    await handleChat(
      makeReq({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      res,
      new SessionRequestLogger(),
      idleAgent(80), // stub SmartAgent
      noop as never, // _chat (unused on the stream path)
      noop as never, // _streamChat
      noop, // log
      undefined, // modelProvider
      undefined, // session
      { agent: { heartbeatIntervalMs: 20 } } as never, // cfg
    );
    const firstKeepAlive = writes.findIndex((w) => w.startsWith(': keep-alive'));
    const firstData = writes.findIndex((w) => w.startsWith('data:'));
    assert.ok(firstKeepAlive >= 0, 'a keep-alive was written during the idle gap');
    assert.ok(firstKeepAlive < firstData, 'keep-alive precedes the first data line');
  });

  it('calls reset() per chunk: steady output (gap << interval) → NO keep-alive', async () => {
    // Kills the "removed keepAlive.reset()" mutant: 25 chunks × 4ms = ~100ms total
    // (> the 50ms interval, so WITHOUT reset the watchdog would fire at ~50ms), but
    // every gap is 4ms << 50ms, so WITH reset() no keep-alive is ever written.
    const { res, writes } = fakeRes();
    await handleChat(
      makeReq({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      res,
      new SessionRequestLogger(),
      steadyAgent(25, 4),
      noop as never,
      noop as never,
      noop,
      undefined,
      undefined,
      { agent: { heartbeatIntervalMs: 50 } } as never,
    );
    assert.equal(
      writes.filter((w) => w.startsWith(': keep-alive')).length,
      0,
      'reset() on each chunk keeps the watchdog from ever firing during steady output',
    );
  });
});

describe('#246 SSE keep-alive — /v1/messages (real adapter)', () => {
  it('emits ": keep-alive" during an idle gap', async () => {
    const { res, writes } = fakeRes();
    await handleAdapterRequest(
      makeReq({
        model: 'm',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      res,
      idleAgent(80), // stub SmartAgent
      new AnthropicApiAdapter(),
      undefined, // session
      20, // heartbeatIntervalMs
    );
    assert.ok(
      writes.some((w) => w.startsWith(': keep-alive')),
      'a keep-alive was written during the idle gap on /v1/messages',
    );
  });

  it('calls reset() per event: steady output → NO keep-alive', async () => {
    // Same mutant-killer for the adapter path. Assumes AnthropicApiAdapter forwards
    // content deltas incrementally (one `content_block_delta` event per content
    // chunk), so the handler's per-event reset() keeps the watchdog reset. If the
    // adapter is found to BATCH deltas (a single late event), replace this with the
    // clock-injection variant (thread an injectable `schedule`/`cancel` through
    // attachSseKeepAlive) rather than weakening the assertion.
    const { res, writes } = fakeRes();
    await handleAdapterRequest(
      makeReq({
        model: 'm',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      res,
      steadyAgent(25, 4),
      new AnthropicApiAdapter(),
      undefined,
      50, // interval 50ms; gaps 4ms << 50ms
    );
    assert.equal(
      writes.filter((w) => w.startsWith(': keep-alive')).length,
      0,
      'reset() on each event keeps the watchdog from ever firing during steady output',
    );
  });
});
```

> Align the exact `handleChat` argument list to its signature
> (`chat-route-handler.ts:33-46`) — the arg order above matches it. If
> `AnthropicApiAdapter.normalizeRequest` rejects the minimal body, copy a valid
> Anthropic request body from an existing adapter test or the adapter's own
> normalize code. The point of the assertion is the `: keep-alive` line, not the
> response body.

- [ ] **Step 2: Run test to verify it fails (RED), then passes after wiring**

Run: `npx tsx --test packages/llm-agent-server-libs/src/smart-agent/http/keepalive-integration.test.ts`
Expected once Tasks 4-5 are done: PASS. (If you write this test BEFORE wiring the
handlers, it FAILS — no `: keep-alive` — which is the RED you want; it goes green once
`attachSseKeepAlive` is wired into both handlers.)

- [ ] **Step 3: Full server-libs suite + baseline**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. Existing `chat-route-handler` / `adapter-route-handler` streaming tests stay green (their fast streams never idle past the default interval, so no keep-alive is injected).

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/http/keepalive-integration.test.ts
git commit -m "test(server): #246 SSE keep-alive integration via real handleChat + handleAdapterRequest (#246)"
```

---

### Task 7: Config observability — warn on a disabled configured value

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts:253-259`

**Interfaces:**
- Consumes: `normalizeHeartbeatMs`.
- Produces: a startup warning when a CONFIGURED `heartbeatIntervalMs` normalizes to disabled.

- [ ] **Step 1: Add the warning**

In `resolve-config-sections.ts`, where `heartbeatIntervalMs` is read (~253-259), after computing the numeric value, warn if it is present but normalizes to `null`. Add the import:

```ts
import { normalizeHeartbeatMs } from '@mcp-abap-adt/llm-agent-libs';
```

And where the value is resolved:

```ts
    ...(get(yaml, 'agent', 'heartbeatIntervalMs') !== undefined
      ? (() => {
          const n = Number(get(yaml, 'agent', 'heartbeatIntervalMs'));
          if (normalizeHeartbeatMs(n) === null) {
            console.warn(
              `[config] agent.heartbeatIntervalMs=${get(yaml, 'agent', 'heartbeatIntervalMs')} is invalid or <= 0 — SSE keep-alive and tool-loop heartbeat are DISABLED.`,
            );
          }
          return { heartbeatIntervalMs: n };
        })()
      : {}),
```

> Match the surrounding spread style; keep passing the raw `Number(...)` through
> (the normalizer runs at every consumer). This warning is observability only.

- [ ] **Step 2: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts
git commit -m "chore(server): warn when heartbeatIntervalMs config disables keep-alive (#246)"
```

---

### Task 8: Documentation + follow-up issue + cleanup

**Files:**
- Modify: `CHANGELOG.md`, `docs/TROUBLESHOOTING.md`, `docs/ARCHITECTURE.md`
- Delete: the spec and this plan.

- [ ] **Step 1: CHANGELOG entry**

Under the `## [20.9.0]` section's `### Fixed` (create the sub-heading if absent):

```markdown
- **SSE keep-alive during long tool execution under every pipeline (#246).** Only
  the flat pipeline streamed heartbeats; `linear` / `dag` / `controller` /
  `stepper` / `cyclic` ran tool execution below the `ctx.yield` boundary, so a
  long MCP call left the SSE connection silent until the phase ended (~22s → the
  intermediary closed it, `No response`). A transport-level idle keep-alive at
  both streaming surfaces (`/v1/chat/completions`, `/v1/messages`) now writes a
  keep-alive comment when the stream is idle past `agent.heartbeatIntervalMs`. A
  single `heartbeatIntervalMs` normalization (`<= 0` / `NaN` / `±Infinity`
  disables, never a busy loop) is applied to both the keep-alive and the flat
  tool-loop's own heartbeat — fixing a pre-existing busy loop on `0`/`NaN`. Under
  `withDagCoordinator` the finalizer remains the sole client-facing *content*
  source: a notice-only custom finalizer must re-emit `interpreterOutput`.
```

- [ ] **Step 2: TROUBLESHOOTING entry**

```markdown
### `controller`/`dag`/`linear`/`stepper` SSE closes (`No response`) on a long MCP tool call

**Cause (before #246):** only the flat pipeline surfaced heartbeats. The other
pipelines execute tools below the `ctx.yield` boundary, so during a long MCP call
nothing reached the wire and an idle intermediary (CF gorouter, browser) closed
the SSE connection after ~22s.

**Fix:** upgrade to the release containing #246. Both streaming surfaces
(`/v1/chat/completions`, `/v1/messages`) emit an SSE `: keep-alive` comment when
idle past `agent.heartbeatIntervalMs` (default 5000). Set `heartbeatIntervalMs`
to a smaller value for stricter intermediaries; `<= 0` disables keep-alive (and
the flat tool-loop heartbeat) entirely — an invalid value (`NaN`) also disables,
never busy-loops.

**DAG note:** under `withDagCoordinator` the finalizer is the sole content
source. A custom notice-only finalizer that does not re-emit `interpreterOutput`
yields an empty answer — re-emit it as content.
```

- [ ] **Step 3: ARCHITECTURE / streaming note**

Add a short paragraph in the streaming/SSE section of `docs/ARCHITECTURE.md`
(locate it: `grep -n -i "event-stream\|heartbeat\|streaming" docs/ARCHITECTURE.md`):

```markdown
Both SSE surfaces (`/v1/chat/completions`, `/v1/messages`) run an idle keep-alive
watchdog: if no chunk is written for `agent.heartbeatIntervalMs` (default 5000ms;
`<= 0`/invalid disables), a `: keep-alive` comment is emitted so intermediaries do
not close an idle connection during a long tool-execution phase. This is
pipeline-agnostic; the flat pipeline additionally emits richer per-tool
`: heartbeat tool=…` comments from the tool-loop.
```

- [ ] **Step 4: Verify documented claims against source**

```bash
grep -n "attachSseKeepAlive" packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts packages/llm-agent-server-libs/src/smart-agent/http/adapter-route-handler.ts
grep -n "normalizeHeartbeatMs" packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts packages/llm-agent-libs/src/agent.ts
```

Expected: each grep matches (both surfaces wired; both flat callers normalized).

- [ ] **Step 5: File the follow-up issue (deferred content-forward)**

```bash
gh issue create --title "DAG coordinator: optional live forwarding of interpreter content (token-by-token) with finalizer de-dup" --body "$(cat <<'BODY'
Follow-up to #246 (scoped to keep-alive + docs). The DAG coordinator's
`interpreterOnPartial` only logs; the finalizer is the sole content source. For a
notice-only finalizer this means the answer is delivered as one delta at finalize,
not token-by-token. Add an opt-in flag to forward interpreter content live, with
de-duplication against a re-emitting finalizer (a consumer-owned variation point).
Design constraint: an empty replan/finalizer must not double-emit content.
BODY
)"
```

Record the printed issue number in the commit body of Step 7.

- [ ] **Step 6: Delete spec and plan**

```bash
git rm docs/superpowers/specs/2026-07-24-sse-keepalive-design.md docs/superpowers/plans/2026-07-24-sse-keepalive.md
```

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md docs/
git commit -m "docs: SSE keep-alive across pipelines + DAG finalizer contract (#246)"
```

---

## Final Verification

- [ ] `npm run build` — clean.
- [ ] `npm run lint:check` — no NEW errors (compare to a `main` baseline).
- [ ] `npm test --workspace @mcp-abap-adt/llm-agent-libs` and `… --workspace @mcp-abap-adt/llm-agent-server-libs` — `fail 0` (baseline-diff any pre-existing failure against `main`).
- [ ] Live gate (maintainer): a controller (or dag/stepper) request that triggers a >30s MCP tool call over `/v1/chat/completions` AND `/v1/messages` keeps the SSE connection open (periodic `: keep-alive`); with `agent.heartbeatIntervalMs: 0` the connection has no keep-alive and the run still completes without a busy loop.
- [ ] External code review before merge; merge only on the maintainer's explicit word. Folds into the held v20.9.0 (move the tag to the final commit before publish).
