# Debug-trace by area — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add granular, env-var-gated debug tracing that captures per-LLM-call request/response content and per-controller-step decisions for the controller path, built on the existing `SessionLogger.logStep` channel.

**Architecture:** A tiny area registry (`DEBUG_*` env var per area) + an area-aware `SessionLogger` (`logStep(name, data, area?)` filtered by an enabled-areas set: `'all'` under legacy `cfg.logDir`, else the on-flags). Capture sites tag their records; the controller's single LLM boundary (`ISubagentClient.send`) and its decision/MCP/RAG points call `logStep` via the per-request `options.sessionLogger`. Off by default; no processing change.

**Tech Stack:** TypeScript (ESM, strict), node:test + tsx, Biome. Spec: `docs/superpowers/specs/2026-07-18-debug-trace-areas-design.md`.

## Global Constraints

- **Branch:** `feat/debug-trace-areas`. Base is `main` at `6750187b`. Verify `git branch --show-current` before committing.
- **Env-var gate, uniform with existing.** `DEBUG_LLM` / `DEBUG_MCP` / `DEBUG_RAG` / `DEBUG_CONTROLLER`, same `DEBUG_*` style as `DEBUG_CONTROLLER`/`DEBUG_SMART_AGENT`. Sink dir env var `DEBUG_TRACE_DIR`, default `./.smart-agent-debug/`.
- **Off by default.** No `DEBUG_*` and no `cfg.logDir` = exactly today's behavior. Flags only add trace output; request processing is NEVER affected. One intended exception: a `cfg.logDir` run now also gets controller trace files (documented).
- **Build ON existing components** — reuse `SessionLogger.logStep`; do NOT add a new logging channel.
- **Consumer-safe by construction** — capture only step content (messages/responses/decisions/usage) via `logStep`; never config, api keys, `AICORE_SERVICE_KEY`, or auth headers.
- **`area?` is additive** — existing 2-arg `logStep(name, data)` callers must keep compiling; the 7 `sessionLogger?` structural declarations are updated in lockstep.
- **ESM only** — `.js` extensions on relative imports, even from `.ts`.
- **English only**; Conventional Commits (`feat:` / `test:`); TS strict, no `any`.
- **Before every commit run `npm run lint`** (= `biome check --write packages`). Do NOT use `npm run format` — it does not sort imports and the `biome check` CI gate fails on unsorted imports (this broke a prior PR's CI).
- **Test commands:**
  - llm-agent-libs: `npm run test -w @mcp-abap-adt/llm-agent-libs`
  - llm-agent (contracts): `npm run test -w @mcp-abap-adt/llm-agent`
  - server-libs: `npm run test -w @mcp-abap-adt/llm-agent-server-libs`
  - single file: `node --import tsx/esm --test --test-reporter=spec '<path>.test.ts'`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/llm-agent-libs/src/logger/debug-areas.ts` (create) | `DebugArea` type, `DEBUG_ENV` registry (area→env-var), `isDebugArea`, `enabledAreasFromEnv`. Pure, env-reading. |
| `packages/llm-agent-libs/src/logger/session-logger.ts` (modify) | Area-aware: 4th ctor arg `enabledAreas`; `logStep(name, data, area?)` filters. |
| `packages/llm-agent/src/interfaces/{types,executor,interpreter,stepper-interpreter,state-oracle,subagent,stepper}.ts` (modify) | Add optional `area?` to the 7 `sessionLogger.logStep` structural decls. |
| `packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts` (modify, ~118) | Compute sink dir (`cfg.logDir` ?? `DEBUG_TRACE_DIR`-default when any area on) + enabled-areas; construct `SessionLogger`. |
| `packages/llm-agent-server-libs/src/smart-agent/controller/subagent-client.ts` (modify) | `send` emits `llm` request/response records via `options.sessionLogger`. |
| `packages/llm-agent-server-libs/src/smart-agent/controller/{reviewer,finalizer,planner,target-state}.ts` (modify) | Thread `CallOptions` to their `send` calls (incl. `stepAtCursor`). |
| `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (modify) | `controller`-area decision records at decision points; pass `ctx.options` to reviewer/finalizer. |
| `.env.template`, `docs/TROUBLESHOOTING.md` (modify) | Document the `DEBUG_*` flags + `DEBUG_TRACE_DIR`. |

Areas of the registry (public): `llm`, `controller`, `mcp`, `rag`. Internal sentinel `general` (untagged legacy calls) is NOT a registry member and is enabled only under `'all'`.

---

## Task 1: Debug-area registry + `isDebugArea`

**Files:**
- Create: `packages/llm-agent-libs/src/logger/debug-areas.ts`
- Test: `packages/llm-agent-libs/src/logger/debug-areas.test.ts`

**Interfaces:**
- Produces: `type DebugArea = 'llm' | 'controller' | 'mcp' | 'rag'`; `const DEBUG_ENV: Record<DebugArea, string>`; `isDebugArea(area: DebugArea): boolean`; `enabledAreasFromEnv(): Set<DebugArea>`. Tasks 2 and 3 consume these.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/logger/debug-areas.test.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  DEBUG_ENV,
  enabledAreasFromEnv,
  isDebugArea,
} from './debug-areas.js';

const VARS = ['DEBUG_LLM', 'DEBUG_CONTROLLER', 'DEBUG_MCP', 'DEBUG_RAG'];
afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

test('registry maps every area to its DEBUG_ env var', () => {
  assert.deepEqual(DEBUG_ENV, {
    llm: 'DEBUG_LLM',
    controller: 'DEBUG_CONTROLLER',
    mcp: 'DEBUG_MCP',
    rag: 'DEBUG_RAG',
  });
});

test('isDebugArea reads the env var (set / unset / arbitrary truthy)', () => {
  assert.equal(isDebugArea('llm'), false);
  process.env.DEBUG_LLM = '1';
  assert.equal(isDebugArea('llm'), true);
  process.env.DEBUG_LLM = 'yes';
  assert.equal(isDebugArea('llm'), true);
  process.env.DEBUG_LLM = '';
  assert.equal(isDebugArea('llm'), false);
});

test('enabledAreasFromEnv collects exactly the on-flags', () => {
  assert.deepEqual([...enabledAreasFromEnv()], []);
  process.env.DEBUG_LLM = '1';
  process.env.DEBUG_MCP = '1';
  assert.deepEqual([...enabledAreasFromEnv()].sort(), ['llm', 'mcp']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-libs/src/logger/debug-areas.test.ts'`
Expected: FAIL — module `./debug-areas.js` has no such exports.

- [ ] **Step 3: Write minimal implementation**

Create `packages/llm-agent-libs/src/logger/debug-areas.ts`:

```ts
/**
 * Debug-trace areas (#213 diagnostics). Each area is gated by its own `DEBUG_*`
 * env var — uniform with the existing DEBUG_CONTROLLER / DEBUG_SMART_AGENT flags.
 * Off by default. Adding a new area = one entry here.
 */
export type DebugArea = 'llm' | 'controller' | 'mcp' | 'rag';

export const DEBUG_ENV: Record<DebugArea, string> = {
  llm: 'DEBUG_LLM',
  controller: 'DEBUG_CONTROLLER',
  mcp: 'DEBUG_MCP',
  rag: 'DEBUG_RAG',
};

/** True when the area's `DEBUG_*` env var is set to a non-empty value. */
export function isDebugArea(area: DebugArea): boolean {
  return !!process.env[DEBUG_ENV[area]];
}

/** The set of areas whose `DEBUG_*` flag is currently on. */
export function enabledAreasFromEnv(): Set<DebugArea> {
  const on = new Set<DebugArea>();
  for (const area of Object.keys(DEBUG_ENV) as DebugArea[])
    if (isDebugArea(area)) on.add(area);
  return on;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-libs/src/logger/debug-areas.test.ts'`
Expected: PASS — 3 tests.

- [ ] **Step 5: Export from the package barrel**

`packages/llm-agent-libs/src/index.ts:100` already has
`export { SessionLogger } from './logger/session-logger.js';`. Immediately after
it, add:

```ts
export {
  type DebugArea,
  DEBUG_ENV,
  isDebugArea,
  enabledAreasFromEnv,
} from './logger/debug-areas.js';
```

This is required — Task 3 (`debug-trace-sink.ts`) imports `DebugArea` /
`enabledAreasFromEnv` from the `@mcp-abap-adt/llm-agent-libs` barrel (deep-path
imports into `dist/` are not allowed).

- [ ] **Step 6: Lint + package tests + commit**

```bash
npm run lint
npm run test -w @mcp-abap-adt/llm-agent-libs
git add packages/llm-agent-libs/src/logger/debug-areas.ts packages/llm-agent-libs/src/logger/debug-areas.test.ts packages/llm-agent-libs/src/index.ts
git commit -m "feat(libs): debug-area registry + isDebugArea (#213 diagnostics)"
```
Expected: lint clean; llm-agent-libs suite green.

---

## Task 2: Area-aware `SessionLogger` + `area?` on the 7 contracts

**Files:**
- Modify: `packages/llm-agent-libs/src/logger/session-logger.ts`
- Modify (contracts, add `area?`): `packages/llm-agent/src/interfaces/types.ts:45`, `executor.ts:42`, `interpreter.ts:28`, `stepper-interpreter.ts:35`, `state-oracle.ts:8`, `subagent.ts:40`, `stepper.ts:61`
- Test: `packages/llm-agent-libs/src/logger/session-logger.test.ts`

**Interfaces:**
- Consumes: `DebugArea` from Task 1.
- Produces: `new SessionLogger(baseLogDir, sessionId, traceId, enabledAreas?)` where `enabledAreas: 'all' | Set<DebugArea>` defaults to `'all'`; `logStep(name, data, area?: DebugArea)` (defaults to the internal `general` sentinel). Task 3 constructs it; Tasks 4-5 call `logStep` with an area.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/logger/session-logger.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { SessionLogger } from './session-logger.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sesslog-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stepFiles(base: string): string[] {
  const sess = fs.readdirSync(base).find((d) => d.startsWith('session_'));
  if (!sess) return [];
  const reqRoot = path.join(base, sess);
  const req = fs.readdirSync(reqRoot).find((d) => d.startsWith('req_'));
  if (!req) return [];
  return fs.readdirSync(path.join(reqRoot, req));
}

test('all-areas (legacy logDir): every tagged AND untagged step writes', () => {
  const log = new SessionLogger(dir, 'sid', 'tid', 'all');
  log.logStep('untagged', { a: 1 });
  log.logStep('tagged_llm', { a: 2 }, 'llm');
  const files = stepFiles(dir);
  assert.equal(files.length, 2);
});

test('granular (only llm): llm writes, mcp and untagged do NOT', () => {
  const log = new SessionLogger(dir, 'sid', 'tid', new Set(['llm']));
  log.logStep('r_llm', { a: 1 }, 'llm');
  log.logStep('r_mcp', { a: 2 }, 'mcp');
  log.logStep('r_untagged', { a: 3 }); // general sentinel → off
  const files = stepFiles(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /_r_llm\.json$/);
});

test('empty enabled set: no dir, no writes', () => {
  const log = new SessionLogger(dir, 'sid', 'tid', new Set());
  log.logStep('x', {}, 'llm');
  assert.deepEqual(stepFiles(dir), []);
});

test('default enabledAreas is "all" (backward-compat, 3-arg ctor)', () => {
  const log = new SessionLogger(dir, 'sid', 'tid');
  log.logStep('legacy', { a: 1 });
  assert.equal(stepFiles(dir).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-libs/src/logger/session-logger.test.ts'`
Expected: FAIL — the 4-arg ctor / area filtering does not exist (the granular and empty tests fail; all-areas may pass by luck).

- [ ] **Step 3: Write minimal implementation**

Replace `packages/llm-agent-libs/src/logger/session-logger.ts` with:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { DebugArea } from './debug-areas.js';

/** Enabled trace areas: 'all' = legacy logDir mode (every step, incl. the
 *  untagged `general` sentinel); a Set = only those areas' tagged steps. */
export type EnabledAreas = 'all' | Set<DebugArea>;

export class SessionLogger {
  private requestDir: string | null = null;
  private fileIndex = 1;

  constructor(
    private readonly baseLogDir: string | null,
    private readonly sessionId: string,
    private readonly traceId: string,
    private readonly enabledAreas: EnabledAreas = 'all',
  ) {
    if (!this.baseLogDir) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionPath = path.join(this.baseLogDir, `session_${this.sessionId}`);
    this.requestDir = path.join(
      sessionPath,
      `req_${timestamp}_${this.traceId}`,
    );

    try {
      fs.mkdirSync(this.requestDir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create log directory: ${this.requestDir}`, err);
      this.requestDir = null;
    }
  }

  /** Write a numbered step file iff the step's area is enabled. `area` omitted =
   *  the internal `general` sentinel (only written under 'all'). */
  logStep(name: string, data: unknown, area?: DebugArea): void {
    if (!this.requestDir) return;
    if (this.enabledAreas !== 'all') {
      // Untagged (general) never writes under a granular set; tagged writes iff on.
      if (area === undefined || !this.enabledAreas.has(area)) return;
    }

    const fileName = `${String(this.fileIndex).padStart(2, '0')}_${name}.json`;
    const filePath = path.join(this.requestDir, fileName);

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      this.fileIndex++;
    } catch (err) {
      console.error(`Failed to write log file: ${filePath}`, err);
    }
  }
}
```

- [ ] **Step 4: Add `area?` to the 7 structural contracts**

In each file, change the `logStep` signature `logStep(name: string, data: unknown): void` to `logStep(name: string, data: unknown, area?: string): void`. (Contracts use `string`, not `DebugArea`, to avoid a contracts→libs import; libs narrows.) The 7 sites:
- `packages/llm-agent/src/interfaces/types.ts:45`
- `packages/llm-agent/src/interfaces/executor.ts:42`
- `packages/llm-agent/src/interfaces/interpreter.ts:28`
- `packages/llm-agent/src/interfaces/stepper-interpreter.ts:35`
- `packages/llm-agent/src/interfaces/state-oracle.ts:8`
- `packages/llm-agent/src/interfaces/subagent.ts:40`
- `packages/llm-agent/src/interfaces/stepper.ts:61`

For the multi-line block forms (`types.ts`, `interpreter.ts`, `subagent.ts` declare it as `sessionLogger?: { logStep(name: string, data: unknown): void; }`), edit the inner method line to `logStep(name: string, data: unknown, area?: string): void;`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-libs/src/logger/session-logger.test.ts'
npm run test -w @mcp-abap-adt/llm-agent
```
Expected: session-logger 4 tests PASS; the contracts package compiles + its suite green (the `area?` additions are source-compatible — existing 2-arg callers still type-check).

- [ ] **Step 6: Lint + full libs suite + commit**

```bash
npm run lint
npm run test -w @mcp-abap-adt/llm-agent-libs
git add packages/llm-agent-libs/src/logger/session-logger.ts \
        packages/llm-agent-libs/src/logger/session-logger.test.ts \
        packages/llm-agent/src/interfaces/types.ts \
        packages/llm-agent/src/interfaces/executor.ts \
        packages/llm-agent/src/interfaces/interpreter.ts \
        packages/llm-agent/src/interfaces/stepper-interpreter.ts \
        packages/llm-agent/src/interfaces/state-oracle.ts \
        packages/llm-agent/src/interfaces/subagent.ts \
        packages/llm-agent/src/interfaces/stepper.ts
git commit -m "feat(libs): area-aware SessionLogger.logStep(name,data,area?) + contract area? (#213)"
```

---

## Task 3: Sink construction — enable via `DEBUG_*` / `DEBUG_TRACE_DIR`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts` (the `new SessionLogger(...)` at ~118-123)
- Test: `packages/llm-agent-server-libs/src/smart-agent/http/__tests__/debug-trace-sink.test.ts` (create; mirror an existing `http/__tests__` test's harness if one exists, else construct the logger directly)

**Interfaces:**
- Consumes: `enabledAreasFromEnv` (Task 1), area-aware `SessionLogger` (Task 2).
- Produces: a `SessionLogger` whose dir + enabled-areas reflect `cfg.logDir` (→ dir, `'all'`) or the `DEBUG_*` flags (→ `DEBUG_TRACE_DIR` default, the on-set).

- [ ] **Step 1: Write the failing test**

Because the construction is a few lines inside a large handler, test the extracted decision as a small pure helper. Create `packages/llm-agent-server-libs/src/smart-agent/http/__tests__/debug-trace-sink.test.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { resolveTraceSink } from '../debug-trace-sink.js';

afterEach(() => {
  for (const v of ['DEBUG_LLM', 'DEBUG_MCP', 'DEBUG_TRACE_DIR']) delete process.env[v];
});

test('logDir wins → all areas, dir = logDir', () => {
  const r = resolveTraceSink('/var/log/app');
  assert.equal(r.dir, '/var/log/app');
  assert.equal(r.enabledAreas, 'all');
});

test('no logDir, DEBUG_LLM on → default trace dir, only {llm}', () => {
  process.env.DEBUG_LLM = '1';
  const r = resolveTraceSink(undefined);
  assert.equal(r.dir, './.smart-agent-debug/');
  assert.deepEqual([...(r.enabledAreas as Set<string>)], ['llm']);
});

test('DEBUG_TRACE_DIR overrides the default trace dir', () => {
  process.env.DEBUG_MCP = '1';
  process.env.DEBUG_TRACE_DIR = '/tmp/mytrace';
  const r = resolveTraceSink(undefined);
  assert.equal(r.dir, '/tmp/mytrace');
});

test('nothing set → dir null (no capture)', () => {
  const r = resolveTraceSink(undefined);
  assert.equal(r.dir, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/http/__tests__/debug-trace-sink.test.ts'`
Expected: FAIL — `../debug-trace-sink.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/llm-agent-server-libs/src/smart-agent/http/debug-trace-sink.ts`:

```ts
import {
  type DebugArea,
  enabledAreasFromEnv,
} from '@mcp-abap-adt/llm-agent-libs';

const DEFAULT_TRACE_DIR = './.smart-agent-debug/';

/** Resolve the SessionLogger sink for a request. `cfg.logDir` (legacy) wins and
 *  forces all-areas; otherwise any `DEBUG_*` area flag opens the default trace
 *  dir (or `DEBUG_TRACE_DIR`) with only the on-areas enabled; nothing → no sink. */
export function resolveTraceSink(logDir: string | undefined): {
  dir: string | null;
  enabledAreas: 'all' | Set<DebugArea>;
} {
  if (logDir) return { dir: logDir, enabledAreas: 'all' };
  const areas = enabledAreasFromEnv();
  if (areas.size === 0) return { dir: null, enabledAreas: areas };
  return {
    dir: process.env.DEBUG_TRACE_DIR || DEFAULT_TRACE_DIR,
    enabledAreas: areas,
  };
}
```

If `enabledAreasFromEnv` / `DebugArea` are not exported from the `@mcp-abap-adt/llm-agent-libs` barrel (check Task 1 Step 5), import from the deep path `@mcp-abap-adt/llm-agent-libs/dist/logger/debug-areas.js` is NOT allowed — instead add the barrel export in Task 1. Confirm the import resolves before proceeding.

- [ ] **Step 4: Wire it into the handler**

In `packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts`, replace the construction at ~118-123:

```ts
  const sessionLogger = new SessionLogger(
    cfg.logDir || null,
    sessionId,
    traceId,
  );
```

with:

```ts
  const traceSink = resolveTraceSink(cfg.logDir);
  const sessionLogger = new SessionLogger(
    traceSink.dir,
    sessionId,
    traceId,
    traceSink.enabledAreas,
  );
```

Add the import at the top (next to the existing `SessionLogger` import):
`import { resolveTraceSink } from './debug-trace-sink.js';`

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/http/__tests__/debug-trace-sink.test.ts'
```
Expected: PASS — 4 tests.

- [ ] **Step 6: Lint + package tests + commit**

```bash
npm run lint
npm run test -w @mcp-abap-adt/llm-agent-server-libs
git add packages/llm-agent-server-libs/src/smart-agent/http/debug-trace-sink.ts \
        packages/llm-agent-server-libs/src/smart-agent/http/__tests__/debug-trace-sink.test.ts \
        packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts
git commit -m "feat(server): DEBUG_* / DEBUG_TRACE_DIR trace sink resolution (#213)"
```

---

## Task 4: LLM-area capture at `ISubagentClient.send` + options threading

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/subagent-client.ts`
- Modify (thread `CallOptions` to `send`): `reviewer.ts` (`ReviewOpts` + call `:84`), `finalizer.ts` (`FinalizeOpts` + call `:197`), `planner.ts` (`stepAtCursor` `:329/338` + callers `:254/299/307`; the `:376` call already has `options`), `target-state.ts` (`:49` — `options` param already exists at `:45`, just pass it)
- Modify (pass `ctx.options` into reviewer/finalizer): `controller-coordinator-handler.ts` (`:1243`, `:1281`, `:1665`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-llm.test.ts` (create)

**Interfaces:**
- Consumes: area-aware `sessionLogger` on `CallOptions` (`options.sessionLogger`, `types.ts:45`).
- Produces: every controller `send` emits `llm_request`/`llm_response` records tagged `'llm'` when `DEBUG_LLM` is on.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-llm.test.ts`. It drives `makeSubagentClient` with a fake `ILlm` and a capturing `sessionLogger`, asserting the `llm` records carry request + response:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { makeSubagentClient } from '../subagent-client.js';

function fakeLlm(): ILlm {
  return {
    async chat() {
      return { ok: true as const, value: { content: 'hello', usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } } };
    },
  } as unknown as ILlm;
}

test('send emits llm_request + llm_response tagged "llm" with content', async () => {
  const steps: Array<{ name: string; data: unknown; area?: string }> = [];
  const sessionLogger = {
    logStep: (name: string, data: unknown, area?: string) => steps.push({ name, data, area }),
  };
  const client = makeSubagentClient(fakeLlm());
  await client.send(
    [{ role: 'user', content: 'hi' }],
    undefined,
    { sessionLogger } as never,
  );
  const req = steps.find((s) => s.name.includes('llm_request'));
  const res = steps.find((s) => s.name.includes('llm_response'));
  assert.ok(req && req.area === 'llm', 'request record tagged llm');
  assert.ok(res && res.area === 'llm', 'response record tagged llm');
  assert.deepEqual((req.data as { messages: unknown[] }).messages, [{ role: 'user', content: 'hi' }]);
  assert.equal((res.data as { content: string }).content, 'hello');
});

test('no sessionLogger → send still works, no throw', async () => {
  const client = makeSubagentClient(fakeLlm());
  const r = await client.send([{ role: 'user', content: 'hi' }]);
  assert.equal(r.kind, 'content');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-llm.test.ts'`
Expected: FAIL — `send` does not emit any `logStep`.

- [ ] **Step 3: Implement capture in `send`**

Edit `packages/llm-agent-server-libs/src/smart-agent/controller/subagent-client.ts` — replace the `send` body:

```ts
export function makeSubagentClient(llm: ILlm): ISubagentClient {
  let seq = 0;
  return {
    async send(messages, tools, options) {
      const n = ++seq;
      options?.sessionLogger?.logStep(
        `llm_request_${n}`,
        { messages, tools: tools ?? [] },
        'llm',
      );
      const r = await llm.chat(messages, tools, options);
      if (!r.ok) {
        options?.sessionLogger?.logStep(
          `llm_response_${n}`,
          { error: r.error?.message ?? 'subagent llm error' },
          'llm',
        );
        return {
          kind: 'error',
          error: r.error?.message ?? 'subagent llm error',
        };
      }
      const v = r.value;
      options?.sessionLogger?.logStep(
        `llm_response_${n}`,
        {
          content: v.content ?? '',
          toolCalls: v.toolCalls ?? [],
          finishReason: v.finishReason,
          usage: v.usage,
        },
        'llm',
      );
      const usage = v.usage ? { usage: v.usage } : {};
      if (v.toolCalls && v.toolCalls.length > 0)
        return { kind: 'tool_call', toolCalls: v.toolCalls, ...usage };
      return { kind: 'content', content: v.content ?? '', ...usage };
    },
  };
}
```

- [ ] **Step 4: Run the unit test — GREEN**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-llm.test.ts'`
Expected: PASS — 2 tests. (The capture works whenever `options.sessionLogger` is present; the next steps make sure it IS present on every controller call.)

- [ ] **Step 5: Thread `CallOptions` to the non-executor `send` calls**

The executor call already spreads `...ctx.options` (`controller-coordinator-handler.ts:1228`) — leave it. For the rest, add a `callOptions?: CallOptions` field to their opts objects and pass it to `send`:

1. **reviewer.ts** — add to `ReviewOpts` (`:15`): `callOptions?: CallOptions;` (import `CallOptions` from `@mcp-abap-adt/llm-agent`). At `:84` change `this.client.send([ ... ])` to `this.client.send([ ... ], undefined, opts.callOptions)`.
2. **finalizer.ts** — add to `FinalizeOpts` (`:10`): `callOptions?: CallOptions;`. At `:197` change `this.client.send([ ... ])` to `this.client.send([ ... ], undefined, opts.callOptions)`.
3. **planner.ts** — `stepAtCursor` (`:329`) has no `options`. Add a parameter: `private async stepAtCursor(bundle, prompt, logUsage?, boardText?, options?: CallOptions)`. At its `send` (`:338`) pass `options`: `this.planner.send([ ... ], undefined, options)`. At its three callers (`:254`, `:299`, `:307`) pass the `options` already in scope: `return this.stepAtCursor(bundle, prompt, logUsage, boardText, options);`. The `:376` `send` already has `options` in scope — add it: `this.planner.send([ ... ], undefined, options)`.
4. **target-state.ts** — `establishTargetState` already takes `options?: CallOptions` (`:45`). At the `send` (`:49`) pass it: `deps.evaluator.send([ ... ], undefined, options)`.

- [ ] **Step 6: Pass `ctx.options` from the handler into reviewer/finalizer**

In `controller-coordinator-handler.ts`, at the reviewer calls (`:1243`, `:1281`) add `callOptions: ctx.options` to the opts object literal; at the finalizer call (`:1665`) add `callOptions: ctx.options`. (These opts literals already carry `hint`/`logUsage`.)

- [ ] **Step 7: Regression test — reviewer/finalizer/target-state/stepAtCursor carry options**

Append to `debug-trace-llm.test.ts` a test per path that constructs the component with a scripted `ISubagentClient` recording the `options` it received, and asserts the `sessionLogger` was threaded through. Example for the reviewer:

```ts
import { LlmReviewer } from '../reviewer.js';

test('reviewer threads callOptions.sessionLogger to send', async () => {
  let seenOptions: unknown;
  const client = {
    async send(_m: unknown, _t: unknown, o: unknown) {
      seenOptions = o;
      return { kind: 'content' as const, content: '{"verdict":"pass"}' };
    },
  };
  const sessionLogger = { logStep() {} };
  const reviewer = new LlmReviewer(client as never);
  await reviewer.review(
    { name: 's', instructions: 'i' } as never,
    [] as never,
    'result',
    { callOptions: { sessionLogger } } as never,
  );
  assert.equal((seenOptions as { sessionLogger?: unknown })?.sessionLogger, sessionLogger);
});
```

Write the analogous test for `LlmFinalizer.finalize`, `establishTargetState`, and the planner `stepAtCursor` finalize path (call `planner.next(...)` with `options.sessionLogger` set and a plan whose cursor is at the end, asserting the scripted client saw the options). Read each component's constructor/signature first and mirror the shapes.

- [ ] **Step 8: Run tests, lint, full suite, commit**

```bash
node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-llm.test.ts'
npm run lint
npm run test -w @mcp-abap-adt/llm-agent-server-libs
git add packages/llm-agent-server-libs/src/smart-agent/controller/subagent-client.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/reviewer.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/finalizer.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/target-state.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-llm.test.ts
git commit -m "feat(server): capture controller LLM I/O at send() under DEBUG_LLM (#213)"
```
Expected: all green. If the full suite has a failure your change did not cause, report it as pre-existing with evidence — do not weaken assertions.

---

## Task 5: Controller decision (+ MCP + RAG) capture

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (decision points; MCP bridge; recall)
- Modify: tag existing `mcp_tool_call` `logStep` emissions with area `'mcp'` — `packages/llm-agent-libs/src/pipeline/agent.ts` (search `mcp_tool_call`) and `tool-loop-core.ts` (`onToolExecuted`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-decisions.test.ts` (create)

**Interfaces:**
- Consumes: `ctx.options?.sessionLogger` in the handler; area-aware `logStep`.
- Produces: `controller_decision_<kind>` records (area `controller`), `mcp` records, `rag` records.

- [ ] **Step 1: Write the failing test**

Create `debug-trace-decisions.test.ts` mirroring the controller test harness in `controller-mcp-failloud.test.ts` (read it first for `fakeCtx`, `scriptedClient`, `stubRag`, `makeDeps`). Set `ctx.options = { sessionLogger }` with a capturing logger, script a run that hits a replan/reviewer-reject, and assert a `controller_decision_*` record with area `controller` and a `reason` field is emitted:

```ts
// (harness copied from controller-mcp-failloud.test.ts)
test('#213: a replan decision emits a controller_decision record with reason', async () => {
  const steps: Array<{ name: string; area?: string; data: unknown }> = [];
  const sessionLogger = { logStep: (name: string, data: unknown, area?: string) => steps.push({ name, area, data }) };
  const { ctx } = fakeCtx({ options: { sessionLogger } as never });
  // script deps so the executor errors once → controller replans
  const handler = new ControllerCoordinatorHandler(makeReplanningDeps());
  await handler.execute(ctx, {}, undefined);
  const d = steps.find((s) => s.name.startsWith('controller_decision') && s.area === 'controller');
  assert.ok(d, 'a controller_decision record was emitted');
  assert.ok((d.data as { reason?: string }).reason, 'it carries a reason');
});
```

Define `makeReplanningDeps()` by adapting `makeDeps` so the first executor `send` returns an error/unusable result (forcing the `awaiting-replan` path). Read the handler's decision points before scripting.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-decisions.test.ts'`
Expected: FAIL — no `controller_decision_*` record emitted.

- [ ] **Step 3: Add a decision-log helper + call it at each decision point**

Near `dlog` (`controller-coordinator-handler.ts:75`) add a helper that writes to the request logger AND keeps the existing stderr `dlog`:

```ts
function logDecision(
  ctx: PipelineContext,
  kind: string,
  reason: string,
  extra?: Record<string, unknown>,
): void {
  dlog(`decision ${kind}: ${reason}`);
  ctx.options?.sessionLogger?.logStep(
    `controller_decision_${kind}`,
    { kind, reason, ...extra },
    'controller',
  );
}
```

Call `logDecision(ctx, ...)` at each decision point (spec §2 list): the `settle(...)` closure (`:954`), `phase='awaiting-replan'` transitions (`:419/:491/:635/:967/:1201`), attempt-budget cut (`:831-836`), reviewer unverifiable/verdict (`:1274-1329`), target-state establishment (`:551`). Use a short stable `kind` (`replan`, `retry-exhausted`, `reviewer-reject`, `reviewer-unverifiable`, `target-state`, `control-failure`) and the reason string already available at each site (e.g. the `cutControlFailure(reason)` argument, the reviewer verdict).

- [ ] **Step 4: Tag existing MCP + add controller MCP/RAG records**

- In `packages/llm-agent-libs/src/pipeline/agent.ts` and `tool-loop-core.ts`, add `'mcp'` as the third arg to the existing `logStep('mcp_tool_call', ...)` / `onToolExecuted` emissions (search for `mcp_tool_call`). Backward-compat holds: under `logDir` (`'all'`) they still fire.
- In the controller MCP bridge path (`controller-coordinator-handler.ts`, where `deps.callMcp` / the bridge invokes a tool), add `ctx.options?.sessionLogger?.logStep('mcp_tool_call', { name, args, result, isError, durationMs }, 'mcp')`.
- In the controller recall path (run-scoped recall), add `ctx.options?.sessionLogger?.logStep('rag_recall', { query, extracts }, 'rag')`.

- [ ] **Step 5: Run tests to verify GREEN**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-decisions.test.ts'`
Expected: PASS.

- [ ] **Step 6: Lint + full suite + commit**

```bash
npm run lint
npm run test -w @mcp-abap-adt/llm-agent-libs
npm run test -w @mcp-abap-adt/llm-agent-server-libs
git add -A packages/llm-agent-libs/src/pipeline/agent.ts \
       packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts \
       packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts \
       packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/debug-trace-decisions.test.ts
git commit -m "feat(server): controller decision/MCP/RAG debug-trace records (#213)"
```
Expected: all green. Confirm `controller-coordinator-handler.test.ts`, `round-trip.test.ts` still pass (they drive the same decision points; the added `logStep` is a no-op with no sessionLogger).

---

## Task 6: Docs + whole-branch verification

**Files:**
- Modify: `.env.template`, `docs/TROUBLESHOOTING.md`
- No code changes — verify only.

- [ ] **Step 1: Document the flags**

Add to `.env.template` (near any existing `DEBUG_*` note) and a short `docs/TROUBLESHOOTING.md` section:

```
# Debug tracing (off by default). Each writes per-step JSON files to
# DEBUG_TRACE_DIR (default ./.smart-agent-debug/), one dir per request.
# DEBUG_LLM=1         # capture every LLM call's request + response
# DEBUG_CONTROLLER=1  # controller step decisions (also prints to stderr)
# DEBUG_MCP=1         # MCP tool call args/result/timing
# DEBUG_RAG=1         # RAG recall queries + returned extracts
# DEBUG_TRACE_DIR=./.smart-agent-debug/
# Note: a trace may contain your prompt/business data — review before sharing.
```

- [ ] **Step 2: Base + scope check**

```bash
git branch --show-current            # feat/debug-trace-areas
git diff main...HEAD --stat
git diff main...HEAD --name-only | grep -v "__tests__\|docs/\|\.env"
```
Expected: only the files in the File Structure table changed. Any other production file → STOP and report.

- [ ] **Step 3: Full build + all workspace tests + lint gate**

```bash
npm run build
npm run test
npm run lint:check
```
Expected: build clean; all workspace suites pass; lint:check 0 errors (baseline warnings only).

- [ ] **Step 4: Behavior-change audit**

```bash
git diff main...HEAD -- packages/llm-agent-libs/src/pipeline/agent.ts \
                        packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts \
                        packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts
```
Read the diff: every added line is a `logStep`/`logDecision` call, an `area` arg, a comment, or an `options` pass-through. No control-flow change. If any line alters which run a request resolves to or changes processing, revert it.

- [ ] **Step 5: Live smoke (optional, if a provider is available)**

Run the server with `DEBUG_LLM=1` and no `logDir`, fire one controller request, and confirm `./.smart-agent-debug/session_*/req_*/` contains `*_llm_request_*` and `*_llm_response_*` files and NO other-area files. Paste the file list. Assert none of the files contain the api key / service key.

- [ ] **Step 6: Report**

State: tests added + counts, the exact file layout a `DEBUG_LLM` run produces, and any deviations. Paste real command output — no success claim without it.

---

## Follow-up (not this plan)

Once merged, this is the instrument for the #213 next probe: run a ballooned SAP concurrent pair with `DEBUG_LLM=1 DEBUG_CONTROLLER=1`, then read the controller decision records + LLM responses of the second (ballooned) request to see whether its responses are degraded (LLM/gateway trigger) or the loop replans on good responses (controller trigger). See [[project_issue213_residual_diagnostics]].
