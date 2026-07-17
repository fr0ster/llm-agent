# Issue #213 Concurrency Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-session MCP isolation decision and the controller's per-request run identity observable, so a single run on the reporter's deployment discriminates the two surviving hypotheses for issue #213.

**Architecture:** Observability only — ZERO behavior change. A pure `describeMcpIsolation()` composes the two existing gates and is CONSUMED by the wiring (so the log cannot drift from reality); its payload goes to the existing `cfg.log` channel as an always-on `mcp_isolation` event, plus the existing `config_warning` when a silent shared fallback engages. The controller adds two `DEBUG_CONTROLLER`-gated `dlog` lines around run classification.

**Tech Stack:** TypeScript (ESM, strict), node:test + tsx, Biome. Spec: `docs/superpowers/specs/2026-07-17-issue-213-concurrency-diagnostics-design.md`.

## Global Constraints

- **Branch:** `diag/issue-213-mcp-isolation-observability`. Base is `main` at `6750187b`. Verify with `git branch --show-current` before committing.
- **ESM only** — all relative imports use `.js` extensions, even from `.ts` sources.
- **English only** — code, comments, commit messages.
- **Conventional Commits** — this work is `feat(server):` (adds diagnostics) / `test:`.
- **TypeScript strict; avoid `any`** (Biome warns).
- **Zero behavior change.** The only new runtime effects are log lines. If a step would alter which clients a session gets, STOP — it is out of scope.
- **Out of scope, do NOT touch:** runId-aware bundle keying (breaks intentional stateless resume, `run-scope.ts:151-157`); the `?? ''` empty-terminal commit at `controller-coordinator-handler.ts:1699`; `buildSessionLifecycle`'s third restatement `usePerSession` (`session-lifecycle/index.ts:106-107`); fixing the gate itself.
- **Run before every commit:** `npm run format` then the package test command below. Biome sorts imports — unsorted imports fail lint.
- **Test command (server-libs):** `npm run test -w @mcp-abap-adt/llm-agent-server-libs`
- **Single-file test run:** `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/<path>.test.ts'`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/llm-agent-server-libs/src/smart-agent/mcp/build-session-mcp-clients.ts` (modify, 90 lines) | Already holds both gates (`shouldIsolateMcpPerSession`, `serverOwnsMcpConnection`). Gains the pure `describeMcpIsolation()` that composes them + names the disabling reasons. |
| `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts` (create) | Unit table for `describeMcpIsolation` (every fallback cause) + the white-box integration cases. |
| `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (modify, `_buildInfra`) | Calls `describeMcpIsolation` ONCE; logs it, warns from it, and feeds `buildPerSessionMcpClients` from `isolation.perSession`. |
| `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (modify) | Two `dlog` lines: `classify` (after `classifyRequest`) and `run` (once run identity is settled). |
| `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-diagnostics-log.test.ts` (create) | Asserts both `dlog` lines, incl. that `run=` is never `undefined` on a fresh run. |

---

## Task 1: `describeMcpIsolation` — the pure decision + reasons

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/mcp/build-session-mcp-clients.ts` (append after `serverOwnsMcpConnection`, currently ends line 35)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts` (create)

**Interfaces:**
- Consumes: the two existing exports of that module — `serverOwnsMcpConnection({hasReadyClients, hasMcpConfig, mcpSeamInjected}): boolean` and `shouldIsolateMcpPerSession({mcpFromYaml, mcpSharedClient?}): boolean`.
- Produces: `describeMcpIsolation(o: {hasReadyClients: boolean; hasMcpConfig: boolean; mcpSeamInjected: boolean; mcpSharedClient?: boolean}): McpIsolationReport` and the exported type `McpIsolationReport` (fields listed in Step 3). Task 2 consumes both.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts`:

```ts
/**
 * #213 diagnostics: `describeMcpIsolation` is the SINGLE resolved decision that
 * the wiring consumes AND the `mcp_isolation` event reports, so the log cannot
 * drift from which clients sessions actually get. Table covers every cause of a
 * silent fallback to a shared client.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeMcpIsolation } from '../mcp/build-session-mcp-clients.js';

test('pure YAML mcp: path → per-session isolation ON, no reasons', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: true,
    mcpSeamInjected: false,
  });
  assert.equal(r.event, 'mcp_isolation');
  assert.equal(r.perSession, true);
  assert.equal(r.mcpFromYaml, true);
  assert.equal(r.mcpSharedClient, null);
  assert.deepEqual(r.disabledReasons, []);
});

test('ready clients present → shared, reason names hasReadyClients', () => {
  const r = describeMcpIsolation({
    hasReadyClients: true,
    hasMcpConfig: true,
    mcpSeamInjected: false,
  });
  assert.equal(r.perSession, false);
  assert.deepEqual(r.disabledReasons, ['hasReadyClients']);
});

test('empty-array trap: cfg.mcpClients: [] is PRESENCE → shared', () => {
  // The server gates on `diOrPluginMcpClients !== undefined` (smart-server.ts:1166),
  // so an empty array is a deliberate "disable MCP" signal, NOT a YAML path.
  const r = describeMcpIsolation({
    hasReadyClients: true,
    hasMcpConfig: true,
    mcpSeamInjected: false,
  });
  assert.equal(r.perSession, false);
});

test('injected connectMcp seam → shared, reason names mcpSeamInjected', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: true,
    mcpSeamInjected: true,
  });
  assert.equal(r.perSession, false);
  assert.equal(r.mcpFromYaml, false);
  assert.deepEqual(r.disabledReasons, ['mcpSeamInjected']);
});

test('deliberate opt-out agent.mcpSharedClient: true → shared, reason names it', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: true,
    mcpSeamInjected: false,
    mcpSharedClient: true,
  });
  assert.equal(r.perSession, false);
  assert.equal(r.mcpSharedClient, true);
  assert.deepEqual(r.disabledReasons, ['mcpSharedClient']);
});

test('no mcp: block at all → not per-session, reason noMcpConfig', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: false,
    mcpSeamInjected: false,
  });
  assert.equal(r.perSession, false);
  assert.deepEqual(r.disabledReasons, ['noMcpConfig']);
});

test('multiple causes are all reported, in declared order', () => {
  const r = describeMcpIsolation({
    hasReadyClients: true,
    hasMcpConfig: true,
    mcpSeamInjected: true,
    mcpSharedClient: true,
  });
  assert.equal(r.perSession, false);
  assert.deepEqual(r.disabledReasons, [
    'mcpSharedClient',
    'hasReadyClients',
    'mcpSeamInjected',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts'`

Expected: FAIL — `SyntaxError: The requested module '../mcp/build-session-mcp-clients.js' does not provide an export named 'describeMcpIsolation'`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/llm-agent-server-libs/src/smart-agent/mcp/build-session-mcp-clients.ts`, after `serverOwnsMcpConnection` (line 35) and BEFORE the `buildSessionMcpClients` doc comment:

```ts
/** Why per-session MCP isolation is off. Empty when it is on. */
export type McpIsolationDisabledReason =
  | 'mcpSharedClient'
  | 'hasReadyClients'
  | 'mcpSeamInjected'
  | 'noMcpConfig';

/** The resolved per-session MCP isolation decision + the facts behind it. Shape
 *  of the `mcp_isolation` log event (#213 diagnostics). */
export interface McpIsolationReport {
  event: 'mcp_isolation';
  mcpFromYaml: boolean;
  hasReadyClients: boolean;
  hasMcpConfig: boolean;
  mcpSeamInjected: boolean;
  /** Raw config value; `null` when unset, so it is distinguishable from `false`. */
  mcpSharedClient: boolean | null;
  perSession: boolean;
  disabledReasons: McpIsolationDisabledReason[];
}

/**
 * Resolve — ONCE — whether sessions get their own MCP client, and report the
 * facts behind it (#213).
 *
 * This is the SINGLE source of truth: `smart-server.ts` feeds
 * `buildPerSessionMcpClients` from `perSession` AND logs this object, so the
 * diagnostic can never disagree with the wiring. It COMPOSES the two existing
 * gates rather than restating their logic.
 *
 * `disabledReasons` exists so the `config_warning` message can name WHY isolation
 * is off — a deliberate `agent.mcpSharedClient: true` opt-out must be
 * distinguishable from an accidental fallback.
 */
export function describeMcpIsolation(o: {
  hasReadyClients: boolean;
  hasMcpConfig: boolean;
  mcpSeamInjected: boolean;
  mcpSharedClient?: boolean;
}): McpIsolationReport {
  const mcpFromYaml = serverOwnsMcpConnection({
    hasReadyClients: o.hasReadyClients,
    hasMcpConfig: o.hasMcpConfig,
    mcpSeamInjected: o.mcpSeamInjected,
  });
  const perSession = shouldIsolateMcpPerSession({
    mcpFromYaml,
    mcpSharedClient: o.mcpSharedClient,
  });
  const disabledReasons: McpIsolationDisabledReason[] = [];
  if (!perSession) {
    if (o.mcpSharedClient === true) disabledReasons.push('mcpSharedClient');
    if (o.hasReadyClients) disabledReasons.push('hasReadyClients');
    if (o.mcpSeamInjected) disabledReasons.push('mcpSeamInjected');
    if (!o.hasMcpConfig) disabledReasons.push('noMcpConfig');
  }
  return {
    event: 'mcp_isolation',
    mcpFromYaml,
    hasReadyClients: o.hasReadyClients,
    hasMcpConfig: o.hasMcpConfig,
    mcpSeamInjected: o.mcpSeamInjected,
    mcpSharedClient: o.mcpSharedClient ?? null,
    perSession,
    disabledReasons,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts'`

Expected: PASS — 7 tests, 0 fail.

- [ ] **Step 5: Format, lint, full package tests**

```bash
npm run format
npm run test -w @mcp-abap-adt/llm-agent-server-libs
```
Expected: format clean; all package tests pass (the pre-existing suite must stay green — if a test that has nothing to do with this change fails, do NOT proceed; report it).

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/mcp/build-session-mcp-clients.ts \
        packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts
git commit -m "feat(server): describeMcpIsolation — single resolved per-session MCP decision (#213)"
```

---

## Task 2: Wire it — consume the decision, emit the event, warn with a reason

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — the gate block at `1166-1186` and the lifecycle wiring at `1348-1352`, both inside `_buildInfra` (`845`–`1482`); the `log` local is already in scope from `858`.
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts` (append)

**Interfaces:**
- Consumes: `describeMcpIsolation` + `McpIsolationReport` from Task 1; existing `this.warn(msg)` (`smart-server.ts:1992-1994`, emits `{event: 'config_warning', message}`); existing `buildSessionMcpClients(this.cfg.mcp)` (`mcp/build-session-mcp-clients.ts:48`).
- Produces: nothing new for later tasks — Task 3 is independent.

- [ ] **Step 1: Write the failing test**

Append to `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts`.

The event alone would pass while the wiring below it is broken, so the `perSession: true` case ALSO asserts the consequence — two sessions get DISTINCT client instances. This is hermetic: `buildSessionMcpClients` connects LAZILY on first `callTool`/`listTools` (`mcp/build-session-mcp-clients.ts:43-44`), so a fake URL needs no MCP server. Reach the private wiring with the white-box cast pattern already used in `__tests__/mcp-single-connect.test.ts:44-53`.

```ts
// --- Integration: SmartServer consumes the decision it logs -----------------

import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { SmartServer } from '../smart-server.js';
import type { SmartServerConfig } from '../smart-server.js';

/** Reach the private wiring without changing visibility (pattern:
 *  `__tests__/mcp-single-connect.test.ts:44-53`). Step 5 uses the last two
 *  members — declare the full shape now, it is one type for the whole file. */
type Internals = {
  _buildInfra(): Promise<unknown>;
  buildSessionAgent(parts: { mcpClients?: IMcpClient[] }): Promise<unknown>;
  _lifecycle?: { acquire(sessionId: string): Promise<unknown> };
};

function fakeMcpClient(): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'ok' } };
    },
  };
}

/** Minimal config that reaches the MCP gate without provider credentials. */
function baseConfig(events: Record<string, unknown>[]): SmartServerConfig {
  return {
    port: 0,
    llm: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key' },
    skipProviderRuntimeChecks: true,
    log: (e) => events.push(e),
  } as unknown as SmartServerConfig;
}

test('#213: pure YAML mcp: → mcp_isolation perSession:true, no config_warning', async () => {
  const events: Record<string, unknown>[] = [];
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: 'http://127.0.0.1:9/mcp' },
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg);
  await (server as unknown as Internals)._buildInfra();

  const iso = events.find((e) => e.event === 'mcp_isolation');
  assert.ok(iso, 'mcp_isolation event emitted');
  assert.equal(iso.perSession, true);
  assert.equal(iso.mcpFromYaml, true);
  assert.deepEqual(iso.disabledReasons, []);
  assert.equal(
    events.find((e) => e.event === 'config_warning'),
    undefined,
    'no warning on the healthy per-session path',
  );
});

test('#213: ready clients + mcp: → perSession:false AND config_warning naming hasReadyClients', async () => {
  const events: Record<string, unknown>[] = [];
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: 'http://127.0.0.1:9/mcp' },
    mcpClients: [fakeMcpClient()],
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg);
  await (server as unknown as Internals)._buildInfra();

  const iso = events.find((e) => e.event === 'mcp_isolation');
  assert.ok(iso);
  assert.equal(iso.perSession, false);
  assert.deepEqual(iso.disabledReasons, ['hasReadyClients']);
  const warn = events.find((e) => e.event === 'config_warning');
  assert.ok(warn, 'a silent shared fallback must warn');
  assert.match(String(warn.message), /hasReadyClients/);
});

test('#213: injected connectMcp seam + mcp: → perSession:false AND warning names mcpSeamInjected', async () => {
  const events: Record<string, unknown>[] = [];
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: 'http://127.0.0.1:9/mcp' },
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg, {
    connectMcp: async () => [fakeMcpClient()],
  });
  await (server as unknown as Internals)._buildInfra();

  const iso = events.find((e) => e.event === 'mcp_isolation');
  assert.ok(iso);
  assert.equal(iso.perSession, false);
  assert.deepEqual(iso.disabledReasons, ['mcpSeamInjected']);
  const warn = events.find((e) => e.event === 'config_warning');
  assert.ok(warn);
  assert.match(String(warn.message), /mcpSeamInjected/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts'`

Expected: the 3 new tests FAIL on `assert.ok(iso, 'mcp_isolation event emitted')` — the event does not exist yet. The 7 Task-1 tests still PASS.

- [ ] **Step 3: Write minimal implementation**

In `smart-server.ts`, REPLACE the `mcpFromYaml` block at `1175-1186`. Current code:

```ts
    const mcpFromYaml = serverOwnsMcpConnection({
      hasReadyClients,
      hasMcpConfig: !!this.cfg.mcp,
      mcpSeamInjected: this._mcpSeamInjected,
    });
```

becomes:

```ts
    // #213 diagnostics: resolve the decision ONCE. This object is BOTH logged
    // (`mcp_isolation`) and consumed by the lifecycle wiring below, so the
    // diagnostic can never disagree with which clients sessions actually get.
    const isolation = describeMcpIsolation({
      hasReadyClients,
      hasMcpConfig: !!this.cfg.mcp,
      mcpSeamInjected: this._mcpSeamInjected,
      mcpSharedClient: this.cfg.agent?.mcpSharedClient,
    });
    log(isolation as unknown as Record<string, unknown>);
    // A SILENT shared-client fallback is what made #213 expensive to diagnose —
    // name the responsible fact so the deliberate opt-out is distinguishable.
    if (!isolation.perSession && isolation.hasMcpConfig)
      this.warn(
        `MCP per-session isolation OFF (shared client across sessions) — reason: ${isolation.disabledReasons.join(', ')}`,
      );
    const mcpFromYaml = isolation.mcpFromYaml;
```

Leave `const yamlBuilderConnect = mcpFromYaml;` (line `1186`) exactly as is — behavior unchanged.

Then REPLACE the lifecycle wiring at `1348-1352` so it consumes the SAME value:

```ts
      buildPerSessionMcpClients: shouldIsolateMcpPerSession({
        mcpFromYaml,
        mcpSharedClient: this.cfg.agent?.mcpSharedClient,
      })
        ? () => buildSessionMcpClients(this.cfg.mcp)
        : undefined,
```

becomes:

```ts
      // #213: consume the SAME resolved decision that was logged above — never
      // re-derive it here, or the diagnostic and the wiring can drift.
      buildPerSessionMcpClients: isolation.perSession
        ? () => buildSessionMcpClients(this.cfg.mcp)
        : undefined,
```

Update the import at the top of `smart-server.ts` — `shouldIsolateMcpPerSession` may now be unused; if Biome/tsc reports it unused, drop it from the import list and add `describeMcpIsolation`:

```ts
import {
  buildSessionMcpClients,
  describeMcpIsolation,
  serverOwnsMcpConnection,
} from './mcp/build-session-mcp-clients.js';
```

`serverOwnsMcpConnection` stays exported and unit-tested regardless — `describeMcpIsolation` composes it.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts'`

Expected: PASS — 10 tests, 0 fail.

- [ ] **Step 5: Prove the wiring is actually consumed (the anti-drift assertion)**

The three tests above read the log only — they would still pass if the event said
`perSession: true` while every session shared one client. This step closes that:
acquire two sessions from the lifecycle the server ACTUALLY built and assert the
clients they received are distinct.

Capture point: `SessionGraphFactory` calls the installed factory and hands the
result to `buildAgent` as `parts.mcpClients`
(`llm-agent-libs/src/session/session-graph-factory.ts:91-94`), and SmartServer
installs `buildAgent: (parts) => this.buildSessionAgent(parts)`
(`smart-server.ts:1358`). Because that arrow resolves `this.buildSessionAgent` at
CALL time, replacing the method on the instance BEFORE `_buildInfra()` intercepts
the real per-session parts — and keeps the test hermetic (no real agent is built,
so no LLM is needed). Assertion shape mirrors
`__tests__/issue-213-concurrent-tool-use.test.ts:84-96`.

`Internals` is already declared in Step 1 with the members these tests need — do
not redeclare it. Append:

```ts
test('#213 anti-drift: perSession:true → two sessions RECEIVE distinct client instances', async () => {
  const events: Record<string, unknown>[] = [];
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: 'http://127.0.0.1:9/mcp' },
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg);
  const internals = server as unknown as Internals;

  // Intercept BEFORE _buildInfra installs `buildAgent: (parts) => this.buildSessionAgent(parts)`.
  const captured: (IMcpClient[] | undefined)[] = [];
  internals.buildSessionAgent = async (parts) => {
    captured.push(parts.mcpClients);
    return undefined;
  };
  await internals._buildInfra();

  const iso = events.find((e) => e.event === 'mcp_isolation');
  assert.equal(iso?.perSession, true, 'precondition: the event claims isolation');

  // The event must not be able to lie about what sessions actually get.
  // Wrappers connect LAZILY, so nothing listens on 127.0.0.1:9 and none is needed.
  await Promise.all([
    internals._lifecycle?.acquire('session-A'),
    internals._lifecycle?.acquire('session-B'),
  ]);
  assert.equal(captured.length, 2, 'both sessions acquired');
  assert.notEqual(captured[0], captured[1], 'DISTINCT client arrays per session');
  assert.notEqual(
    captured[0]?.[0],
    captured[1]?.[0],
    'DISTINCT client instances per session',
  );
});

test('#213 anti-drift: perSession:false → both sessions receive the SAME shared client', async () => {
  const events: Record<string, unknown>[] = [];
  const shared = fakeMcpClient();
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: 'http://127.0.0.1:9/mcp' },
    mcpClients: [shared],
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg);
  const internals = server as unknown as Internals;

  const captured: (IMcpClient[] | undefined)[] = [];
  internals.buildSessionAgent = async (parts) => {
    captured.push(parts.mcpClients);
    return undefined;
  };
  await internals._buildInfra();

  assert.equal(
    events.find((e) => e.event === 'mcp_isolation')?.perSession,
    false,
    'precondition: the event admits the shared fallback',
  );
  await Promise.all([
    internals._lifecycle?.acquire('session-A'),
    internals._lifecycle?.acquire('session-B'),
  ]);
  assert.equal(captured.length, 2);
  assert.equal(
    captured[0]?.[0],
    captured[1]?.[0],
    'the shared fallback hands both sessions the same instance',
  );
});
```

**Verify the capture actually bites.** A silently-never-called interceptor would
make `captured.length === 0` and the assertions would be vacuous — that is why both
tests assert `captured.length === 2` FIRST. If it is 0, the interception point moved:
re-read `smart-server.ts:1358` and confirm `buildAgent` still routes through
`this.buildSessionAgent`. Do not delete the assertion to make the test pass.

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts'`

Expected: PASS — 12 tests, 0 fail (7 from Task 1 + 3 event cases + 2 anti-drift).

**Note for the implementer:** if `_buildInfra()` throws in any of these tests (missing credentials, model validation, an embedder fetch), do NOT weaken the assertions and do NOT add production code to make the test pass. Fix the TEST config — `skipProviderRuntimeChecks: true` is the intended escape hatch (`smart-server.ts:302`). If it still throws, mirror the config used by `__tests__/mcp-yaml-vectorization.test.ts`, or drive the narrower private method that contains the gate instead. Report what you had to do.

- [ ] **Step 6: Format, lint, full package tests**

```bash
npm run format
npm run test -w @mcp-abap-adt/llm-agent-server-libs
```
Expected: clean; the whole package suite green — especially `per-session-mcp-wiring.test.ts`, `issue-213-concurrent-tool-use.test.ts`, `mcp-single-connect.test.ts`, `readiness-gate.test.ts`, which cover the code paths touched here.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts \
        packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-isolation-diagnostics.test.ts
git commit -m "feat(server): always-on mcp_isolation event + reasoned config_warning (#213)"
```

---

## Task 3: Controller `classify` / `run` debug lines

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` — after `classifyRequest` (`279-285`), and at the two runId mint sites (`296-297` expired-replay fall-through, `308-309` fresh) plus the `resume` branch (`311`).
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-diagnostics-log.test.ts` (create)

**Interfaces:**
- Consumes: existing module-private `dlog(msg: string)` (`controller-coordinator-handler.ts:75-76`) — writes `[controller] <msg>` to `console.error` only when `process.env.DEBUG_CONTROLLER` is set. Do NOT add a new logging channel.
- Produces: nothing consumed by other tasks.

**Why two lines (do not collapse into one):** for `cls.kind === 'fresh'` the run is minted AFTER the classify branch (`bundle.runId = mintRunId()` at `:309`). In the reporter's repro every cookieless request is a NEW session, so `hydrateBundle` returns an empty bundle and `bundle.runId` would be `undefined` at classify time — always. The `classify` line always fires (including on branches that return early); the `run` line adds identity once it exists.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-diagnostics-log.test.ts`. The fake-ctx harness mirrors `controller-mcp-failloud.test.ts:37-58`:

```ts
/**
 * #213 diagnostics: the controller must emit, under DEBUG_CONTROLLER, one
 * `classify` line per request (fires on EVERY branch, incl. early returns) and a
 * `run` line once the run identity is settled. Regression guard: on a fresh run
 * the runId is minted AFTER classify, so a single line logged at classify time
 * would report `run=undefined` — exactly the case being diagnosed.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { LlmStreamChunk, Result } from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import {
  InMemoryKnowledgeBackend,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import { ControllerCoordinatorHandler } from '../controller-coordinator-handler.js';

type Captured = Result<LlmStreamChunk, unknown>;

let lines: string[] = [];
const realErr = console.error;

beforeEach(() => {
  lines = [];
  process.env.DEBUG_CONTROLLER = '1';
  console.error = (msg?: unknown) => {
    lines.push(String(msg));
  };
});

afterEach(() => {
  console.error = realErr;
  process.env.DEBUG_CONTROLLER = undefined;
});

test('#213: fresh run logs classify + a run line with a REAL runId (never undefined)', async () => {
  const captured: Captured[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-diag');
  const ctx = {
    sessionId: 'sess-diag',
    textOrMessages: 'read table T000',
    options: undefined,
    externalResults: undefined,
    requestLogger,
    yield: (c: Captured) => captured.push(c),
  } as unknown as PipelineContext;

  const handler = new ControllerCoordinatorHandler(
    makeDeps(new InMemoryKnowledgeBackend()),
  );
  await handler.execute(ctx, {}, undefined);

  const classify = lines.find((l) => l.includes('classify '));
  assert.ok(classify, 'a classify line is emitted');
  assert.match(classify, /session=sess-diag/);
  assert.match(classify, /cls=fresh/);

  const run = lines.find((l) => l.includes('] run '));
  assert.ok(run, 'a run line is emitted once identity is settled');
  assert.match(run, /session=sess-diag/);
  assert.doesNotMatch(run, /run=undefined/, 'runId must be minted by now');
  assert.match(run, /run=run-/);
});

test('#213: DEBUG_CONTROLLER unset → no diagnostic lines (zero default noise)', async () => {
  process.env.DEBUG_CONTROLLER = undefined;
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-quiet');
  const ctx = {
    sessionId: 'sess-quiet',
    textOrMessages: 'read table T000',
    options: undefined,
    externalResults: undefined,
    requestLogger,
    yield: () => {},
  } as unknown as PipelineContext;

  const handler = new ControllerCoordinatorHandler(
    makeDeps(new InMemoryKnowledgeBackend()),
  );
  await handler.execute(ctx, {}, undefined);

  assert.deepEqual(
    lines.filter((l) => l.includes('[controller] classify')),
    [],
  );
});
```

`makeDeps(backend)` builds a `ControllerHandlerDeps` with a scripted subagent client that immediately finishes the run. Copy the helper set (`scriptedClient`, `stubRag`, and the `deps` literal) verbatim from `controller-mcp-failloud.test.ts` — that file already assembles a minimal working `ControllerHandlerDeps` against `InMemoryKnowledgeBackend`. Read it first and mirror its shape rather than inventing a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-diagnostics-log.test.ts'`

Expected: FAIL on `assert.ok(classify, 'a classify line is emitted')` — no such line yet.

- [ ] **Step 3: Write minimal implementation**

In `controller-coordinator-handler.ts`, immediately AFTER the `classifyRequest` call (which ends at `:285`) and BEFORE `if (cls.kind === 'replay')`:

```ts
    // #213 diagnostics: fires on EVERY branch (incl. the early-return replay /
    // not-found ones). `bundle.runId` is deliberately NOT logged here — on a
    // fresh run it is minted below, so it would always read `undefined`.
    dlog(`classify session=${sessionId} cls=${cls.kind}`);
```

Then add the run line at each site where identity is settled. After `bundle.runId = mintRunId();` in the expired-replay fall-through (`:297`) and in the `fresh` branch (`:309`), and at the top of the `resume` branch (after `} else if (cls.kind === 'resume' && bundle.runId) {`, `:311`), add:

```ts
      dlog(`run session=${sessionId} run=${bundle.runId} cls=${cls.kind}`);
```

Place it AFTER the `bundle.runId = mintRunId();` assignment and AFTER `await persistBundle(...)` in the two mint branches, so the logged id is the persisted one.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-diagnostics-log.test.ts'`

Expected: PASS — 2 tests, 0 fail.

- [ ] **Step 5: Format, lint, full package tests**

```bash
npm run format
npm run test -w @mcp-abap-adt/llm-agent-server-libs
```
Expected: clean; whole suite green. The controller suite is large — confirm `controller-coordinator-handler.test.ts`, `round-trip.test.ts`, `run-scope.test.ts` still pass (they drive the same branches).

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-diagnostics-log.test.ts
git commit -m "feat(server): DEBUG_CONTROLLER classify/run diagnostics lines (#213)"
```

---

## Task 4: Whole-branch verification

**Files:** none modified — this task only verifies and reports.

- [ ] **Step 1: Confirm the base is right**

```bash
git branch --show-current    # → diag/issue-213-mcp-isolation-observability
git log --oneline main..HEAD # → the 3 spec commits + 3 implementation commits
git diff main...HEAD --stat
```
Expected: only the 5 files from the File Structure table, plus the spec and this plan. If any other production file changed, STOP and report — this PR is observability-only.

- [ ] **Step 2: Prove zero behavior change**

```bash
git diff main...HEAD -- packages/llm-agent-server-libs/src/smart-agent/smart-server.ts \
                        packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts
```
Read the diff. Every added line must be a log call, a comment, or the `isolation` const that replaces the inline `serverOwnsMcpConnection`/`shouldIsolateMcpPerSession` calls with the SAME resolved value. If any line changes control flow or which clients a session receives, revert it.

- [ ] **Step 3: Full build + full monorepo tests**

```bash
npm run build
npm run test
```
Expected: build clean (the new export must compile under strict mode); all workspace tests pass.

- [ ] **Step 4: Lint gate**

```bash
npm run lint:check
```
Expected: 0 errors. (If it reports unsorted imports, run `npm run format` and amend the relevant commit.)

- [ ] **Step 5: Report**

State: which tests were added and their counts, the exact `mcp_isolation` payload shape the reporter should look for, and anything you had to deviate on. Do NOT claim success without pasting the actual test output — evidence before assertions.

---

## Follow-up (NOT code — do not do this in this PR)

After merge + release, ask the reporter for:
1. the `mcp_isolation` line from their `smart-server.log`;
2. one 2-way concurrent run with `DEBUG_CONTROLLER=1`, enough to show `classify session=/cls=` (and the follow-on `run=` line) for both requests.

Discriminator: different `sessionId` + `perSession: false` → **H1** (the gate is the bug). Same `sessionId` → **H2** (the cookieless assumption is wrong). Both point to the real fix PR, which is deliberately not this one.
