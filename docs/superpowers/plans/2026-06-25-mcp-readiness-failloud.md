# MCP Readiness & Fail-Loud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SmartServer detect MCP unavailability (cold start or mid-life), fail loud to the consumer instead of a silent `(no response)` 200, go NOT_READY, and auto-recover to READY when MCP returns.

**Architecture:** A small error-classification primitive (`isMcpUnavailable`) lets every MCP execution surface distinguish a transport/availability failure from a tool-level error and escalate only the former. SmartServer owns a registry of configured MCP *targets* (slots: config + optional live handle), modelled on `LazyConnectionStrategy.Slot`; a periodic monitor pings the slots, drives a `_ready` flag, and lazily reconnects down targets. A request gate rejects pipeline requests with HTTP 503 while NOT_READY. A session-preserving reconnect keeps transient blips invisible.

**Tech Stack:** TypeScript (ESM, strict), node:test + tsx, Biome, the existing `@mcp-abap-adt/llm-agent{,-mcp,-libs,-server-libs}` packages.

Spec: `docs/superpowers/specs/2026-06-25-mcp-readiness-failloud-design.md`.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `packages/llm-agent/src/interfaces/types.ts` | availability `McpError` codes + `isMcpUnavailable()` classifier | 1 |
| `packages/llm-agent-mcp/src/error-mapping.ts` | **new** — `toMcpError()` message→availability-code mapper (shared by adapter + client) | 1 |
| `packages/llm-agent-mcp/src/adapter.ts` | map thrown AND returned availability errors to `ok:false` | 1 |
| `packages/llm-agent-mcp/src/client.ts` | session-preserving reconnect; THROW coded `McpError` on retry exhaustion | 2 |
| `packages/llm-agent-libs/src/pipeline/handlers/escalate-if-unavailable.ts` | **new** — shared throw-or-text decision both tool loops use | 3 |
| `packages/llm-agent-libs/src/agent.ts` | core tool loop uses `escalateIfUnavailable` | 3 |
| `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` | pipeline-handler tool loop uses `escalateIfUnavailable` | 3 |
| `packages/llm-agent-server-libs/src/smart-agent/mcp-readiness-registry.ts` | **new** — target-slot registry + readiness derivation | 4 |
| `packages/llm-agent-server-libs/src/smart-agent/mcp-readiness-monitor.ts` | **new** — periodic ping monitor + lazy reconnect | 4 |
| `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` | registry wiring, `connectMcpClientsFromConfig` no-throw, request gate, `/health` mapping, `buildMcpBridge` fail-loud, `(no response)` branch | 4–5 |

DRY/YAGNI: the registry/monitor reuse `McpConnectionConfig` + the `LazyConnectionStrategy.Slot` shape rather than inventing a parallel type.

---

## Phase 1 — Error classification primitive

### Task 1: `isMcpUnavailable` classifier + availability codes

**Files:**
- Modify: `packages/llm-agent/src/interfaces/types.ts` (near `class McpError`)
- Modify: `packages/llm-agent/src/index.ts` (export the new symbols if it re-exports types)
- Test: `packages/llm-agent/src/__tests__/mcp-unavailable.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent/src/__tests__/mcp-unavailable.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  McpError,
  MCP_UNAVAILABLE_CODES,
  isMcpUnavailable,
} from '../interfaces/types.js';

test('isMcpUnavailable: availability codes are unavailable', () => {
  for (const code of MCP_UNAVAILABLE_CODES) {
    assert.equal(isMcpUnavailable(new McpError('x', code)), true, code);
  }
});

test('isMcpUnavailable: a plain tool error is NOT unavailable', () => {
  assert.equal(isMcpUnavailable(new McpError('bad args', 'MCP_ERROR')), false);
});

test('isMcpUnavailable: non-McpError is not unavailable', () => {
  assert.equal(isMcpUnavailable(new Error('whatever')), false);
  assert.equal(isMcpUnavailable(undefined), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent && npx tsx --test src/__tests__/mcp-unavailable.test.ts`
Expected: FAIL — `MCP_UNAVAILABLE_CODES`/`isMcpUnavailable` are not exported.

- [ ] **Step 3: Implement the classifier**

Add to `packages/llm-agent/src/interfaces/types.ts` immediately after the `McpError` class:

```ts
/**
 * McpError codes that mean the MCP transport/endpoint is UNAVAILABLE (not that a
 * tool ran and returned an error). Only these escalate to fail-loud / NOT_READY;
 * a plain `MCP_ERROR` (tool-level) stays LLM feedback.
 */
export const MCP_UNAVAILABLE_CODES = [
  'MCP_NOT_CONNECTED',
  'MCP_TIMEOUT',
  'MCP_TRANSPORT',
  'MCP_HTTP_403',
  'MCP_HTTP_502',
  'MCP_HTTP_503',
  'MCP_NO_RESPONSE',
] as const;

const UNAVAILABLE_SET = new Set<string>(MCP_UNAVAILABLE_CODES);

/** True iff `err` is an McpError whose code marks the endpoint unavailable. */
export function isMcpUnavailable(err: unknown): boolean {
  return err instanceof McpError && UNAVAILABLE_SET.has(err.code);
}
```

If `packages/llm-agent/src/index.ts` re-exports from `interfaces/types.js`, ensure `MCP_UNAVAILABLE_CODES` and `isMcpUnavailable` are included in that re-export (search the file for `McpError` and add the two new names alongside it).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent && npx tsx --test src/__tests__/mcp-unavailable.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/types.ts packages/llm-agent/src/index.ts packages/llm-agent/src/__tests__/mcp-unavailable.test.ts
git commit -m "feat(mcp): isMcpUnavailable classifier + availability error codes"
```

---

### Task 2: Adapter tags transport failures with availability codes

**Files:**
- Modify: `packages/llm-agent-mcp/src/adapter.ts` (`callTool` catch at ~122–125; `listTools` catch at ~67–71; `healthCheck`)
- Test: `packages/llm-agent-mcp/src/__tests__/adapter-unavailable-codes.test.ts`

Goal: when the underlying client throws a connection/timeout/HTTP error, the `McpError` returned carries an availability code so `isMcpUnavailable` is true. Map by inspecting the thrown error's message/shape.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-mcp/src/__tests__/adapter-unavailable-codes.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMcpUnavailable } from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter } from '../adapter.js';

function adapterThatThrows(err: unknown): McpClientAdapter {
  // Minimal stub of MCPClientWrapper surface used by the adapter.
  const stub = {
    callTool: async () => {
      throw err;
    },
    listTools: async () => {
      throw err;
    },
    ping: async () => {
      throw err;
    },
  };
  return new McpClientAdapter(stub as never);
}

test('callTool transport error → unavailable McpError', async () => {
  const a = adapterThatThrows(new Error('Not connected'));
  const r = await a.callTool('GetTable', {});
  assert.equal(r.ok, false);
  assert.equal(isMcpUnavailable(r.ok ? undefined : r.error), true);
});

test('callTool MCP -32001 timeout → unavailable McpError', async () => {
  const a = adapterThatThrows(new Error('MCP error -32001: Request timed out'));
  const r = await a.callTool('GetTable', {});
  assert.equal(r.ok, false);
  assert.equal(isMcpUnavailable(r.ok ? undefined : r.error), true);
});

test('callTool that RETURNS { error: "Not connected" } → ok:false (not isError text)', async () => {
  // The real wrapper returns { result:null, error } after a failed reconnect; the
  // adapter must escalate an availability signature even on the returned path.
  const stub = {
    callTool: async () => ({ toolCallId: '1', name: 'GetTable', result: null, error: 'Not connected' }),
  };
  const a = new McpClientAdapter(stub as never);
  const r = await a.callTool('GetTable', {});
  assert.equal(r.ok, false, 'returned availability error must be ok:false');
  assert.equal(isMcpUnavailable(r.ok ? undefined : r.error), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-mcp && npx tsx --test src/__tests__/adapter-unavailable-codes.test.ts`
Expected: FAIL — errors come back as plain `MCP_ERROR`, `isMcpUnavailable` false.

- [ ] **Step 3: Implement the shared mapper + use it in the adapter**

Create `packages/llm-agent-mcp/src/error-mapping.ts` (shared by adapter + client — DRY):

```ts
// packages/llm-agent-mcp/src/error-mapping.ts
import { McpError } from '@mcp-abap-adt/llm-agent';

/** Map a thrown/returned transport message to an McpError with an availability
 *  code. Used by both McpClientAdapter (catch) and MCPClientWrapper (throw). */
export function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.toLowerCase();
  let code = 'MCP_TRANSPORT';
  if (m.includes('not connected')) code = 'MCP_NOT_CONNECTED';
  else if (m.includes('-32001') || m.includes('timed out') || m.includes('timeout'))
    code = 'MCP_TIMEOUT';
  else if (m.includes('403')) code = 'MCP_HTTP_403';
  else if (m.includes('502')) code = 'MCP_HTTP_502';
  else if (m.includes('503')) code = 'MCP_HTTP_503';
  else if (m.includes('after reconnect') || m.includes('no response'))
    code = 'MCP_NO_RESPONSE';
  return new McpError(msg, code);
}
```

In `packages/llm-agent-mcp/src/adapter.ts`, import `toMcpError` and replace the three
`catch` fallbacks (`callTool`, `listTools`, `healthCheck`) that today do
`new McpError(String(err))` with `toMcpError(err)`. **Also** convert the
returned-error path: in `callTool`'s success block, BEFORE wrapping into
`{ ok: true, isError }`, if `result.error` is set AND `isMcpUnavailable(toMcpError(result.error))`,
return `{ ok: false, error: toMcpError(result.error) }` instead — so even if the
wrapper returns `{ error }` (older path / embedded), an availability signature still
escalates. (Tool-level `result.error` without an availability signature keeps the
`ok:true/isError` text path.)

In Task 3, `MCPClientWrapper` imports `toMcpError` as `toWrapperMcpError` (same fn)
for its throw.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-mcp && npx tsx --test src/__tests__/adapter-unavailable-codes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-mcp/src/adapter.ts packages/llm-agent-mcp/src/__tests__/adapter-unavailable-codes.test.ts
git commit -m "feat(mcp): adapter tags transport failures with availability codes"
```

---

## Phase 2 — Session-preserving reconnect (§3.5)

### Task 3: Reconnect resumes the live session; fresh-session fallback

**Files:**
- Modify: `packages/llm-agent-mcp/src/client.ts` (`connect()` ~253–282; `callTool` retry ~416–436)
- Test: `packages/llm-agent-mcp/src/__tests__/client-session-reconnect.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-mcp/src/__tests__/client-session-reconnect.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCPClientWrapper } from '../client.js';

test('reconnect prefers the live server-assigned sessionId over config', () => {
  const w = new MCPClientWrapper({
    transport: 'stream-http',
    url: 'http://localhost:9/mcp',
  });
  // Simulate a prior successful connect that captured a server session id.
  (w as unknown as { sessionId?: string }).sessionId = 'live-session-123';
  // The id used for a (re)connect must be the live one, not config (undefined).
  const used = (w as unknown as {
    _sessionForConnect(): string | undefined;
  })._sessionForConnect();
  assert.equal(used, 'live-session-123');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-mcp && npx tsx --test src/__tests__/client-session-reconnect.test.ts`
Expected: FAIL — `_sessionForConnect` does not exist.

- [ ] **Step 3: Implement session-preserving reconnect**

In `packages/llm-agent-mcp/src/client.ts`, add a private helper and use it where the transport is built:

```ts
/** Session id to (re)connect with: prefer the live server-assigned id so a
 *  reconnect RESUMES the same session; fall back to the configured id. */
private _sessionForConnect(): string | undefined {
  return this.sessionId ?? this.config.sessionId;
}
```

In `connect()` change the transport construction (currently `sessionId: this.config.sessionId`):

```ts
const httpTransport = new StreamableHTTPClientTransport(
  new URL(this.config.url),
  {
    sessionId: this._sessionForConnect(),
    requestInit: { /* unchanged */ },
  },
);
```

In the `callTool` catch/retry block, if the resume-retry still fails, clear the
session and try ONE fresh connect; if THAT also fails, **throw a coded availability
`McpError`** (do NOT return `{ result:null, error }` — see Task 4 note / spec §3.5):

```ts
} catch (retryError: unknown) {
  // Resume failed — the server may have dropped the session. Clear it and try
  // ONE fresh connect so a truly-gone session does not wedge the client.
  if (this.sessionId) {
    this.sessionId = undefined;
    try {
      await this.disconnect();
      await this.connect();
      const response = await performCall();
      return { toolCallId: toolCall.id, name: toolCall.name, result: response.content };
    } catch {
      /* fall through to throw */
    }
  }
  const msg =
    retryError instanceof Error ? retryError.message : String(retryError);
  // THROW (not return) so McpClientAdapter.callTool's catch maps it to ok:false.
  // Returning { error } would be wrapped ok:true/isError and never escalate.
  throw toWrapperMcpError(msg); // coded availability McpError (Task 2 helper, shared)
}
```

Where `toWrapperMcpError(msg)` builds an `McpError` with the same availability-code
mapping as the adapter's `toMcpError` (extract that mapper into a shared
`packages/llm-agent-mcp/src/error-mapping.ts` and import it in both client.ts and
adapter.ts — DRY). Default code `MCP_NO_RESPONSE` when nothing matches.

> **Caller-contract note (review round 4):** this changes `callTool` from
> "return `{ error }` on unrecoverable failure" to "throw". Grep callers of
> `MCPClientWrapper.callTool` / `callTools`; the adapter's `callTool` already wraps in
> try/catch (adapter.ts:122) so it maps the throw to `ok:false`. Embedded/tool-level
> errors (the `result: null, error` branch at client.ts:380–388) STILL return — only
> the transport-exhaustion path throws.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-mcp && npx tsx --test src/__tests__/client-session-reconnect.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-mcp/src/client.ts packages/llm-agent-mcp/src/__tests__/client-session-reconnect.test.ts
git commit -m "feat(mcp): session-preserving reconnect with fresh-session fallback"
```

---

## Phase 3 — In-flight fail-loud at every execution surface (§3.3)

### Task 4: Core SmartAgent tool loop escalates availability errors

**Files:**
- Modify: `packages/llm-agent-libs/src/agent.ts` (tool-result handling ~1882–1886)
- Test: `packages/llm-agent-libs/src/__tests__/agent-mcp-unavailable-escalates.test.ts`

The current code (`agent.ts:1882`) stringifies `res.error.message` into the tool text for ALL `!res.ok`. Change: when `isMcpUnavailable(res.error)`, throw `res.error` so the tool loop aborts and `process()` returns `result.ok === false`. Tool-level errors keep stringifying.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/__tests__/agent-mcp-unavailable-escalates.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { makeLlm } from '../testing/index.js';

// An MCP client whose callTool always fails with an availability error, and an
// LLM that asks for that tool once.
const unavailableClient = {
  listTools: async () => ({ ok: true as const, value: [{ name: 'GetTable', description: '', inputSchema: {} }] }),
  callTool: async () => ({ ok: false as const, error: new McpError('Not connected', 'MCP_NOT_CONNECTED') }),
  healthCheck: async () => ({ ok: false as const, error: new McpError('Not connected', 'MCP_NOT_CONNECTED') }),
};

test('availability error in the tool loop fails the run (not tool text)', async () => {
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(
      makeLlm([
        { content: '', toolCalls: [{ id: '1', name: 'GetTable', arguments: {} }] },
      ]),
    )
    .setMcpClients([unavailableClient as never])
    .build();
  const res = await handle.agent.process('read table T');
  assert.equal(res.ok, false, 'run must fail loud on MCP unavailability');
  await handle.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-libs && npx tsx --test src/__tests__/agent-mcp-unavailable-escalates.test.ts`
Expected: FAIL — today the error becomes tool text and the run resolves `ok: true`.

- [ ] **Step 3: Implement escalation**

In `packages/llm-agent-libs/src/agent.ts`, at the tool-result handling (~1882), before stringifying, add (import `isMcpUnavailable` from `@mcp-abap-adt/llm-agent`):

```ts
if (!res.ok && isMcpUnavailable(res.error)) {
  // Availability failure — do NOT feed it back as tool text; abort the loop so
  // process() surfaces a loud error to the caller.
  throw res.error;
}
const text = !res.ok
  ? res.error.message
  : typeof res.value.content === 'string'
    ? res.value.content
    : JSON.stringify(res.value.content);
```

Ensure the surrounding tool-loop catch path propagates the thrown `McpError` into the `process()` Result as `ok: false` (it already wraps thrown errors into the orchestrator error; verify the throw is not swallowed by a per-tool try/catch — if a `Promise.all`/`map` wraps it, let the rejection propagate rather than converting to a result row).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-libs && npx tsx --test src/__tests__/agent-mcp-unavailable-escalates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/__tests__/agent-mcp-unavailable-escalates.test.ts
git commit -m "feat(agent): core tool loop fails loud on MCP unavailability"
```

---

### Task 5: Pipeline-handler tool loop escalates availability errors

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` (~885–892, mirror of agent.ts)
- Test: `packages/llm-agent-libs/src/__tests__/tool-loop-mcp-unavailable.test.ts`

**Two-part fix (review P2#6 — a classifier stub is not TDD; it passes even if the
handler is unchanged).** (a) Extract a shared decision helper that the handler USES,
and (b) add a REAL pipeline-level test that drives the tool-loop handler with a fake
failing MCP client.

First confirm which tool loop `SmartAgent.process()` actually drives: grep
`packages/llm-agent-libs/src/agent.ts` and `pipeline/default-pipeline.ts` for the
tool-loop handler. If `process()` routes through `pipeline/handlers/tool-loop.ts`,
Task 4's `SmartAgentBuilder` test already exercises THIS file — in that case make
Task 4's test the real coverage and keep Task 5 as the shared-helper extraction +
the agent.ts:1882 site (so BOTH the `agent.ts` inline loop and the handler use one
guarded helper). Either way, no surface is left stringifying availability errors.

- [ ] **Step 1: Write the failing test (shared helper, USED by the handler)**

Create the helper test:

```ts
// packages/llm-agent-libs/src/pipeline/handlers/__tests__/escalate-if-unavailable.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { escalateIfUnavailable } from '../escalate-if-unavailable.js';

test('throws on an availability error result', () => {
  const res = { ok: false as const, error: new McpError('Not connected', 'MCP_NOT_CONNECTED') };
  assert.throws(() => escalateIfUnavailable(res), /Not connected/);
});

test('returns text for a tool-level error result', () => {
  const res = { ok: false as const, error: new McpError('bad args', 'MCP_ERROR') };
  assert.equal(escalateIfUnavailable(res), 'bad args');
});

test('returns content for an ok result', () => {
  const res = { ok: true as const, value: { content: 'hello' } };
  assert.equal(escalateIfUnavailable(res), 'hello');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/escalate-if-unavailable.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the shared helper and CALL it from both loops**

```ts
// packages/llm-agent-libs/src/pipeline/handlers/escalate-if-unavailable.ts
import { type McpError, isMcpUnavailable } from '@mcp-abap-adt/llm-agent';
import type { Result } from '@mcp-abap-adt/llm-agent';

type ToolRes = Result<{ content: unknown }, McpError>;

/** Single decision both tool loops use: throw on an availability failure (so the
 *  run fails loud), else return the textual tool result for the LLM. */
export function escalateIfUnavailable(res: ToolRes): string {
  if (!res.ok) {
    if (isMcpUnavailable(res.error)) throw res.error;
    return res.error.message;
  }
  return typeof res.value.content === 'string'
    ? res.value.content
    : JSON.stringify(res.value.content);
}
```

Replace the `const text = !res.ok ? res.error.message : …` expression at
tool-loop.ts:885 with `const text = escalateIfUnavailable(res);`. Do the SAME at
agent.ts:1882 (Task 4 can use this helper too — DRY; if so, fold Task 4's inline
guard into this helper).

- [ ] **Step 4: Add the REAL handler regression test + verify**

In `pipeline/handlers/__tests__/` (mirror an existing tool-loop handler test if one
exists), build the tool-loop with a fake MCP client whose `callTool` returns
`{ ok:false, error: new McpError('Not connected','MCP_NOT_CONNECTED') }` and an LLM
that requests one tool call; assert the handler/pipeline run surfaces `ok:false`
(does not embed `[Error]`/tool text and continue). Run:
`npx tsx --test src/pipeline/handlers/__tests__/escalate-if-unavailable.test.ts` and
`npm run -w @mcp-abap-adt/llm-agent-libs test` — both green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts packages/llm-agent-libs/src/__tests__/tool-loop-mcp-unavailable.test.ts
git commit -m "feat(pipeline): tool-loop handler fails loud on MCP unavailability"
```

---

### Task 6: `buildMcpBridge` distinguishes not-found from unavailable

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`buildMcpBridge` ~945–966)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-bridge-failloud.test.ts`

Today `if (!listed.ok) continue;` makes a client whose `listTools()` failed look like it simply doesn't own the tool → `Tool not found`. Change: if `!listed.ok && isMcpUnavailable(listed.error)`, throw the error; only a clean "no client owns the name" yields `Tool not found`. Same for `callTool` availability errors (today it returns `result.error.message` — keep that for tool errors, throw for availability).

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-bridge-failloud.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { buildMcpBridge } from '../smart-server.js';

test('bridge throws on an availability listTools error (not Tool not found)', async () => {
  const client = {
    listTools: async () => ({ ok: false as const, error: new McpError('Not connected', 'MCP_NOT_CONNECTED') }),
    callTool: async () => ({ ok: true as const, value: { content: 'x', isError: false } }),
  };
  const bridge = buildMcpBridge([client as never]);
  await assert.rejects(() => bridge('GetTable', {}), /not connected|MCP_NOT_CONNECTED/i);
});

test('bridge still returns Tool not found when no client owns the name', async () => {
  const client = {
    listTools: async () => ({ ok: true as const, value: [] }),
    callTool: async () => ({ ok: true as const, value: { content: 'x', isError: false } }),
  };
  const bridge = buildMcpBridge([client as never]);
  assert.match(await bridge('Nope', {}), /Tool not found/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/mcp-bridge-failloud.test.ts`
Expected: FAIL — the first test gets `Tool not found` instead of a throw.

- [ ] **Step 3: Implement**

In `buildMcpBridge` (smart-server.ts), import `isMcpUnavailable` and change the loop:

```ts
for (const client of clients) {
  const listed = await client.listTools();
  if (!listed.ok) {
    if (isMcpUnavailable(listed.error)) throw listed.error; // fail loud
    continue; // benign — try the next client
  }
  const owns = listed.value.some((t) => t.name === name);
  if (!owns) continue;
  const result = await client.callTool(name, safeArgs);
  if (!result.ok) {
    if (isMcpUnavailable(result.error)) throw result.error; // fail loud
    return result.error.message; // tool-level error → LLM feedback
  }
  const { content } = result.value;
  return typeof content === 'string' ? content : JSON.stringify(content);
}
return `Tool not found: ${name}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/mcp-bridge-failloud.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-bridge-failloud.test.ts
git commit -m "feat(server): buildMcpBridge fails loud on MCP unavailability"
```

---

## Phase 4 — Readiness registry + monitor (§3.1, §3.4)

### Task 7: MCP target registry (slots from config; no-throw connect)

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/mcp-readiness-registry.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-readiness-registry.test.ts`

The registry holds one slot per configured MCP target (global `cfg.mcp` + each worker `subCfg.mcp` / DI `subCfg.mcpClients`). A slot: `{ id, config?, client?, healthy, lastAttempt }`. `allHealthy()` is true iff every slot is healthy (or there are no slots). A DI client registers as an already-live slot.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-readiness-registry.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpReadinessRegistry } from '../mcp-readiness-registry.js';

test('empty registry (no MCP configured) is healthy', () => {
  const r = new McpReadinessRegistry();
  assert.equal(r.allHealthy(), true);
});

test('a configured-but-unconnected target is NOT healthy', () => {
  const r = new McpReadinessRegistry();
  r.addTarget('global-0', { transport: 'auto', url: 'http://down:1/mcp' } as never, 'global');
  assert.equal(r.allHealthy(), false);
});

test('marking the only slot healthy makes the registry healthy', () => {
  const r = new McpReadinessRegistry();
  r.addTarget('global-0', { transport: 'auto', url: 'http://x/mcp' } as never, 'global');
  r.markHealthy('global-0', { listTools: async () => ({ ok: true, value: [] }) } as never);
  assert.equal(r.allHealthy(), true);
});

test('a live DI client registers healthy', () => {
  const r = new McpReadinessRegistry();
  r.addLiveClient('worker-a', { listTools: async () => ({ ok: true, value: [] }) } as never, 'worker');
  assert.equal(r.allHealthy(), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/mcp-readiness-registry.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the registry**

```ts
// packages/llm-agent-server-libs/src/smart-agent/mcp-readiness-registry.ts
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { SmartServerMcpConfig } from './config.js'; // adjust import to the real config type

export type ReadinessScope = 'global' | 'worker';

export interface ReadinessSlot {
  id: string;
  scope: ReadinessScope;
  config?: SmartServerMcpConfig; // absent for DI-only live clients
  client?: IMcpClient;
  healthy: boolean;
  lastAttempt: number;
}

/** Registry of configured MCP targets driving server readiness. A target with no
 *  healthy client ⇒ NOT ready. Built from config (not from successful connects),
 *  so a down-at-boot target is a DOWN slot, not a missing one. */
export class McpReadinessRegistry {
  private readonly slots = new Map<string, ReadinessSlot>();

  /** Register a configured target whose client may not be connected yet. */
  addTarget(id: string, config: SmartServerMcpConfig, scope: ReadinessScope): void {
    if (this.slots.has(id)) return;
    this.slots.set(id, { id, scope, config, healthy: false, lastAttempt: 0 });
  }

  /** Register an already-live DI client (no lazy connect needed). */
  addLiveClient(id: string, client: IMcpClient, scope: ReadinessScope): void {
    this.slots.set(id, { id, scope, client, healthy: true, lastAttempt: 0 });
  }

  markHealthy(id: string, client: IMcpClient): void {
    const s = this.slots.get(id);
    if (s) {
      s.client = client;
      s.healthy = true;
    }
  }

  markDown(id: string): void {
    const s = this.slots.get(id);
    if (s) s.healthy = false;
  }

  allHealthy(): boolean {
    for (const s of this.slots.values()) if (!s.healthy) return false;
    return true;
  }

  list(): ReadinessSlot[] {
    return [...this.slots.values()];
  }

  /** Live execution clients for GLOBAL targets — the source of truth `callMcp`
   *  reads (§3.6) so a monitor-recovered client is used without a restart. Worker
   *  targets are excluded: worker execution is builder-owned (self-heals). */
  liveClients(): IMcpClient[] {
    const out: IMcpClient[] = [];
    for (const s of this.slots.values()) {
      if (s.scope === 'global' && s.healthy && s.client) out.push(s.client);
    }
    return out;
  }
}
```

> Integration note: `connectMcpClientsFromConfig` must STOP throwing on a failed connect. Wrap its `await wrapper.connect()` in try/catch: on success, the caller `addLiveClient`s; on failure, the caller `addTarget`s the still-unconnected config so the monitor can retry. Keep the existing return type by returning successfully-connected clients only; the registry (not the return value) tracks down targets.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/mcp-readiness-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/mcp-readiness-registry.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-readiness-registry.test.ts
git commit -m "feat(server): MCP target-slot readiness registry"
```

---

### Task 8: Readiness monitor (periodic ping + lazy reconnect)

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/mcp-readiness-monitor.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-readiness-monitor.test.ts`

The monitor exposes `tick()` (one pass; the timer just calls `tick()` on an interval so tests are deterministic). Each `tick()`: for every slot with a live client, `client.healthCheck()` (→ ping); on failure mark down; for a down slot with a config, attempt a lazy reconnect via an injected `connect(config)` and `markHealthy` on success. It NEVER calls `listTools()` (cached). `isReady()` returns `registry.allHealthy()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-readiness-monitor.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { McpReadinessRegistry } from '../mcp-readiness-registry.js';
import { McpReadinessMonitor } from '../mcp-readiness-monitor.js';

test('tick: a down target reconnects and becomes ready', async () => {
  const reg = new McpReadinessRegistry();
  reg.addTarget('g0', { transport: 'auto', url: 'http://x/mcp' } as never, 'global');
  const healthyClient = {
    healthCheck: async () => ({ ok: true as const, value: true }),
  };
  const monitor = new McpReadinessMonitor(reg, {
    connect: async () => healthyClient as never, // lazy connect succeeds
    cooldownMs: 0,
  });
  assert.equal(monitor.isReady(), false);
  await monitor.tick();
  assert.equal(monitor.isReady(), true);
});

test('tick: a live client that fails healthCheck flips NOT ready', async () => {
  const reg = new McpReadinessRegistry();
  const flaky = {
    healthCheck: async () => ({ ok: false as const, error: new McpError('Not connected', 'MCP_NOT_CONNECTED') }),
  };
  reg.addLiveClient('w', flaky as never, 'worker');
  const monitor = new McpReadinessMonitor(reg, { connect: async () => { throw new Error('still down'); }, cooldownMs: 0 });
  assert.equal(monitor.isReady(), true);
  await monitor.tick();
  assert.equal(monitor.isReady(), false);
});

test('tick: a live client WITHOUT healthCheck stays ready (not marked down)', async () => {
  const reg = new McpReadinessRegistry();
  reg.addLiveClient('di', { listTools: async () => ({ ok: true, value: [] }) } as never, 'global');
  const monitor = new McpReadinessMonitor(reg, { connect: async () => { throw new Error('n/a'); }, cooldownMs: 0 });
  assert.equal(monitor.isReady(), true);
  await monitor.tick();
  assert.equal(monitor.isReady(), true); // no healthCheck ⇒ assumed healthy
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/mcp-readiness-monitor.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the monitor**

```ts
// packages/llm-agent-server-libs/src/smart-agent/mcp-readiness-monitor.ts
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { McpReadinessRegistry } from './mcp-readiness-registry.js';

export interface McpReadinessMonitorDeps {
  /** Lazily (re)connect a slot's config to a live client. Throws if still down. */
  connect: (config: unknown) => Promise<IMcpClient>;
  cooldownMs?: number;
  intervalMs?: number;
}

export class McpReadinessMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly cooldownMs: number;
  private readonly intervalMs: number;

  constructor(
    private readonly registry: McpReadinessRegistry,
    private readonly deps: McpReadinessMonitorDeps,
  ) {
    this.cooldownMs = deps.cooldownMs ?? 30000;
    this.intervalMs = deps.intervalMs ?? 10000;
  }

  isReady(): boolean {
    return this.registry.allHealthy();
  }

  /** One monitoring pass. The timer calls this; tests call it directly. */
  async tick(now = Date.now()): Promise<void> {
    for (const slot of this.registry.list()) {
      if (slot.client) {
        // healthCheck is OPTIONAL on IMcpClient (mcp-client.ts:25). A client that
        // does not implement it is ASSUMED healthy (per the interface doc) — never
        // marked down on a missing probe, else a DI/plugin client without a probe
        // wedges readiness down forever with no config to reconnect (review r5).
        if (typeof slot.client.healthCheck !== 'function') {
          this.registry.markHealthy(slot.id, slot.client);
          continue;
        }
        const hc = await slot.client.healthCheck();
        if (hc && hc.ok) {
          this.registry.markHealthy(slot.id, slot.client);
          continue;
        }
        this.registry.markDown(slot.id);
        // fall through to reconnect attempt below
      }
      if (!slot.healthy && slot.config && now - slot.lastAttempt >= this.cooldownMs) {
        slot.lastAttempt = now;
        try {
          const client = await this.deps.connect(slot.config);
          this.registry.markHealthy(slot.id, client);
        } catch {
          this.registry.markDown(slot.id);
        }
      }
    }
  }

  start(): void {
    if (this.timer) return;
    // Note: argless Date.now() inside tick() is fine at runtime; tests pass `now`.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/mcp-readiness-monitor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/mcp-readiness-monitor.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-readiness-monitor.test.ts
git commit -m "feat(server): MCP readiness monitor (ping + lazy reconnect)"
```

---

### Task 9: Wire registry + monitor into SmartServer.start(); in-flight failures flip NOT_READY

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`start()` MCP-connect block; a `_readyMonitor` field; `connectMcpClientsFromConfig` no-throw)
- Test: covered by Tasks 10–11 (request gate / health) + manual smoke

- [ ] **Step 1: Implement wiring (no isolated unit test — integration-covered)**

In `start()` where global MCP is connected (the `connectMcp` / `_stepperMcpClients` block, ~1459/2253): build a `McpReadinessRegistry`, add a slot per global target and per worker `subCfg.mcp` / DI `subCfg.mcpClients`, construct a `McpReadinessMonitor` with `connect` = the same factory used by `connectMcpClientsFromConfig`, run one `await monitor.tick()` to establish initial readiness, then `monitor.start()`. Hold both on `this`:

```ts
this._mcpReadiness = registry;
this._readyMonitor = monitor;
await this._readyMonitor.tick(); // initial readiness (cold MCP ⇒ NOT_READY)
this._readyMonitor.start();
```

Add a private accessor used by the gate/health:

```ts
private isReady(): boolean {
  return this._readyMonitor ? this._readyMonitor.isReady() : true;
}
```

For in-flight escalation: where the request handler catches a pipeline error, if `isMcpUnavailable(err)` mark the relevant slot(s) down (`this._mcpReadiness?.markDown(id)`) so the gate closes immediately. (If per-slot id is not known at that point, call a registry helper `markAllConfiguredDownPendingProbe()` that flips configured slots to unhealthy; the monitor re-validates next tick.)

In `connectMcpClientsFromConfig`, wrap `await wrapper.connect()`:

```ts
try {
  await wrapper.connect();
  connected.push(new McpClientAdapter(wrapper));
} catch {
  // Down at boot: do NOT throw — the readiness registry records the target and
  // the monitor retries. Caller decides slot registration.
}
```

> If `connectMcpClientsFromConfig` callers rely on the throw, add an out-param or a sibling `connectMcpTargets(cfg)` returning `{ connected, failedConfigs }` and use that in `start()`; keep the throwing variant for any caller that genuinely needs fail-fast (none should after this change — verify by grepping callers).

- [ ] **Step 2: Build & full server-libs suite**

Run: `npm run build && npm run -w @mcp-abap-adt/llm-agent-server-libs test`
Expected: build green; suite green (no regressions).

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "feat(server): wire MCP readiness registry+monitor; no-throw boot connect"
```

---

### Task 9b: Execution reads the registry (recovery actually works); catalog refresh; worker scope

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`callMcp` ~2210; monitor DOWN→UP hook)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/callmcp-reads-registry.test.ts`

> **Review round 4 (P1#2/#4).** `callMcp` runs `buildMcpBridge(this._sharedMcpClients ?? [])` — a SNAPSHOT harvested at start (smart-server.ts:1557). If MCP was down at boot the snapshot is `[]`; a monitor-recovered client never reaches execution and the toolsRag catalog stays empty. Flipping READY without this task is a lie. Worker `subCfg.mcp` is builder-owned (2052/2122) — out of scope for a client-swap; it self-heals via the worker client's own reconnect (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/callmcp-reads-registry.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpReadinessRegistry } from '../mcp-readiness-registry.js';
import { buildMcpBridge } from '../smart-server.js';

// Proves the execution path follows the registry's live clients, so a client added
// AFTER startup (cold-start recovery) is used without a restart.
test('bridge over registry.liveClients() sees a post-start recovered client', async () => {
  const reg = new McpReadinessRegistry();
  assert.equal(reg.liveClients().length, 0); // MCP down at boot
  const recovered = {
    listTools: async () => ({ ok: true as const, value: [{ name: 'GetTable', description: '', inputSchema: {} }] }),
    callTool: async () => ({ ok: true as const, value: { content: 'TABLE OK', isError: false } }),
  };
  reg.addLiveClient('g0', recovered as never, 'global');
  const bridge = buildMcpBridge(reg.liveClients());
  assert.equal(await bridge('GetTable', {}), 'TABLE OK');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/callmcp-reads-registry.test.ts`
Expected: FAIL until Task 7's `addLiveClient(id, client, scope)` + `liveClients()` are in place; this task locks the execution contract.

- [ ] **Step 3: Implement — `callMcp` reads the registry; catalog refresh on recovery**

```ts
private async callMcp(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
  const clients = this._mcpReadiness
    ? this._mcpReadiness.liveClients()
    : (this._sharedMcpClients ?? []);
  return buildMcpBridge(clients)(name, args, signal);
}
```

Add a DOWN→UP hook so tool SELECTION recovers (the bridge lists tools live, but
`toolsRag` was vectorized once at start). In `McpReadinessMonitorDeps` add
`onGlobalRecovered?: () => Promise<void>`; in `monitor.tick()`, after a slot that was
previously down becomes healthy AND `scope === 'global'`, call it. Wire it in
`start()` to re-run `buildToolsRagHandle({ toolsRag, resolvedEmbedder })` over
`registry.liveClients()` (guard re-entrancy with an in-flight flag).

> Worker scope (P1#4): `liveClients()` excludes `scope:'worker'`; do NOT swap
> recovered worker clients into worker internals. Worker execution recovery is the
> worker client's own session-preserving reconnect (Task 3). Add a one-line comment
> at smart-server.ts:2052 pointing here.

- [ ] **Step 4: Run the test + build**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/callmcp-reads-registry.test.ts` then `npm run build`.
Expected: PASS; build green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/mcp-readiness-monitor.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/callmcp-reads-registry.test.ts
git commit -m "feat(server): callMcp reads live clients from the registry; toolsRag refresh on recovery"
```

---

### Task 9c: Hoist worker `subCfg.mcp` to server-managed (cold-start + recovery)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (worker build path ~2052/2122; worker cache)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/worker-mcp-hoist.test.ts`

> **Review round 5 (P1#1).** A builder-owned worker `subCfg.mcp` that is down at boot is SKIPPED by the builder (builder.ts:1137) → the worker runs client-less and "self-heal" is impossible (no wrapper exists). Fix: the SERVER connects worker `subCfg.mcp` through the registry and INJECTS the client into the worker (reusing the injected-clients seam at 2122), so worker MCP is registry-managed and recovery rewires through a cache invalidation.

- [ ] **Step 1: Implement the hoist (integration-covered; unit-test the slot effect)**

When processing a worker (subagent) config at build time: if `subCfg.mcp` is set AND
`subCfg.mcpClients` is empty, do NOT let the builder connect it. Instead:
1. Register a registry slot `addTarget('worker:<name>:<i>', subCfgMcp, 'worker')`.
2. Attempt the server-owned connect (same factory as global; no-throw — Task 7). On
   success `markHealthy(...)` and pass the connected client as the worker's injected
   `mcpClients` (the path at smart-server.ts:2122 `subBuilder.withMcpClients(injected.mcpClients)`).
   On failure leave the slot DOWN (server NOT_READY).
3. On a worker slot DOWN→UP recovery (monitor), invalidate the per-worker cache entry
   (the cache at smart-server.ts:2446 `cached.mcpClients`) so the NEXT session rebuild
   injects the now-live client. Add a `onWorkerRecovered(id)` hook to the monitor deps
   mirroring `onGlobalRecovered` (Task 9b); wire it to drop the worker cache entry.

Replace the worker MCP wiring comment at smart-server.ts:2052 ("connection is the
builder's job") with a pointer to this server-managed path.

- [ ] **Step 2: Write the unit test (registry slot + injection contract)**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/worker-mcp-hoist.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpReadinessRegistry } from '../mcp-readiness-registry.js';

test('a down worker target keeps the server NOT ready', () => {
  const reg = new McpReadinessRegistry();
  reg.addTarget('worker:analyst:0', { transport: 'auto', url: 'http://down/mcp' } as never, 'worker');
  assert.equal(reg.allHealthy(), false); // worker MCP down ⇒ server not ready
});

test('worker live clients are NOT returned by liveClients() (global-only execution source)', () => {
  const reg = new McpReadinessRegistry();
  reg.addLiveClient('worker:analyst:0', { listTools: async () => ({ ok: true, value: [] }) } as never, 'worker');
  assert.equal(reg.liveClients().length, 0); // worker clients drive readiness+injection, not callMcp
  assert.equal(reg.allHealthy(), true);
});
```

- [ ] **Step 3: Run the test + build**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/worker-mcp-hoist.test.ts` then `npm run build`.
Expected: PASS; build green. Manually verify (smoke) that a DAG/stepper config with a
down worker MCP starts NOT_READY and recovers (covered in Final verification).

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/worker-mcp-hoist.test.ts
git commit -m "feat(server): hoist worker subCfg.mcp to server-managed registry (cold-start + recovery)"
```

---

## Phase 5 — Request gate + health surface (§3.2, §4)

### Task 10: Request gate — pre-dispatch NOT_READY → HTTP 503 (streaming split)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (chat-completions / messages handlers, BEFORE dispatch and BEFORE any streaming `writeHead(200)`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/readiness-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/readiness-gate.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Contract: when isReady() is false, the pipeline request handler must respond 503
// with a service_unavailable error and NOT invoke the agent. This test exercises
// the gate helper in isolation (extract `gateNotReady(res)` so it is unit-testable).
import { writeNotReady } from '../smart-server.js';

test('writeNotReady writes a 503 service_unavailable JSON error', () => {
  const written: { code?: number; body?: string } = {};
  const res = {
    writeHead(code: number) { written.code = code; return res; },
    end(body?: string) { written.body = body; },
  };
  writeNotReady(res as never);
  assert.equal(written.code, 503);
  assert.match(written.body ?? '', /service_unavailable/);
  assert.match(written.body ?? '', /not ready/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/readiness-gate.test.ts`
Expected: FAIL — `writeNotReady` not exported.

- [ ] **Step 3: Implement the gate**

Add an exported helper in `smart-server.ts`:

```ts
export function writeNotReady(res: {
  writeHead(code: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
}): void {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: {
        type: 'service_unavailable',
        message: 'MCP unavailable — server not ready',
      },
    }),
  );
}
```

In BOTH pipeline request handlers (`/v1/chat/completions` and `/v1/messages`), as the FIRST thing after parsing the body and BEFORE any dispatch or any streaming `res.writeHead(200, …text/event-stream…)`:

```ts
if (!this.isReady()) {
  writeNotReady(res);
  return;
}
```

This is the pre-dispatch path for BOTH streaming and non-streaming (it runs before the SSE stream is opened — review P2b's pre-dispatch case).

- [ ] **Step 4: Run the helper test; add a REAL route integration test (review P2#5)**

The helper test alone can pass while the route still opens a stream. Add an
integration test that drives the actual handler with `isReady() === false` and asserts
(a) HTTP 503 JSON, (b) the agent's `process` is NOT called, (c) NO SSE `200` is
opened — for a `stream: true` body too. If the suite has an existing in-process
request harness (search `smart-agent/__tests__` for one that POSTs to the handler),
use it; otherwise construct the SmartServer with a stub agent whose `process` sets a
called-flag and a fake `req`/`res`, force `isReady()` false (inject a registry with a
DOWN slot), and assert. Run the new test and `readiness-gate.test.ts` — both green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/readiness-gate.test.ts
git commit -m "feat(server): pre-dispatch readiness gate (503 before any SSE stream)"
```

---

### Task 10b: In-flight streaming failure — error chunk, then NO `[DONE]`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (streaming writer: `!chunk.ok` branch ~3505–3520; trailing `[DONE]` ~3613)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/streaming-failloud.test.ts`

> **Review round 4 (P1#3).** Today the writer emits the error chunk (`delta.content: "[Error] …"`, `break`) but then UNCONDITIONALLY writes `data: [DONE]` (smart-server.ts:3613) — a clean-finish marker after a failure. Track that the stream ended on error and skip `[DONE]` (and the usage chunk) in that case.

- [ ] **Step 1: Write the failing test**

Extract the trailing-frames decision into a pure helper so it is unit-testable:

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/streaming-failloud.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamTrailer } from '../smart-server.js';

test('a stream that ended on error emits NO [DONE]', () => {
  assert.equal(streamTrailer({ endedOnError: true }).includes('[DONE]'), false);
});
test('a clean stream emits [DONE]', () => {
  assert.equal(streamTrailer({ endedOnError: false }).includes('[DONE]'), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/streaming-failloud.test.ts`
Expected: FAIL — `streamTrailer` not exported.

- [ ] **Step 3: Implement**

Add the helper and use it; set `endedOnError` in the `!chunk.ok` branch:

```ts
export function streamTrailer(opts: { endedOnError: boolean }): string {
  return opts.endedOnError ? '' : 'data: [DONE]\n\n';
}
```

In the streaming writer: declare `let endedOnError = false;` before the loop; in the
`if (!chunk.ok)` branch set `endedOnError = true;` (keep the existing error chunk +
`break`). Replace the unconditional `res.write('data: [DONE]\n\n');` (smart-server.ts:3613)
with:

```ts
if (!endedOnError) {
  // usage chunk (existing block) stays gated on !endedOnError too
  const trailer = streamTrailer({ endedOnError });
  if (trailer) res.write(trailer);
}
res.end();
```

Also gate the preceding usage chunk (`...usage: lastUsage...` ~3610) on `!endedOnError`
so a failed stream emits neither a usage frame nor `[DONE]` — only the `[Error]` chunk
then `end()`.

- [ ] **Step 4: Add a REAL streaming integration test (review round 5, P2#4)**

The pure-helper test does not prove the writer sets `endedOnError` on `!chunk.ok` and
skips the usage/`[DONE]` frames. Add an integration test that drives the actual
streaming response path with a fake stream that yields one `{ ok: false, error }`
chunk and asserts the written SSE bytes contain the `[Error]` chunk but **no**
`data: [DONE]` and **no** usage frame. If the suite already streams through a handler
harness (search `smart-agent/__tests__` for an SSE/streaming test), add the case
there; otherwise capture `res.write` into a buffer with a stub `res` and call the
streaming writer with an injected async-iterable `stream` that yields
`{ ok: false, error: new McpError('Not connected','MCP_NOT_CONNECTED') }`:

```ts
test('streaming MCP failure: [Error] chunk present, no [DONE], no usage frame', async () => {
  const out: string[] = [];
  const res = { write: (s: string) => { out.push(s); return true; }, end: () => {} };
  async function* stream() {
    yield { ok: false as const, error: new McpError('Not connected', 'MCP_NOT_CONNECTED') };
  }
  // Call the extracted streaming-writer function with (res, stream(), …); see the
  // writer's signature in smart-server.ts. Assert:
  const joined = out.join('');
  assert.match(joined, /\[Error\]/);
  assert.doesNotMatch(joined, /\[DONE\]/);
  assert.doesNotMatch(joined, /"usage"/);
});
```

> If the streaming writer is currently an inline block (not a callable function),
> extract it into a named method/function as part of Task 10b so this test can drive
> it directly — that extraction is itself the testability fix the review asks for.

- [ ] **Step 5: Run the tests + verify**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/streaming-failloud.test.ts`
Expected: PASS (helper + integration). Then `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/streaming-failloud.test.ts
git commit -m "feat(server): in-flight streaming failure emits no [DONE]/usage after the error chunk"
```

---

### Task 11: `/health` reflects MCP readiness (MCP-down → 503)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`/health` handler ~3103–3112)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/health-mcp-readiness.test.ts`

The `/health` handler returns 503 only when `status.status === 'unhealthy'` (LLM down). Add: also 503 when `!this.isReady()` (MCP target down). Keep the body shape; set `status: 'unhealthy'` (or add `ready: false`) when MCP-down.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/health-mcp-readiness.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Pure helper extracted from the /health handler: given (healthStatus, ready)
// decide the HTTP code. MCP-down (ready=false) must be 503 even if LLM is fine.
import { healthHttpCode } from '../smart-server.js';

test('LLM ok but MCP not ready → 503', () => {
  assert.equal(healthHttpCode('degraded', false), 503);
});
test('all ok and ready → 200', () => {
  assert.equal(healthHttpCode('healthy', true), 200);
});
test('LLM unhealthy → 503 regardless of ready', () => {
  assert.equal(healthHttpCode('unhealthy', true), 503);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/health-mcp-readiness.test.ts`
Expected: FAIL — `healthHttpCode` not exported.

- [ ] **Step 3: Implement**

Add the helper and use it in the `/health` handler:

```ts
export function healthHttpCode(
  status: 'healthy' | 'degraded' | 'unhealthy',
  ready: boolean,
): number {
  if (status === 'unhealthy') return 503;
  return ready ? 200 : 503;
}
```

In the handler (replace the `httpCode` line at ~3108):

```ts
const status = await healthChecker.check();
const httpCode = healthHttpCode(status.status, this.isReady());
res.writeHead(httpCode, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ ...status, ready: this.isReady() }));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/health-mcp-readiness.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/health-mcp-readiness.test.ts
git commit -m "feat(server): /health returns 503 when MCP not ready"
```

---

### Task 12: `(no response)` no longer masks an MCP failure

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (~3630–3633)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/no-response-failloud.test.ts`

After Tasks 4–6, an MCP-unavailable run resolves `result.ok === false` → the existing `Error: ${result.error.message}` branch (3633) already carries it (no `(no response)`). This task adds a regression guard that a failed run never renders `(no response)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/no-response-failloud.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Pure helper extracted from the response builder: map a process() Result to final
// content. A failed result must NEVER be '(no response)'.
import { finalContentFor } from '../smart-server.js';

test('failed result renders an Error, not (no response)', () => {
  const c = finalContentFor({ ok: false, error: { message: 'Not connected' } } as never);
  assert.match(c, /^Error: /);
  assert.doesNotMatch(c, /no response/);
});

test('ok empty turn with no toolCalls is (no response)', () => {
  const c = finalContentFor({ ok: true, value: { content: '', toolCalls: undefined } } as never);
  assert.equal(c, '(no response)');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/no-response-failloud.test.ts`
Expected: FAIL — `finalContentFor` not exported.

- [ ] **Step 3: Implement**

Extract the inline expression (smart-server.ts:3630–3633) into an exported pure helper and call it from both the streaming and non-streaming response builders:

```ts
export function finalContentFor(
  result:
    | { ok: true; value: { content?: string; toolCalls?: unknown } }
    | { ok: false; error: { message: string } },
): string {
  if (!result.ok) return `Error: ${result.error.message}`;
  return result.value.content || (result.value.toolCalls ? '' : '(no response)');
}
```

Replace the inline `const finalContent = result.ok ? … : …` with `const finalContent = finalContentFor(result);`. (Behaviour is identical for the existing cases; the helper makes the contract testable and prevents a future refactor from reintroducing `(no response)` on failure.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/no-response-failloud.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/no-response-failloud.test.ts
git commit -m "feat(server): failed MCP run surfaces an error, never (no response)"
```

---

## Final verification (after all tasks)

- [ ] `npm run build` green.
- [ ] `npm run lint:check` clean on changed files.
- [ ] `npm run -w @mcp-abap-adt/llm-agent test`, `-w @mcp-abap-adt/llm-agent-mcp test`, `-w @mcp-abap-adt/llm-agent-libs test`, `-w @mcp-abap-adt/llm-agent-server-libs test` all green.
- [ ] Live smoke (local MCP :7777): start server with MCP **down** → `/health` 503, a chat request → 503; bring MCP **up** → within one probe interval `/health` 200, chat request grounded; kill MCP mid-session → request fails loud (non-200 / `Error:`), `/health` 503; restore → recovers.
- [ ] Update `docs/superpowers/specs/2026-06-25-mcp-readiness-failloud-design.md` status to `implemented` and DELETE both spec + this plan per the repo convention (history lives in git).

---

## Self-review (spec coverage)

- §3.1 readiness target registry → Tasks 7, 9.
- §3.2 request gate + streaming split → Task 10 (pre-dispatch 503, incl. route integration test); in-flight streaming → **Task 10b** (no `[DONE]` after error chunk).
- §3.3 all execution surfaces + classification → Tasks 1, 2 (primitive + shared `error-mapping.ts`, returned-error path), 4 (agent), 5 (tool-loop via shared `escalateIfUnavailable` + real handler test), 6 (bridge).
- §3.4 background probe (ping, lazy reconnect, no cached listTools) → Task 8.
- §3.5 session-preserving reconnect + **client THROWS** on retry exhaustion → Task 3.
- §3.6 execution source-of-truth (callMcp reads registry; toolsRag refresh on recovery; worker self-heal scope) → **Task 9b**.
- §4 consumer contract → Tasks 10 (503), 10b (streaming), 11 (/health), 12 (no (no response)).
- Open §6 (multi-MCP policy, intervals, de-dup) → config knobs in Tasks 8/9; `allHealthy()` encodes "any down ⇒ not ready".

### Round-4 review resolutions
- **P1 returned-error trap** → Task 2 (adapter escalates returned availability error) + Task 3 (client throws, not returns).
- **P1 execution recovery** → Task 9b (callMcp reads `registry.liveClients()`; toolsRag re-vectorized on DOWN→UP).
- **P1 streaming [DONE]** → Task 10b (code + test).
- **P1/P2 worker MCP** → Task 9b scope: readiness includes worker targets; worker EXECUTION self-heals via Task 3 (no cross-owner client swap).
- **P2 gate route test** → Task 10 Step 4 (real route integration test, stream:true → 503, agent not called).
- **P2 Task 5 stub** → Task 5 rewritten: shared `escalateIfUnavailable` helper the handler USES + real handler regression test.

### Round-5 review resolutions
- **P1 worker cold-start** → §3.6 + **Task 9c**: the server HOISTS worker `subCfg.mcp` (connects via the registry, injects into the worker via the 2122 seam, invalidates the worker cache on recovery). No more "self-heal" hand-wave; a down worker target is a DOWN slot → NOT_READY → recovers by rebuild.
- **P1 optional healthCheck** → Task 8 monitor: a live client without `healthCheck` is ASSUMED healthy (never marked down on a missing probe); new test covers it. (`healthCheck`-required contract left as a §6 follow-up.)
- **P2 registry scope arg** → all Task 7/8/9b snippets + tests now pass `scope` ('global'|'worker'); `addTarget`/`addLiveClient` signatures updated.
- **P2 streaming integration** → Task 10b Step 4: a real streaming-writer test (fake stream yields `ok:false`) asserting `[Error]` present, no `[DONE]`, no usage frame — plus extracting the writer into a callable for testability.
