# Per-session MCP client isolation (#213) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each session its own MCP client(s) for tool execution so concurrent tool-use requests no longer cross responses; keep tool selection on the shared global catalog. Per-session is the default; `agent.mcpSharedClient: true` opts back into the single shared client.

**Architecture:** A new sync helper builds a fresh set of **un-connected** `MCPClientWrapper`→`McpClientAdapter` wrappers from the resolved `mcp:` config and returns `{ clients, close }`. `buildSessionLifecycle`'s `mcpClientFactory(identity)` returns a fresh set per session (default) or the shared global (opt-out / ready-client path), tracking each session's `close` and invoking it in `onDispose`. Wrappers lazily connect on first `callTool`, so each concurrent request owns its connection. The builder's provided-clients path already skips connect + vectorization, so the global tool catalog is reused.

**Tech Stack:** TypeScript (ESM, `.js` imports, strict), Node ≥ 22, Biome, `node:test` + `tsx`.

**Spec:** `docs/superpowers/specs/2026-07-16-per-session-mcp-client-isolation-design.md`

## Global Constraints

- ESM only; `.js` import extensions.
- **Per-session isolation applies ONLY to the YAML `mcp:`-config path.** ALL ready-client sources (`BuildAgentDeps.mcpClients`, `cfg.mcpClients`, plugin `mcpClients` — resolved at `smart-server.ts` ~1121) are consumer/plugin-owned and stay **shared**; the server never clones/disposes them.
- The helper returns `{ clients: IMcpClient[]; close: () => Promise<void> }`. **`IMcpClient`/`McpClientAdapter` expose NO `disconnect`/`dispose`** — only the internal `MCPClientWrapper` does; the helper captures the wrappers and `close()` disconnects them. Never call `disconnect`/`dispose` on an `IMcpClient`.
- Helper is **sync** and does **NOT** call `wrapper.connect()` (lazy connect on first `callTool`); it does **NOT** vectorize.
- Opt-out: `agent.mcpSharedClient: true` → shared global (exact current behavior).
- Backward-compat: `mcpSharedClient: true` + all ready-client paths + non-MCP + MCP-less are byte-behavior-identical to today.
- Whole-workspace `npm run build` + `npm run lint:check` (exit 0) after every task; commit only that task's files. Run one test: `node --import tsx/esm --test --test-reporter=spec <path>`.

**Key existing types/APIs (verbatim):**
- `SmartServerMcpConfig` — `{ type: 'http'|'stdio'; url?; command?; args?; headers?; timeout?; toolTimeouts? }` (the `mcp:` entry shape).
- `MCPClientWrapper` (from `@mcp-abap-adt/llm-agent-mcp`) — constructed `new MCPClientWrapper({ transport: 'stdio'|'auto', ... })`; has `connect()` and `disconnect()`; lazily connects inside `callTool`/`listTools` (`if (!this.client) await this.connect()`).
- `McpClientAdapter` (from `@mcp-abap-adt/llm-agent-mcp`) — `new McpClientAdapter(wrapper)` → `IMcpClient`.
- `IMcpClient` (from `@mcp-abap-adt/llm-agent`) — `listTools`/`callTool`/`healthCheck?` only.
- `connectMcpClientsFromConfig(mcpCfg)` in `smart-server.ts:558` — the eager reference to mirror (it `await wrapper.connect()`s; our helper does not).
- `SessionGraphIdentity` — `{ readonly sessionId: string; ... }`.
- `SessionGraphFactoryOptions.mcpClientFactory: (identity: SessionGraphIdentity) => IMcpClient[]` (sync).
- `SessionLifecycleOptions` (in `session-lifecycle/index.ts`) — `{ idleTtlMs, maxSessions, cookieName, mcpClients, toolsRag, ragRegistry, buildAgent, logger?, onDispose? }`.
- `buildSessionLifecycle` call site: `smart-server.ts:1317`; existing `onDispose: async (sessionId) => { const close = this._sessionCloseFns.get(sessionId); ... await close(); }`.
- `resolveAgentSection` in `resolve-config-sections.ts` (conditional-spread toggles ~line 196, e.g. `ragTranslateEnabled`); `SmartServerAgentConfig` interface at `smart-server.ts:180`.

---

## File Structure

- Create `packages/llm-agent-server-libs/src/smart-agent/mcp/build-session-mcp-clients.ts` — `buildSessionMcpClients`.
- Test `packages/llm-agent-server-libs/src/smart-agent/mcp/__tests__/build-session-mcp-clients.test.ts`.
- Modify `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — `SmartServerAgentConfig.mcpSharedClient?`; wire the per-session builder + flag at the `buildSessionLifecycle` call site (YAML path only).
- Modify `packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts` — `resolveAgentSection` reads `agent.mcpSharedClient`.
- Modify `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts` — `SessionLifecycleOptions` gains `buildPerSessionMcpClients?` + `mcpSharedClient?`; factory + `closeBySession` + composed `onDispose`.
- Test `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/__tests__/per-session-mcp.test.ts`.
- Test `packages/llm-agent-server-libs/src/smart-agent/__tests__/issue-213-concurrent-tool-use.test.ts` (regression).

---

### Task 1: `buildSessionMcpClients` helper

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/mcp/build-session-mcp-clients.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/mcp/__tests__/build-session-mcp-clients.test.ts`

**Interfaces:**
- Produces: `buildSessionMcpClients(mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null): { clients: IMcpClient[]; close: () => Promise<void> }` — fresh un-connected wrappers (mirrors `connectMcpClientsFromConfig` minus `connect()`); `close()` disconnects the wrappers it built.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSessionMcpClients } from '../build-session-mcp-clients.js';

const httpCfg = { type: 'http' as const, url: 'http://localhost:9999/mcp/stream/http' };

test('returns IMcpClient[] with a close fn; no connect at build (lazy)', () => {
  const a = buildSessionMcpClients(httpCfg);
  assert.equal(a.clients.length, 1);
  assert.equal(typeof a.clients[0].listTools, 'function');
  assert.equal(typeof a.clients[0].callTool, 'function');
  assert.equal(typeof a.close, 'function');
});

test('each call returns DISTINCT client instances (per-session isolation)', () => {
  const a = buildSessionMcpClients(httpCfg);
  const b = buildSessionMcpClients(httpCfg);
  assert.notEqual(a.clients[0], b.clients[0]);
});

test('undefined/empty config → empty clients and a no-op close', async () => {
  const a = buildSessionMcpClients(undefined);
  assert.deepEqual(a.clients, []);
  await a.close(); // must not throw
});

test('close() disconnects each built wrapper', async () => {
  // array form → two servers
  const r = buildSessionMcpClients([httpCfg, { type: 'stdio' as const, command: 'echo' }]);
  assert.equal(r.clients.length, 2);
  await r.close(); // idempotent on un-connected wrappers — must not throw
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/mcp/__tests__/build-session-mcp-clients.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter, MCPClientWrapper } from '@mcp-abap-adt/llm-agent-mcp';
import type { SmartServerMcpConfig } from '../smart-server.js';

/**
 * Build a FRESH, UN-CONNECTED set of MCP client wrappers from the resolved
 * `mcp:` config — one call per session so concurrent requests never share an
 * MCP connection (fixes #213). Mirrors `connectMcpClientsFromConfig` but does
 * NOT call `wrapper.connect()` (each wrapper lazily connects on its first
 * `callTool`/`listTools`) and does NOT vectorize (the caller reuses the shared
 * global tool catalog via the builder's provided-clients path).
 *
 * Returns `{ clients, close }`: `close()` disconnects the wrappers this helper
 * created — the only place that owns them. `IMcpClient`/`McpClientAdapter` do
 * not expose `disconnect`; the wrapper does.
 */
export function buildSessionMcpClients(
  mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
): { clients: IMcpClient[]; close: () => Promise<void> } {
  if (!mcpCfg) return { clients: [], close: async () => {} };
  const list = Array.isArray(mcpCfg) ? mcpCfg : [mcpCfg];
  const wrappers: MCPClientWrapper[] = [];
  const clients: IMcpClient[] = [];
  for (const cfg of list) {
    const wrapper =
      cfg.type === 'stdio'
        ? new MCPClientWrapper({
            transport: 'stdio',
            command: cfg.command,
            args: cfg.args ?? [],
            ...(cfg.timeout !== undefined ? { timeout: cfg.timeout } : {}),
            ...(cfg.toolTimeouts ? { toolTimeouts: cfg.toolTimeouts } : {}),
          })
        : new MCPClientWrapper({
            transport: 'auto',
            url: cfg.url,
            headers: cfg.headers,
            ...(cfg.timeout !== undefined ? { timeout: cfg.timeout } : {}),
            ...(cfg.toolTimeouts ? { toolTimeouts: cfg.toolTimeouts } : {}),
          });
    wrappers.push(wrapper);
    clients.push(new McpClientAdapter(wrapper));
  }
  return {
    clients,
    close: async () => {
      for (const w of wrappers) {
        try {
          await w.disconnect();
        } catch {
          // disconnecting an un-connected / already-closed wrapper is a no-op
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/mcp/__tests__/build-session-mcp-clients.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/mcp/build-session-mcp-clients.ts packages/llm-agent-server-libs/src/smart-agent/mcp/__tests__/build-session-mcp-clients.test.ts
git commit -m "feat(server-libs): buildSessionMcpClients — fresh un-connected per-session MCP wrappers ({clients, close})"
```

> Note: if `MCPClientWrapper.disconnect()` is not exported/public or has a different name, grep `packages/llm-agent-mcp/src/client.ts` for the disconnect method and use the real name; the test's `close()`-must-not-throw assertion guards correctness.

---

### Task 2: `agent.mcpSharedClient` config

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (add `mcpSharedClient?: boolean` to `SmartServerAgentConfig`, ~line 180)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts` (`resolveAgentSection` — conditional-spread, mirror `ragTranslateEnabled` ~line 196)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/agent-mcp-shared-client-config.test.ts`

**Interfaces:**
- Produces: `SmartServerAgentConfig.mcpSharedClient?: boolean`; `resolveAgentSection` sets it from `agent.mcpSharedClient` (absent → field omitted → treated as `false`/per-session).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAgentSection } from '../resolve-config-sections.js';

test('agent.mcpSharedClient absent → not set (per-session default)', () => {
  const a = resolveAgentSection({ agent: {} } as never, {});
  assert.equal(a.mcpSharedClient, undefined);
});

test('agent.mcpSharedClient: true → true', () => {
  const a = resolveAgentSection({ agent: { mcpSharedClient: true } } as never, {});
  assert.equal(a.mcpSharedClient, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/__tests__/agent-mcp-shared-client-config.test.ts`
Expected: FAIL — `mcpSharedClient` always undefined (not read).

- [ ] **Step 3: Implement**

In `smart-server.ts` `SmartServerAgentConfig` (~line 180) add:
```ts
  /** Opt out of per-session MCP client isolation (default: per-session).
   *  `true` → reuse one shared MCP client across all sessions (pre-#213 behavior). */
  mcpSharedClient?: boolean;
```

In `resolve-config-sections.ts` `resolveAgentSection`, add a conditional-spread mirroring `ragTranslateEnabled`:
```ts
    ...(get(yaml, 'agent', 'mcpSharedClient') !== undefined
      ? { mcpSharedClient: Boolean(get(yaml, 'agent', 'mcpSharedClient')) }
      : {}),
```

- [ ] **Step 4: Run test → PASS (2/2).** Build + lint.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/agent-mcp-shared-client-config.test.ts
git commit -m "feat(config): agent.mcpSharedClient opt-out (default per-session MCP isolation)"
```

---

### Task 3: `buildSessionLifecycle` per-session factory + disposal

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/__tests__/per-session-mcp.test.ts`

**Interfaces:**
- Consumes: `buildSessionMcpClients` result shape (Task 1) — the caller passes a `buildPerSessionMcpClients` closure.
- Produces: `SessionLifecycleOptions` gains
  - `mcpSharedClient?: boolean`
  - `buildPerSessionMcpClients?: () => { clients: IMcpClient[]; close: () => Promise<void> }`
  The factory returns per-session clients when `buildPerSessionMcpClients` is present AND `!mcpSharedClient`; otherwise `opts.mcpClients` (shared). Per-session `close` fns are tracked by `sessionId` and invoked in the composed `onDispose`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSessionLifecycle } from '../index.js';

// Minimal stubs
const fakeClient = () => ({ async listTools() { return { ok: true, value: [] }; }, async callTool() { return { ok: true, value: { content: '' } }; } });
const baseOpts = {
  idleTtlMs: 1000, maxSessions: 10, cookieName: 'sid',
  mcpClients: [fakeClient()] as never,
  toolsRag: undefined, ragRegistry: {} as never,
  buildAgent: async () => undefined,
};

test('default: mcpClientFactory returns DISTINCT clients per identity + tracks close', async () => {
  const closed: string[] = [];
  const lc = buildSessionLifecycle({
    ...baseOpts,
    buildPerSessionMcpClients: () => {
      const c = [fakeClient()] as never;
      return { clients: c, close: async () => { closed.push('x'); } };
    },
    onDispose: async () => {},
  });
  // reach the internal factory via the registry factory (exposed through buildSessionLifecycle wiring).
  // Simplest: assert two acquires for different sessionIds get different mcp clients — see harness note.
});

test('mcpSharedClient: true → factory returns the SAME shared clients', async () => {
  // buildPerSessionMcpClients present but mcpSharedClient=true → shared
});

test('onDispose invokes the session-scoped MCP close, then delegates to opts.onDispose', async () => {
  // assert close() ran for the disposed sessionId
});
```

> **Harness note:** the factory is internal to `buildSessionLifecycle`. Mirror the existing `session-lifecycle` test (grep `session-lifecycle/__tests__` — reuse its pattern for driving `acquire`/`release`/`disposeAll`). Assert: (a) two `acquire`d sessions get distinct MCP client instances (spy the `buildPerSessionMcpClients` call count == number of sessions), (b) `mcpSharedClient: true` → `buildPerSessionMcpClients` never called and both sessions share `opts.mcpClients`, (c) disposing a session invokes its tracked `close` then the passed `onDispose`.

- [ ] **Step 2: Run test → FAIL** (options not supported; factory returns `opts.mcpClients` always).

- [ ] **Step 3: Implement** — in `buildSessionLifecycle`:

```ts
  const closeBySession = new Map<string, () => Promise<void>>();
  const usePerSession = !!opts.buildPerSessionMcpClients && !opts.mcpSharedClient;

  const factory = new SessionGraphFactory({
    mcpClientFactory: (identity) => {
      if (!usePerSession) return opts.mcpClients;
      const built = opts.buildPerSessionMcpClients!();
      closeBySession.set(identity.sessionId, built.close);
      return built.clients;
    },
    toolsRag: opts.toolsRag,
    ragRegistry: opts.ragRegistry,
    buildAgent: opts.buildAgent,
    logger: opts.logger,
    // Compose: close the session's per-session MCP clients, then the pipeline teardown.
    onDispose: async (sessionId) => {
      const close = closeBySession.get(sessionId);
      if (close) {
        closeBySession.delete(sessionId);
        await close();
      }
      await opts.onDispose?.(sessionId);
    },
  });
```

Add to `SessionLifecycleOptions`:
```ts
  /** When present AND `!mcpSharedClient`, called once per session to build fresh
   *  per-session MCP clients ({clients, close}); else `mcpClients` is shared. */
  buildPerSessionMcpClients?: () => { clients: IMcpClient[]; close: () => Promise<void> };
  /** Opt out of per-session isolation → share `mcpClients` across sessions. */
  mcpSharedClient?: boolean;
```

- [ ] **Step 4: Run test → PASS.** Also run the existing session-lifecycle suite (no regression). Build + lint.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/__tests__/per-session-mcp.test.ts
git commit -m "feat(server-libs): per-session MCP client factory + onDispose close in buildSessionLifecycle"
```

---

### Task 4: Wire the YAML path at the `buildSessionLifecycle` call site

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (the `buildSessionLifecycle({ ... })` call ~line 1317, and the branch that determines YAML-vs-ready-client ~line 1121)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/per-session-mcp-wiring.test.ts`

**Interfaces:**
- Consumes: `buildSessionMcpClients` (Task 1); `cfg.agent.mcpSharedClient` (Task 2); `buildSessionLifecycle` options (Task 3).
- Produces: the call site passes `mcpSharedClient: this.cfg.agent?.mcpSharedClient` and `buildPerSessionMcpClients` **only on the YAML `mcp:` path** (undefined for ready-client paths → shared).

- [ ] **Step 1: Write the failing test** — mirror the `step-run-execution-control-di.test.ts` `callBuildServerCtx`/harness OR a focused SmartServer construction that reaches the lifecycle wiring. Assert: with a YAML `mcp:` block and no ready-client injection, two distinct sessions get distinct MCP client instances (spy `buildSessionMcpClients`); with `agent.mcpSharedClient: true`, they share; with an injected `BuildAgentDeps.mcpClients`, they share (ready-client path, per-session builder not passed).

> If a full SmartServer harness is too heavy, assert at the wiring boundary: extract the "should this path be per-session" decision into a tiny pure helper (e.g. `shouldIsolateMcpPerSession({ mcpFromYaml, mcpSharedClient, hasReadyClients })`) and unit-test that, plus assert the call site passes `buildPerSessionMcpClients` iff it returns true. Keep the decision in one testable place.

- [ ] **Step 2: Run test → FAIL** (call site always shares).

- [ ] **Step 3: Implement** — at the `buildSessionLifecycle` call (~1317), add:

```ts
      // Per-session MCP isolation (#213): only for the YAML `mcp:` path (the one
      // the server itself connects). Ready-client sources (deps/cfg/plugin) are
      // consumer/plugin-owned and stay shared. `agent.mcpSharedClient: true` opts out.
      mcpSharedClient: this.cfg.agent?.mcpSharedClient,
      buildPerSessionMcpClients:
        mcpFromYaml && !this.cfg.agent?.mcpSharedClient
          ? () => buildSessionMcpClients(this.cfg.mcp)
          : undefined,
```

where `mcpFromYaml` is a boolean already known at the branch (~1121): `true` when `globalMcpClients` came from the YAML `mcp:` connect, `false` when `diOrPluginMcpClients` (ready-client) was used. If that boolean is not already in scope, derive it there: `const mcpFromYaml = !diOrPluginMcpClients && !!this.cfg.mcp;` and thread it to the call site. Import `buildSessionMcpClients` from `./mcp/build-session-mcp-clients.js`.

- [ ] **Step 4: Run test → PASS.** Build + lint. Run the existing smart-server / session suites (no regression).

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/per-session-mcp-wiring.test.ts
git commit -m "feat(server): wire per-session MCP isolation on the YAML mcp path (ready-clients stay shared)"
```

---

### Task 5: #213 regression test (concurrent tool-use isolation)

**Files:**
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/issue-213-concurrent-tool-use.test.ts`

**Interfaces:**
- Consumes: the full per-session wiring (Tasks 1-4).

- [ ] **Step 1: Write the test** (this is a pure regression assertion — no new prod code)

Drive two concurrent tool-use flows through distinct sessions with **fake** MCP clients that record which session called them and return session-specific content. The cleanest level is the factory + a fake `buildPerSessionMcpClients` that returns per-call distinct fakes; assert:
- Two concurrent `acquire(sessionA)` / `acquire(sessionB)` (distinct ids) receive **distinct** MCP client instances.
- A fake client whose `callTool` echoes an instance-unique token → each session's tool call returns only its own token (no crossing) even when the two calls are awaited concurrently (`await Promise.all([...])`).
- On the shared path (`mcpSharedClient: true`), both sessions get the **same** instance (documents the opt-out behavior — this is the pre-fix wiring).

Prove the test discriminates: temporarily force the factory to always return `opts.mcpClients` (shared) → the "distinct instances / no crossing" assertions FAIL; restore → PASS.

- [ ] **Step 2: Run → PASS; discrimination proven.** Build + lint.

- [ ] **Step 3: Commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent-server-libs/src/smart-agent/__tests__/issue-213-concurrent-tool-use.test.ts
git commit -m "test(server-libs): #213 regression — per-session MCP clients isolate concurrent tool-use"
```

---

### Task 6: Live acceptance (verification-only, no commit)

**Files:** none.

- [ ] **Step 1:** `npm run build`. Ensure a real/trial MCP is up on `:9001` (`mcp-abap-adt --transport=streamable-http --host=127.0.0.1 --port=9001 --path=/mcp/stream/http --env=trial --system-type=cloud`). Start the controller server against it (`.run/eval/controller9001.yaml`, no `agent.mcpSharedClient`).
- [ ] **Step 2:** Reproduce the consumer's exact repro — fire **2 concurrent** `POST /v1/chat/completions` (non-stream), each a prompt triggering one MCP tool call (read a table). Then repeat with 3 concurrent.
- [ ] **Step 3:** Assert BOTH/ALL return real, distinct answers — **0** `(no response)` / zero-token, no ballooned "winner". Contrast: set `agent.mcpSharedClient: true` and confirm the old crossing can recur (documents the opt-out trade-off).
- [ ] **Step 4:** Record before/after in the PR description (shared → crossing; per-session → clean).

---

## Notes

- Do NOT touch `packages/llm-agent-libs/src/session/session-graph-factory.ts` — the `mcpClientFactory(identity)` seam already exists; disposal is composed in `buildSessionLifecycle`'s `onDispose` (server-libs).
- Do NOT change `buildMcpBridge`, `IMcpClient`, `McpClientAdapter`, or the tool-selection path.
- The global startup MCP connection stays (catalog vectorization + readiness + embedded path); per-session connections are additional, bounded by `maxSessions` + idle-TTL eviction.
- Every task: `npm run build` (whole workspace) + `npm run lint:check` (exit 0); `npm run format` if Biome reports fixable issues; commit only that task's files.
