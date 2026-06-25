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
| `packages/llm-agent-mcp/src/adapter.ts` / `client.ts` | tag transport failures with availability codes; session-preserving reconnect | 1–2 |
| `packages/llm-agent-libs/src/agent.ts` | core tool loop escalates availability errors | 3 |
| `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` | pipeline-handler tool loop escalates availability errors | 3 |
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-mcp && npx tsx --test src/__tests__/adapter-unavailable-codes.test.ts`
Expected: FAIL — errors come back as plain `MCP_ERROR`, `isMcpUnavailable` false.

- [ ] **Step 3: Implement the mapping**

Add a helper near the top of `packages/llm-agent-mcp/src/adapter.ts`:

```ts
import { McpError } from '@mcp-abap-adt/llm-agent';

/** Map a thrown transport error to an McpError with an availability code. */
function toMcpError(err: unknown): McpError {
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
  return new McpError(msg, code);
}
```

Replace the three `catch` fallbacks (`callTool`, `listTools`, `healthCheck`) that today do `new McpError(String(err))` with `toMcpError(err)`. Keep the existing `if (err instanceof McpError) return ...` short-circuits (now subsumed by `toMcpError`, but harmless).

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
session and try ONE fresh connect before giving up:

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
      /* fall through to error result */
    }
  }
  const retryErrorMessage =
    retryError instanceof Error ? retryError.message : String(retryError);
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    result: null,
    error: retryErrorMessage || 'Tool execution failed after reconnect',
  };
}
```

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

Apply the SAME change as Task 4 at the `const text = !res.ok ? res.error.message : …` site (tool-loop.ts:885). Add the `if (!res.ok && isMcpUnavailable(res.error)) throw res.error;` guard immediately before it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/__tests__/tool-loop-mcp-unavailable.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError, isMcpUnavailable } from '@mcp-abap-adt/llm-agent';

// Contract-level guard: the tool-loop handler must not stringify an availability
// error into tool text. This test asserts the shared decision the handler uses.
test('tool-loop classifies availability error as escalate, not text', () => {
  const err = new McpError('MCP error -32001: Request timed out', 'MCP_TIMEOUT');
  assert.equal(isMcpUnavailable(err), true);
});
```

> Note: a full pipeline-level test requires wiring the DefaultPipeline tool-loop with a failing MCP client. If the package already has a tool-loop integration test harness (search `pipeline/handlers/__tests__`), add an availability-escalation case there mirroring Task 4 instead of this contract stub, and delete the stub.

- [ ] **Step 2: Run the test to verify it fails / Step 3: implement / Step 4: verify**

Run: `cd packages/llm-agent-libs && npx tsx --test src/__tests__/tool-loop-mcp-unavailable.test.ts`
Implement the guard at tool-loop.ts:885 as described. Verify the test passes and `npm run -w @mcp-abap-adt/llm-agent-libs test` stays green.

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
  r.addTarget('global-0', { transport: 'auto', url: 'http://down:1/mcp' } as never);
  assert.equal(r.allHealthy(), false);
});

test('marking the only slot healthy makes the registry healthy', () => {
  const r = new McpReadinessRegistry();
  r.addTarget('global-0', { transport: 'auto', url: 'http://x/mcp' } as never);
  r.markHealthy('global-0', { listTools: async () => ({ ok: true, value: [] }) } as never);
  assert.equal(r.allHealthy(), true);
});

test('a live DI client registers healthy', () => {
  const r = new McpReadinessRegistry();
  r.addLiveClient('worker-a', { listTools: async () => ({ ok: true, value: [] }) } as never);
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

export interface ReadinessSlot {
  id: string;
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
  addTarget(id: string, config: SmartServerMcpConfig): void {
    if (this.slots.has(id)) return;
    this.slots.set(id, { id, config, healthy: false, lastAttempt: 0 });
  }

  /** Register an already-live DI client (no lazy connect needed). */
  addLiveClient(id: string, client: IMcpClient): void {
    this.slots.set(id, { id, client, healthy: true, lastAttempt: 0 });
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
  reg.addTarget('g0', { transport: 'auto', url: 'http://x/mcp' } as never);
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
  reg.addLiveClient('w', flaky as never);
  const monitor = new McpReadinessMonitor(reg, { connect: async () => { throw new Error('still down'); }, cooldownMs: 0 });
  assert.equal(monitor.isReady(), true);
  await monitor.tick();
  assert.equal(monitor.isReady(), false);
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
        const hc = await slot.client.healthCheck?.();
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

This is the pre-dispatch path for BOTH streaming and non-streaming (it runs before the SSE stream is opened — review P2b's pre-dispatch case). The in-flight streaming case (failure after headers) is already handled by the SSE error event + `res.end()` without `[DONE]` (Task 4/6 cause the failure; the streaming writer must emit an error event on a thrown McpError rather than a clean stop — verify the streaming catch path).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-server-libs && npx tsx --test src/smart-agent/__tests__/readiness-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/readiness-gate.test.ts
git commit -m "feat(server): pre-dispatch readiness gate (503 when MCP not ready)"
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
- §3.2 request gate + streaming split → Task 10 (pre-dispatch); in-flight via Tasks 4/6 + streaming catch (Task 10 note).
- §3.3 all execution surfaces + classification → Tasks 1, 2 (primitive), 4 (agent), 5 (tool-loop), 6 (bridge).
- §3.4 background probe (ping, lazy reconnect, no cached listTools) → Task 8.
- §3.5 session-preserving reconnect → Task 3.
- §4 consumer contract → Tasks 10 (503), 11 (/health), 12 (no (no response)).
- Open §6 (multi-MCP policy, intervals, de-dup) → carried as config knobs in Tasks 8/9; `allHealthy()` already encodes "any down ⇒ not ready".
