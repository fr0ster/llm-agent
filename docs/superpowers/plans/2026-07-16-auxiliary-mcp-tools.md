# IAuxiliaryMcpTools + wait tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a consumer-swappable ISP seam (`IAuxiliaryMcpTools`) through which a pipeline contributes stateless auxiliary/service MCP tools — first tool `wait` — into the tool-selection catalog and the `callMcp` bridge, always present (even MCP-less), composing with the #224 per-step `perStepTimeoutMs`/`AbortSignal` control.

**Architecture:** A narrow interface in `@mcp-abap-adt/llm-agent`; the default provider + `wait` tool in `@mcp-abap-adt/llm-agent-mcp/src/auxiliary/`; composition helpers (`resolveAuxDefs`, `assertNoAuxCollision`, `composeAuxiliaryBridge`, `composeAuxiliarySelect`) in a new `@mcp-abap-adt/llm-agent-server-libs/src/mcp/compose-auxiliary.ts`; a minimal additive DI field on `BuildAgentDeps`/`IPipelineContext`; the controller wires the default `wait` at `build()`. No new logic/glue in `smart-server.ts`/handler — only the DI field + `buildServerCtx` spread that mirrors `stepExecutionControl`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions, strict), Node ≥ 22, Biome (2 spaces, single quotes, semicolons), `node:test` + `tsx`.

**Spec:** `docs/superpowers/specs/2026-07-16-auxiliary-mcp-tools-design.md`

## Global Constraints

- ESM only; use `.js` extensions in imports; `"type": "module"`.
- Interface is **narrow** — `IAuxiliaryMcpTools` is NOT `extends IMcpClient`; it has only `listTools` + `callTool`, **no `healthCheck`**, and lives **outside** the MCP fail-loud classifier.
- **RAG is out of scope** — no RAG operations in this seam.
- `aux.listTools()` is called **exactly once, at build** (`resolveAuxDefs`), validated fail-loud on `!ok`; the wrappers take the resolved `auxDefs: McpTool[]` and **never** call `listTools()` at runtime.
- `callMcp` returns `Promise<string>` (the existing bridge contract); `composeAuxiliaryBridge` maps the aux `Result<McpToolResult, McpError>` → string: `ok` → `content` (string) or `JSON.stringify(content)`; `!ok` → `error.message`. An **abort rejection is NOT mapped — it propagates**.
- Auxiliary tool errors are **tool-level** — never run the domain classifier / fail-loud escalate on the aux branch.
- Name collision (aux name equal to a domain tool name) → **fail-loud at build** via `assertNoAuxCollision(auxDefs, ctx.toolsRag)` using the sync `ctx.toolsRag.lookup(name)`. `IPipelineContext.toolsRag` is **non-optional** (`EMPTY_TOOLS_RAG` sentinel when no domain catalog; its `lookup` returns `undefined`).
- Consumer-swappable via `ctx.auxiliaryMcpTools`, threaded `BuildAgentDeps → private field → ctor → buildServerCtx spread` mirroring `stepExecutionControl`. **No `builder.ts` change.**
- Backward-compat: pipelines that do NOT compose the seam are byte-identical; the controller default **intentionally** adds `wait` to its offered tools (the livelock fix). Consumer restores the prior controller surface via `ctx.auxiliaryMcpTools = new DefaultAuxiliaryMcpTools([])`.
- `cancelableDelay` **rejects** on abort (does not swallow); clears its timer on settle/abort.
- Biome clean (`npm run lint:check`), whole-workspace build (`npm run build`) after every task.
- Run one test file: `node --import tsx/esm --test --test-reporter=spec <path>`.

**Key existing types (verbatim, from `packages/llm-agent/src/interfaces/types.ts`):**
- `Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`
- `McpTool { name: string; description: string; inputSchema: Record<string, unknown> }`
- `McpToolResult { content: string | Record<string, unknown>; isError?: boolean }`
- `LlmTool { name: string; description: string; inputSchema: Record<string, unknown> }` — **structurally identical to `McpTool`** (an `McpTool` is assignable to `LlmTool`).
- `class McpError extends SmartAgentError { constructor(message: string, code = 'MCP_ERROR') }` — the default `'MCP_ERROR'` code is tool-level (NOT in `MCP_UNAVAILABLE_CODES`).
- `CallOptions` carries `signal?: AbortSignal`.
- `IToolsRagHandle { query(text, k?, options?): Promise<readonly LlmTool[]>; lookup(name): LlmTool | undefined }`
- All exported from `@mcp-abap-adt/llm-agent`.

---

## File Structure

- Create `packages/llm-agent/src/interfaces/auxiliary-mcp-tools.ts` — the `IAuxiliaryMcpTools` interface.
- Modify `packages/llm-agent/src/interfaces/index.ts` — barrel export.
- Create `packages/llm-agent-mcp/src/auxiliary/cancelable-delay.ts` — `cancelableDelay`.
- Create `packages/llm-agent-mcp/src/auxiliary/wait-tool.ts` — `AuxToolEntry`, `makeWaitTool`, `DEFAULT_WAIT_MAX_SECONDS`.
- Create `packages/llm-agent-mcp/src/auxiliary/default-auxiliary-mcp-tools.ts` — `DefaultAuxiliaryMcpTools`.
- Modify `packages/llm-agent-mcp/src/index.ts` — export the auxiliary module.
- Create `packages/llm-agent-server-libs/src/mcp/compose-auxiliary.ts` — `resolveAuxDefs`, `assertNoAuxCollision`, `composeAuxiliaryBridge`, `composeAuxiliarySelect`.
- Modify `packages/llm-agent/src/interfaces/pipeline-plugin.ts` — `IPipelineContext.auxiliaryMcpTools?`.
- Modify `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — `BuildAgentDeps.auxiliaryMcpTools?` + private field + ctor + `buildServerCtx` spread.
- Modify `packages/llm-agent-server-libs/src/pipelines/controller.ts` — wire aux at `build()`.

---

### Task 1: `IAuxiliaryMcpTools` interface

**Files:**
- Create: `packages/llm-agent/src/interfaces/auxiliary-mcp-tools.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (add export after the `IMcpClient` export, ~line 72)
- Test: `packages/llm-agent/src/__tests__/auxiliary-mcp-tools.types.test.ts`

**Interfaces:**
- Produces: `IAuxiliaryMcpTools { listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>>; callTool(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<Result<McpToolResult, McpError>> }`

- [ ] **Step 1: Write the failing test** — `packages/llm-agent/src/__tests__/auxiliary-mcp-tools.types.test.ts`

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  IAuxiliaryMcpTools,
  McpTool,
  McpToolResult,
  Result,
} from '../index.js';

test('IAuxiliaryMcpTools is a narrow listTools/callTool contract (no healthCheck)', () => {
  const aux: IAuxiliaryMcpTools = {
    async listTools(_options?: CallOptions): Promise<Result<McpTool[], never>> {
      return { ok: true, value: [] };
    },
    async callTool(
      _name: string,
      _args: Record<string, unknown>,
      _options?: CallOptions,
    ): Promise<Result<McpToolResult, never>> {
      return { ok: true, value: { content: 'ok' } };
    },
  };
  // Narrow surface: exactly listTools + callTool, no healthCheck.
  assert.equal(typeof aux.listTools, 'function');
  assert.equal(typeof aux.callTool, 'function');
  assert.equal('healthCheck' in aux, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent/src/__tests__/auxiliary-mcp-tools.types.test.ts`
Expected: FAIL — `IAuxiliaryMcpTools` is not exported from `../index.js`.

- [ ] **Step 3: Write the interface** — `packages/llm-agent/src/interfaces/auxiliary-mcp-tools.ts`

```ts
import type {
  CallOptions,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from './types.js';

/**
 * Pipeline-level auxiliary/service MCP tools (e.g. `wait`). A NARROW seam,
 * deliberately NOT `extends IMcpClient`: no `healthCheck`, and OUTSIDE the MCP
 * fail-loud classifier — auxiliary tools are in-process, so "unavailable" does
 * not apply; an auxiliary error is always a tool-level result.
 *
 * Contributed at pipeline creation and consumer-swappable via
 * `IPipelineContext.auxiliaryMcpTools`. RAG is NOT exposed through this seam.
 */
export interface IAuxiliaryMcpTools {
  listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>>;
}
```

Then add to `packages/llm-agent/src/interfaces/index.ts` immediately after the `export type { IMcpClient } from './mcp-client.js';` line:

```ts
export type { IAuxiliaryMcpTools } from './auxiliary-mcp-tools.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent/src/__tests__/auxiliary-mcp-tools.types.test.ts`
Expected: PASS (1/1).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent/src/interfaces/auxiliary-mcp-tools.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/__tests__/auxiliary-mcp-tools.types.test.ts
git commit -m "feat(llm-agent): IAuxiliaryMcpTools interface (narrow listTools/callTool seam)"
```

---

### Task 2: `cancelableDelay`

**Files:**
- Create: `packages/llm-agent-mcp/src/auxiliary/cancelable-delay.ts`
- Test: `packages/llm-agent-mcp/src/auxiliary/__tests__/cancelable-delay.test.ts`

**Interfaces:**
- Produces: `cancelableDelay(ms: number, signal?: AbortSignal): Promise<void>` — resolves after `ms`; **rejects** if `signal` aborts (before or during); clears its timer on settle/abort.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelableDelay } from '../cancelable-delay.js';

test('cancelableDelay resolves after the delay', async () => {
  const t0 = Date.now();
  await cancelableDelay(30);
  assert.ok(Date.now() - t0 >= 25);
});

test('cancelableDelay rejects immediately when the signal is already aborted', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(cancelableDelay(1000, ctrl.signal));
});

test('cancelableDelay rejects when aborted mid-wait (and does not hang past abort)', async () => {
  const ctrl = new AbortController();
  const p = cancelableDelay(10_000, ctrl.signal);
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(p);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-mcp/src/auxiliary/__tests__/cancelable-delay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * A `setTimeout`-based delay that REJECTS on `signal` abort (before or during),
 * clearing its timer on settle/abort. It does NOT swallow abort — the rejection
 * must propagate so the controller's per-step abort discriminator handles it.
 */
export function cancelableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abortError = (): Error =>
      (signal?.reason as Error | undefined) ??
      new DOMException('Aborted', 'AbortError');

    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-mcp/src/auxiliary/__tests__/cancelable-delay.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-mcp/src/auxiliary/cancelable-delay.ts packages/llm-agent-mcp/src/auxiliary/__tests__/cancelable-delay.test.ts
git commit -m "feat(llm-agent-mcp): cancelableDelay (rejects on abort, clears timer)"
```

---

### Task 3: `makeWaitTool` + `AuxToolEntry`

**Files:**
- Create: `packages/llm-agent-mcp/src/auxiliary/wait-tool.ts`
- Test: `packages/llm-agent-mcp/src/auxiliary/__tests__/wait-tool.test.ts`

**Interfaces:**
- Consumes: `cancelableDelay` (Task 2); `McpTool`, `McpToolResult`, `McpError`, `Result`, `CallOptions` from `@mcp-abap-adt/llm-agent`.
- Produces:
  - `AuxToolEntry { def: McpTool; handler: (args: Record<string, unknown>, options?: CallOptions) => Promise<Result<McpToolResult, McpError>> }`
  - `DEFAULT_WAIT_MAX_SECONDS = 60`
  - `makeWaitTool(maxSeconds?: number): AuxToolEntry`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_WAIT_MAX_SECONDS, makeWaitTool } from '../wait-tool.js';

test('makeWaitTool def has name wait and a real JSON Schema', () => {
  const { def } = makeWaitTool();
  assert.equal(def.name, 'wait');
  assert.match(def.description, /Maximum 60 seconds/);
  assert.deepEqual(def.inputSchema, {
    type: 'object',
    properties: { seconds: { type: 'number', minimum: 0 } },
    required: ['seconds'],
    additionalProperties: false,
  });
  assert.equal(DEFAULT_WAIT_MAX_SECONDS, 60);
});

test('wait handler waits the requested seconds and returns a text result', async () => {
  const { handler } = makeWaitTool();
  const t0 = Date.now();
  const r = await handler({ seconds: 0.05 });
  assert.ok(r.ok);
  assert.equal((r.value.content as string), 'Waited 0.05s');
  assert.ok(Date.now() - t0 >= 40);
});

test('wait handler clamps to maxSeconds and notes the cap', async () => {
  const { handler } = makeWaitTool(0.02);
  const r = await handler({ seconds: 5 });
  assert.ok(r.ok);
  assert.equal(r.value.content, 'Waited 0.02s (requested 5, capped at 0.02)');
});

test('wait handler rejects invalid seconds with a tool-level error (not thrown)', async () => {
  const { handler } = makeWaitTool();
  const r = await handler({ seconds: 'soon' as unknown as number });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error.message, /non-negative number/);
});

test('wait handler propagates abort (rejects, not returns)', async () => {
  const { handler } = makeWaitTool();
  const ctrl = new AbortController();
  const p = handler({ seconds: 100 }, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(p);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-mcp/src/auxiliary/__tests__/wait-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import type {
  CallOptions,
  McpError as McpErrorType,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { cancelableDelay } from './cancelable-delay.js';

export interface AuxToolEntry {
  def: McpTool;
  handler: (
    args: Record<string, unknown>,
    options?: CallOptions,
  ) => Promise<Result<McpToolResult, McpErrorType>>;
}

export const DEFAULT_WAIT_MAX_SECONDS = 60;

/**
 * The `wait` auxiliary tool: pause N seconds (clamped to `maxSeconds`) before
 * continuing. Honors `options.signal` via `cancelableDelay` — an abort
 * propagates (rejects). Invalid `seconds` is a tool-level error (returned,
 * not thrown).
 */
export function makeWaitTool(
  maxSeconds: number = DEFAULT_WAIT_MAX_SECONDS,
): AuxToolEntry {
  return {
    def: {
      name: 'wait',
      description:
        'Pause for the given number of seconds before continuing. Use after ' +
        'an asynchronous create/activate operation, before verifying, to let ' +
        `the system settle. Maximum ${maxSeconds} seconds.`,
      inputSchema: {
        type: 'object',
        properties: { seconds: { type: 'number', minimum: 0 } },
        required: ['seconds'],
        additionalProperties: false,
      },
    },
    handler: async (args, options) => {
      const raw = (args as { seconds?: unknown }).seconds;
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        return {
          ok: false,
          error: new McpError("wait: 'seconds' must be a non-negative number"),
        };
      }
      const clamped = Math.min(raw, maxSeconds);
      await cancelableDelay(clamped * 1000, options?.signal);
      const note =
        clamped < raw ? ` (requested ${raw}, capped at ${maxSeconds})` : '';
      return { ok: true, value: { content: `Waited ${clamped}s${note}` } };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-mcp/src/auxiliary/__tests__/wait-tool.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-mcp/src/auxiliary/wait-tool.ts packages/llm-agent-mcp/src/auxiliary/__tests__/wait-tool.test.ts
git commit -m "feat(llm-agent-mcp): makeWaitTool + AuxToolEntry (wait tool, clamp, abort-propagates)"
```

---

### Task 4: `DefaultAuxiliaryMcpTools`

**Files:**
- Create: `packages/llm-agent-mcp/src/auxiliary/default-auxiliary-mcp-tools.ts`
- Modify: `packages/llm-agent-mcp/src/index.ts` (export the auxiliary module — see Step 3)
- Test: `packages/llm-agent-mcp/src/auxiliary/__tests__/default-auxiliary-mcp-tools.test.ts`

**Interfaces:**
- Consumes: `AuxToolEntry`, `makeWaitTool` (Task 3); `IAuxiliaryMcpTools` (Task 1); `McpError` from `@mcp-abap-adt/llm-agent`.
- Produces: `class DefaultAuxiliaryMcpTools implements IAuxiliaryMcpTools` with `constructor(entries: AuxToolEntry[])`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultAuxiliaryMcpTools } from '../default-auxiliary-mcp-tools.js';
import { makeWaitTool } from '../wait-tool.js';

test('listTools returns the entry defs', async () => {
  const aux = new DefaultAuxiliaryMcpTools([makeWaitTool()]);
  const listed = await aux.listTools();
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.map((d) => d.name), ['wait']);
});

test('callTool routes by name to the entry handler', async () => {
  const aux = new DefaultAuxiliaryMcpTools([makeWaitTool()]);
  const r = await aux.callTool('wait', { seconds: 0 });
  assert.ok(r.ok);
  assert.equal(r.value.content, 'Waited 0s');
});

test('callTool on an unknown name returns a tool-level error (not thrown)', async () => {
  const aux = new DefaultAuxiliaryMcpTools([makeWaitTool()]);
  const r = await aux.callTool('nope', {});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error.message, /unknown auxiliary tool/);
});

test('empty provider lists nothing and every name is unknown', async () => {
  const aux = new DefaultAuxiliaryMcpTools([]);
  const listed = await aux.listTools();
  assert.ok(listed.ok);
  assert.deepEqual(listed.value, []);
  const r = await aux.callTool('wait', { seconds: 0 });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-mcp/src/auxiliary/__tests__/default-auxiliary-mcp-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation + export**

`packages/llm-agent-mcp/src/auxiliary/default-auxiliary-mcp-tools.ts`:

```ts
import type {
  CallOptions,
  IAuxiliaryMcpTools,
  McpError as McpErrorType,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import type { AuxToolEntry } from './wait-tool.js';

/**
 * Our example `IAuxiliaryMcpTools`: a fixed list of in-process tool entries.
 * `listTools` returns their defs; `callTool` routes by name to the handler.
 * An unknown name is a tool-level error (NOT thrown — never "unavailable").
 * A handler that REJECTS (e.g. `wait` on abort) propagates unchanged.
 */
export class DefaultAuxiliaryMcpTools implements IAuxiliaryMcpTools {
  private readonly byName: Map<string, AuxToolEntry>;

  constructor(private readonly entries: AuxToolEntry[]) {
    this.byName = new Map(entries.map((e) => [e.def.name, e]));
  }

  async listTools(): Promise<Result<McpTool[], McpErrorType>> {
    return { ok: true, value: this.entries.map((e) => e.def) };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpErrorType>> {
    const entry = this.byName.get(name);
    if (!entry) {
      return { ok: false, error: new McpError(`unknown auxiliary tool: ${name}`) };
    }
    return entry.handler(args, options);
  }
}
```

Then add to `packages/llm-agent-mcp/src/index.ts` (append with the other exports):

```ts
export { cancelableDelay } from './auxiliary/cancelable-delay.js';
export { DEFAULT_WAIT_MAX_SECONDS, makeWaitTool } from './auxiliary/wait-tool.js';
export type { AuxToolEntry } from './auxiliary/wait-tool.js';
export { DefaultAuxiliaryMcpTools } from './auxiliary/default-auxiliary-mcp-tools.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-mcp/src/auxiliary/__tests__/default-auxiliary-mcp-tools.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-mcp/src/auxiliary/default-auxiliary-mcp-tools.ts packages/llm-agent-mcp/src/index.ts packages/llm-agent-mcp/src/auxiliary/__tests__/default-auxiliary-mcp-tools.test.ts
git commit -m "feat(llm-agent-mcp): DefaultAuxiliaryMcpTools + auxiliary exports"
```

---

### Task 5: `resolveAuxDefs` + `assertNoAuxCollision`

**Files:**
- Create: `packages/llm-agent-server-libs/src/mcp/compose-auxiliary.ts`
- Test: `packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts`

**Interfaces:**
- Consumes: `IAuxiliaryMcpTools`, `McpTool`, `IToolsRagHandle`, `LlmTool` from `@mcp-abap-adt/llm-agent`.
- Produces:
  - `resolveAuxDefs(aux: IAuxiliaryMcpTools): Promise<McpTool[]>` — awaits `aux.listTools()`; throws on `!ok`; returns the defs.
  - `assertNoAuxCollision(auxDefs: McpTool[], toolsRag: IToolsRagHandle): void` — throws if any def name resolves via `toolsRag.lookup`.

- [ ] **Step 1: Write the failing test** (create the file with the Task 5 tests; Tasks 6 and 7 append to it)

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IAuxiliaryMcpTools, IToolsRagHandle, LlmTool, McpTool } from '@mcp-abap-adt/llm-agent';
import { assertNoAuxCollision, resolveAuxDefs } from '../compose-auxiliary.js';

const waitDef: McpTool = { name: 'wait', description: 'w', inputSchema: {} };

const auxOk: IAuxiliaryMcpTools = {
  async listTools() {
    return { ok: true, value: [waitDef] };
  },
  async callTool() {
    return { ok: true, value: { content: 'x' } };
  },
};

const auxFail: IAuxiliaryMcpTools = {
  async listTools() {
    return { ok: false, error: new Error('boom') as never };
  },
  async callTool() {
    return { ok: true, value: { content: 'x' } };
  },
};

const emptyToolsRag: IToolsRagHandle = {
  async query() {
    return [];
  },
  lookup() {
    return undefined;
  },
};

const collidingToolsRag: IToolsRagHandle = {
  async query() {
    return [];
  },
  lookup(name: string): LlmTool | undefined {
    return name === 'wait'
      ? { name: 'wait', description: 'domain', inputSchema: {} }
      : undefined;
  },
};

test('resolveAuxDefs returns defs on ok', async () => {
  assert.deepEqual((await resolveAuxDefs(auxOk)).map((d) => d.name), ['wait']);
});

test('resolveAuxDefs throws (never silently skips) on !ok', async () => {
  await assert.rejects(resolveAuxDefs(auxFail), /failed to list/);
});

test('assertNoAuxCollision throws when a domain tool shares the name', () => {
  assert.throws(
    () => assertNoAuxCollision([waitDef], collidingToolsRag),
    /collides with a connected MCP tool/,
  );
});

test('assertNoAuxCollision passes when lookup returns undefined (EMPTY/no-domain)', () => {
  assert.doesNotThrow(() => assertNoAuxCollision([waitDef], emptyToolsRag));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** — `packages/llm-agent-server-libs/src/mcp/compose-auxiliary.ts`

```ts
import type {
  IAuxiliaryMcpTools,
  IToolsRagHandle,
  McpTool,
} from '@mcp-abap-adt/llm-agent';

/**
 * Resolve the auxiliary tool defs ONCE at build. `!ok` is a real bug in the
 * in-process provider — fail loud, never silently skip the aux tools.
 */
export async function resolveAuxDefs(
  aux: IAuxiliaryMcpTools,
): Promise<McpTool[]> {
  const listed = await aux.listTools();
  if (!listed.ok) {
    throw new Error(
      `auxiliary tools failed to list at build: ${listed.error.message}`,
    );
  }
  return listed.value;
}

/**
 * Fail-loud collision gate (sync, over the already-resolved defs). Aux-first
 * dispatch would otherwise silently shadow a same-named domain tool. Uses the
 * sync `toolsRag.lookup` (non-optional on IPipelineContext; EMPTY_TOOLS_RAG
 * returns undefined for every name when there is no domain catalog).
 */
export function assertNoAuxCollision(
  auxDefs: McpTool[],
  toolsRag: IToolsRagHandle,
): void {
  for (const def of auxDefs) {
    if (toolsRag.lookup(def.name) !== undefined) {
      throw new Error(
        `auxiliary tool '${def.name}' collides with a connected MCP tool — ` +
          'rename the auxiliary tool',
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/mcp/compose-auxiliary.ts packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts
git commit -m "feat(server-libs): resolveAuxDefs + assertNoAuxCollision (build-time aux resolution + collision gate)"
```

---

### Task 6: `composeAuxiliaryBridge`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/mcp/compose-auxiliary.ts` (add `composeAuxiliaryBridge`)
- Test: `packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts` (append)

**Interfaces:**
- Consumes: `McpTool`, `McpToolResult`, `McpError`, `Result`, `CallOptions` from `@mcp-abap-adt/llm-agent`.
- Produces: `composeAuxiliaryBridge(auxDefs: McpTool[], auxCallTool: AuxCallTool, domainBridge: CallMcp): CallMcp` where
  - `type CallMcp = (name: string, args: unknown, signal?: AbortSignal) => Promise<string>`
  - `type AuxCallTool = (name: string, args: Record<string, unknown>, options?: CallOptions) => Promise<Result<McpToolResult, McpError>>`

- [ ] **Step 1: Write the failing test** (append to `compose-auxiliary.test.ts`)

```ts
import { composeAuxiliaryBridge } from '../compose-auxiliary.js';
import type { McpError, McpToolResult, Result } from '@mcp-abap-adt/llm-agent';

test('composeAuxiliaryBridge: aux name maps ok content to string; domain untouched', async () => {
  let domainCalls = 0;
  const domain = async () => {
    domainCalls++;
    return 'DOMAIN';
  };
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => ({
    ok: true,
    value: { content: 'Waited 1s' },
  });
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, domain);
  assert.equal(await bridge('wait', { seconds: 1 }), 'Waited 1s');
  assert.equal(domainCalls, 0);
  assert.equal(await bridge('ReadTable', {}), 'DOMAIN');
  assert.equal(domainCalls, 1);
});

test('composeAuxiliaryBridge: aux ok object content is JSON-stringified', async () => {
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => ({
    ok: true,
    value: { content: { a: 1 } },
  });
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, async () => 'D');
  assert.equal(await bridge('wait', {}), JSON.stringify({ a: 1 }));
});

test('composeAuxiliaryBridge: aux !ok maps to error.message (no throw, no domain)', async () => {
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => ({
    ok: false,
    error: { message: 'bad args' } as McpError,
  });
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, async () => 'D');
  assert.equal(await bridge('wait', {}), 'bad args');
});

test('composeAuxiliaryBridge: an aux rejection (abort) propagates, not mapped', async () => {
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => {
    throw new DOMException('Aborted', 'AbortError');
  };
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, async () => 'D');
  await assert.rejects(bridge('wait', {}));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts`
Expected: FAIL — `composeAuxiliaryBridge` is not exported.

- [ ] **Step 3: Write the implementation** (add to `compose-auxiliary.ts`; add `CallOptions`, `McpToolResult`, `McpError`, `Result` to the type import)

```ts
type CallMcp = (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<string>;

type AuxCallTool = (
  name: string,
  args: Record<string, unknown>,
  options?: CallOptions,
) => Promise<Result<McpToolResult, McpError>>;

/**
 * Wrap the domain `callMcp` bridge so auxiliary tools are dispatched FIRST
 * (aux-first; collisions were rejected at build). Auxiliary results are mapped
 * to the string bridge contract: ok → content text / JSON; !ok → error.message
 * (tool-level, the domain classifier / fail-loud is NOT run). An abort rejection
 * from `auxCallTool` propagates unchanged (see the controller's abort handling).
 */
export function composeAuxiliaryBridge(
  auxDefs: McpTool[],
  auxCallTool: AuxCallTool,
  domainBridge: CallMcp,
): CallMcp {
  const auxNames = new Set(auxDefs.map((d) => d.name));
  return async (name, args, signal) => {
    if (!auxNames.has(name)) return domainBridge(name, args, signal);
    const safeArgs =
      args != null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const result = await auxCallTool(
      name,
      safeArgs,
      signal ? { signal } : undefined,
    );
    if (!result.ok) return result.error.message;
    const { content } = result.value;
    return typeof content === 'string' ? content : JSON.stringify(content);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts`
Expected: PASS (8/8 total in the file).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/mcp/compose-auxiliary.ts packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts
git commit -m "feat(server-libs): composeAuxiliaryBridge (aux-first dispatch, Result->string, abort propagates)"
```

---

### Task 7: `composeAuxiliarySelect`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/mcp/compose-auxiliary.ts` (add `composeAuxiliarySelect`)
- Test: `packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts` (append)

**Interfaces:**
- Consumes: `McpTool`, `LlmTool`, `CallOptions` from `@mcp-abap-adt/llm-agent`.
- Produces: `composeAuxiliarySelect(auxDefs: McpTool[], selectTools: SelectTools): SelectTools` where `type SelectTools = (query: string, k?: number, options?: CallOptions) => Promise<readonly LlmTool[]>`. Aux defs (`McpTool` is structurally an `LlmTool`) are merged into every result, deduped by name.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { composeAuxiliarySelect } from '../compose-auxiliary.js';

test('composeAuxiliarySelect merges aux defs into domain results (deduped)', async () => {
  const domain = async () => [
    { name: 'ReadTable', description: 'r', inputSchema: {} },
  ];
  const select = composeAuxiliarySelect([waitDef], domain);
  const out = await select('do something', 5);
  assert.deepEqual(out.map((t) => t.name), ['ReadTable', 'wait']);
});

test('composeAuxiliarySelect: empty domain (MCP-less) yields exactly the aux defs', async () => {
  const select = composeAuxiliarySelect([waitDef], async () => []);
  const out = await select('x');
  assert.deepEqual(out.map((t) => t.name), ['wait']);
});

test('composeAuxiliarySelect dedupes if a domain tool already has the aux name', async () => {
  const domain = async () => [{ name: 'wait', description: 'domain', inputSchema: {} }];
  const select = composeAuxiliarySelect([waitDef], domain);
  const out = await select('x');
  assert.equal(out.filter((t) => t.name === 'wait').length, 1);
});

test('wrappers do not call aux.listTools at runtime (cached defs)', async () => {
  // resolveAuxDefs is the ONLY listTools caller; the wrappers take auxDefs.
  // Guard: build both wrappers from a defs array and exercise them; a spy aux
  // whose listTools throws must never be invoked.
  const spyAux: import('@mcp-abap-adt/llm-agent').IAuxiliaryMcpTools = {
    async listTools() {
      throw new Error('listTools must not be called at runtime');
    },
    async callTool() {
      return { ok: true, value: { content: 'W' } };
    },
  };
  const select = composeAuxiliarySelect([waitDef], async () => []);
  const bridge = composeAuxiliaryBridge([waitDef], spyAux.callTool.bind(spyAux), async () => 'D');
  await select('x');
  await select('y');
  assert.equal(await bridge('wait', {}), 'W');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts`
Expected: FAIL — `composeAuxiliarySelect` is not exported.

- [ ] **Step 3: Write the implementation** (add to `compose-auxiliary.ts`; add `LlmTool` to the type import)

```ts
type SelectTools = (
  query: string,
  k?: number,
  options?: CallOptions,
) => Promise<readonly LlmTool[]>;

/**
 * Wrap the pipeline's `selectTools` so the resolved auxiliary defs are ALWAYS
 * merged into every selection result (deduped by name; aux appended). Auxiliary
 * tools are a small fixed utility set that should always be in scope — not
 * semantically ranked — which also makes them available MCP-less (domain
 * `selectTools` → [] → result is just the aux defs). `McpTool` is structurally
 * an `LlmTool`, so aux defs are assignable into the `LlmTool[]` result.
 */
export function composeAuxiliarySelect(
  auxDefs: McpTool[],
  selectTools: SelectTools,
): SelectTools {
  return async (query, k, options) => {
    const domain = await selectTools(query, k, options);
    const domainNames = new Set(domain.map((t) => t.name));
    const extra = auxDefs.filter((d) => !domainNames.has(d.name));
    return [...domain, ...extra];
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts`
Expected: PASS (12/12 total in the file).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/mcp/compose-auxiliary.ts packages/llm-agent-server-libs/src/mcp/__tests__/compose-auxiliary.test.ts
git commit -m "feat(server-libs): composeAuxiliarySelect (aux defs always merged into selection)"
```

---

### Task 8: DI threading (`IPipelineContext` + `BuildAgentDeps`)

**Files:**
- Modify: `packages/llm-agent/src/interfaces/pipeline-plugin.ts` (add field after `stepExecutionControl?`, ~line 64)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (BuildAgentDeps field ~line 362; private field ~line 747; ctor assignment ~line 782; `buildServerCtx` spread ~line 2094 — all mirroring `stepExecutionControl`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/auxiliary-mcp-tools-di.test.ts`

**Interfaces:**
- Consumes: `IAuxiliaryMcpTools` (Task 1).
- Produces: `IPipelineContext.auxiliaryMcpTools?: IAuxiliaryMcpTools`; `BuildAgentDeps.auxiliaryMcpTools?: IAuxiliaryMcpTools`, threaded to `ctx.auxiliaryMcpTools`.

> Mirror the exact `stepExecutionControl` threading. Read the existing lines first (`grep -n stepExecutionControl packages/llm-agent-server-libs/src/smart-agent/smart-server.ts`) and add the `auxiliaryMcpTools` sibling in each of the four spots. Read `step-run-execution-control-di.test.ts` in the same `__tests__` dir for the `buildServerCtx`-via-cast test pattern (stub `_workers.build` + `_stepperKnowledgeBackend`).

- [ ] **Step 1: Write the failing test**

**IMPORTANT — `buildServerCtx` requires a `scope` argument** (`smart-server.ts:2019`, it reads `scope.parts`). Do NOT call it with no args. Copy the sibling test's two helpers **verbatim** and use them:
- `fakeScope()` — `step-run-execution-control-di.test.ts:61-76` (returns `{ sessionId, parts: { sessionId, mcpClients: [], toolsRag: undefined, ragRegistry, logger } }`)
- `callBuildServerCtx(server)` — `step-run-execution-control-di.test.ts:85-103` (stubs `_workers` + `_stepperKnowledgeBackend`, then `server.buildServerCtx(fakeScope())`)

Also copy from that file (verbatim): `MINIMAL_CFG`, and the `InMemoryKnowledgeBackend` + `SessionRequestLogger` imports.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IAuxiliaryMcpTools } from '@mcp-abap-adt/llm-agent';
import { SmartServer } from '../smart-server.js';
// + MINIMAL_CFG, fakeScope(), callBuildServerCtx() copied verbatim from
//   step-run-execution-control-di.test.ts (same directory).

const sentinel: IAuxiliaryMcpTools = {
  async listTools() {
    return { ok: true, value: [] };
  },
  async callTool() {
    return { ok: true, value: { content: 'x' } };
  },
};

test('(a) YES injection: buildServerCtx ctx carries consumer-injected auxiliaryMcpTools', async () => {
  const server = new SmartServer(MINIMAL_CFG, { auxiliaryMcpTools: sentinel });
  const ctx = await callBuildServerCtx(server);
  assert.equal(ctx.auxiliaryMcpTools, sentinel);
});

test('(b) NO injection: ctx.auxiliaryMcpTools is undefined (pipeline resolves its own default)', async () => {
  const server = new SmartServer(MINIMAL_CFG, {});
  const ctx = await callBuildServerCtx(server);
  assert.equal(ctx.auxiliaryMcpTools, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/__tests__/auxiliary-mcp-tools-di.test.ts`
Expected: FAIL — `ctx.auxiliaryMcpTools` is `undefined` even when injected (field not threaded).

- [ ] **Step 3: Add the field in all four spots**

In `packages/llm-agent/src/interfaces/pipeline-plugin.ts`, add a **direct** sibling type import (NOT via the barrel — this file is itself part of the barrel; a barrel import would be self/cyclic. It already imports siblings directly, e.g. `import type { IMcpClient } from './mcp-client.js';`):

```ts
import type { IAuxiliaryMcpTools } from './auxiliary-mcp-tools.js';
```

Then, after the `stepExecutionControl?: IStepExecutionControl;` line, add the field:

```ts
  /** Consumer-swappable auxiliary/service MCP tools contributed at pipeline
   *  creation (e.g. `wait`). Undefined → the pipeline supplies its own default. */
  auxiliaryMcpTools?: IAuxiliaryMcpTools;
```

In `smart-server.ts`, mirror `stepExecutionControl` at each site:

BuildAgentDeps (after the `stepExecutionControl?` field ~line 362):
```ts
  /** Threaded onto `IPipelineContext.auxiliaryMcpTools`; the pipeline resolves
   *  its own default (e.g. `wait`) when absent. */
  auxiliaryMcpTools?: IAuxiliaryMcpTools;
```

Private field (near line 747):
```ts
  private readonly _auxiliaryMcpTools?: IAuxiliaryMcpTools;
```

Constructor (near line 782):
```ts
    this._auxiliaryMcpTools = deps.auxiliaryMcpTools;
```

`buildServerCtx` conditional-spread (near line 2094, alongside the `stepExecutionControl` spread):
```ts
      ...(this._auxiliaryMcpTools
        ? { auxiliaryMcpTools: this._auxiliaryMcpTools }
        : {}),
```

Add the `IAuxiliaryMcpTools` type import to `smart-server.ts` (same import group as `IStepExecutionControl`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/__tests__/auxiliary-mcp-tools-di.test.ts`
Expected: PASS (2/2). Also confirm the sibling DI suite still passes:
`node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/__tests__/step-run-execution-control-di.test.ts`

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent/src/interfaces/pipeline-plugin.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/auxiliary-mcp-tools-di.test.ts
git commit -m "feat(di): thread auxiliaryMcpTools BuildAgentDeps -> IPipelineContext (mirrors stepExecutionControl)"
```

---

### Task 9: Controller wiring at `build()`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts` (in `build()`, near the `mcpBridge` / `selectTools` definitions ~lines 130–150, and the returned `callMcp` / `selectTools` deps ~lines 288–292)
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/controller-auxiliary-wiring.test.ts`

**Interfaces:**
- Consumes: `resolveAuxDefs`, `assertNoAuxCollision`, `composeAuxiliaryBridge`, `composeAuxiliarySelect` (Tasks 5–7); `DefaultAuxiliaryMcpTools`, `makeWaitTool` (Tasks 3–4); `ctx.auxiliaryMcpTools` (Task 8).
- Produces: the controller `build()` composes aux at creation — default `wait` when no injection; consumer override wins; `callMcp` is aux-first; `selectTools` includes the aux defs.

> Read `controller-step-control-wiring.test.ts` / `controller-context-wiring.test.ts` in the same `__tests__` dir for the harness that captures the handler/factory deps (`callMcp`, `selectTools`). Mirror it.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultAuxiliaryMcpTools } from '@mcp-abap-adt/llm-agent-mcp';
// Reuse the ControllerFactoryDeps-capturing harness from
// controller-step-control-wiring.test.ts (same dir): build the controller
// pipeline with a ctx override and capture the deps passed to the handler.

test('controller default: callMcp is aux-first and selectTools includes wait', async () => {
  const deps = await buildAndCaptureControllerDeps({ /* no auxiliaryMcpTools */ });
  // wait is offered even with no domain tools:
  const tools = await deps.selectTools('review then activate then verify', 8);
  assert.ok(tools.some((t) => t.name === 'wait'));
  // calling wait goes through the aux branch and returns its text (not "Tool not found"):
  const out = await deps.callMcp('wait', { seconds: 0 });
  assert.equal(out, 'Waited 0s');
});

test('controller consumer override beats the default wait', async () => {
  const custom = new DefaultAuxiliaryMcpTools([]); // empty → restores prior surface
  const deps = await buildAndCaptureControllerDeps({ auxiliaryMcpTools: custom });
  const tools = await deps.selectTools('x', 8);
  assert.ok(!tools.some((t) => t.name === 'wait'));
});
```

(Implement `buildAndCaptureControllerDeps(ctxOverride)` by copying the harness from `controller-step-control-wiring.test.ts` and merging `ctxOverride` into its fake ctx — the fake ctx must supply a `toolsRag` whose `lookup` returns `undefined` so the collision gate passes.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/pipelines/__tests__/controller-auxiliary-wiring.test.ts`
Expected: FAIL — controller does not yet compose aux; `wait` is absent and `callMcp('wait', …)` returns `Tool not found: wait`.

- [ ] **Step 3: Wire the controller `build()`**

Add imports at the top of `controller.ts`:
```ts
import { DefaultAuxiliaryMcpTools, makeWaitTool } from '@mcp-abap-adt/llm-agent-mcp';
import {
  assertNoAuxCollision,
  composeAuxiliaryBridge,
  composeAuxiliarySelect,
  resolveAuxDefs,
} from '../mcp/compose-auxiliary.js';
```

In `build()`, right after `const mcpBridge = buildMcpBridge(mcpClients, ctx.mcpFailureClassifier);` (~line 134), compose the aux seam:
```ts
    // Auxiliary/service tools contributed at pipeline creation (default: wait).
    // Consumer overrides the whole provider via ctx.auxiliaryMcpTools.
    const aux =
      ctx.auxiliaryMcpTools ?? new DefaultAuxiliaryMcpTools([makeWaitTool()]);
    const auxDefs = await resolveAuxDefs(aux); // single build-time listTools()
    assertNoAuxCollision(auxDefs, ctx.toolsRag); // fail-loud on name collision
    const auxCallMcp = composeAuxiliaryBridge(
      auxDefs,
      aux.callTool.bind(aux),
      mcpBridge,
    );
```

Change the base `selectTools` (currently `const selectTools = (query, k?, options?) => toolsRag ? … : Promise.resolve([]);`, ~line 142) to be the wrapped one — rename the existing arrow to `baseSelectTools` and add the wrap:
```ts
    const baseSelectTools = (query: string, k?: number, options?: CallOptions) =>
      toolsRag ? toolsRag.query(query, k, options) : Promise.resolve([]);
    const selectTools = composeAuxiliarySelect(auxDefs, baseSelectTools);
```

In the returned deps object, change the `callMcp` wire (currently `callMcp: (name, args, signal) => mcpBridge(name, args, signal)`, ~line 288) to use the composed bridge:
```ts
      callMcp: (name, args, signal) => auxCallMcp(name, args, signal),
```
(`selectTools` at ~line 292 already refers to the wrapped `selectTools` constant — no further change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/pipelines/__tests__/controller-auxiliary-wiring.test.ts`
Expected: PASS (2/2). Also run the controller regression suites:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/pipelines/__tests__/controller-step-control-wiring.test.ts \
  packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
```
Expected: all green (no regression).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/pipelines/controller.ts packages/llm-agent-server-libs/src/pipelines/__tests__/controller-auxiliary-wiring.test.ts
git commit -m "feat(controller): compose IAuxiliaryMcpTools at build (default wait; aux-first callMcp; wait in selection)"
```

---

### Task 10: Live acceptance (verification-only, no commit)

**Files:** none.

- [ ] **Step 1:** `npm run build`. Start an MCP-less controller server (a config with `mcp.type: none` or no `mcp:` block, controller pipeline, an embedder for `toolsRag`). Example: reuse `.run/eval/controller9001.yaml` but with the `mcp:` block removed (save as `.run/eval/controller-auxtest.yaml`).
- [ ] **Step 2:** Send a prompt that should trigger a wait, e.g. `"Create the object, then wait a few seconds for activation, then confirm it exists."` via `POST /v1/chat/completions`.
- [ ] **Step 3:** Assert from the server log / durable bundle: `wait` appears in the offered tools (selection includes it even MCP-less), and if the executor calls it the run returns a coherent answer with a `Waited Ns` tool result — bounded by `perStepTimeoutMs` (a `wait` longer than the remaining step budget is cut → `step-timeout → replan`, never a silent hang). No `Tool not found: wait`.
- [ ] **Step 4:** Record the before/after (wait now available + honored) in the PR description. (Verification only — no code change, no commit.)

---

## Notes

- The guidance skill (`activate → wait → verify` decomposition) is a **consumer artifact** in the consumer's skills-RAG (Claude-plugin format, runtime) — NOT implemented in this repo (spec §2). Without it the `wait` tool is available but the planner may not decompose async writes; that is expected and out of scope here.
- Do NOT touch `builder.ts` / `SmartAgentDeps` — the seam threads via `BuildAgentDeps` only (spec §3.4).
- Every task: `npm run build` (whole workspace) + `npm run lint:check` (Biome, exit 0) before commit; `npm run format` if Biome reports fixable issues; commit only that task's files.
