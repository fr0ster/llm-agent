# Session-Scoped Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give consumers running with different sessions correct, *provable* scoping via a per-session object **graph** assembled by a `SessionGraphFactory` from injected global resources (upstream MCP, vectorized tools-catalog RAG, LLM/embedder clients, RAG registry) — never rebuilding those globals per session. The graph owns per-session pipeline/interpreter/coordinator/workers + the sessionId-keyed registries + a per-session token-logger; identity comes from a server-issued cookie; RAG scoping reuses the existing per-call `rag-query` filter; usage rolls up per session with non-zero per-response numbers.

**Architecture (the locked model):**

- **GLOBAL, built once, injected by reference:** upstream MCP client, vectorized tools-catalog RAG (`toolsRag`), LLM/embedder clients, the RAG provider/registry (`IRagRegistry`) with global/user collections. The expensive `builder.build()` work (MCP connect + tool vectorization, `builder.ts:880-1089`) runs **once**.
- **PER-SESSION instances, built cheaply from those globals:** pipeline (`DefaultPipeline`), DAG interpreter/coordinator (`DagCoordinatorHandler`), roles, workers, the per-session MCP server (handler registration), token-logger (`SessionRequestLogger`), history-memory, `ToolAvailabilityRegistry`, `PendingToolResultsRegistry`.
- **`SessionGraphFactory.build(identity) → SessionGraph`** is the central new composition path. It does NOT re-connect MCP or re-vectorize tools; it injects the already-built `toolsRag` / `ragRegistry` / LLM / MCP clients into a fresh `SmartAgentBuilder` via `withMcpClients()` (skips connect+vectorize — `builder.ts:880-882`), `setToolsRag()`, `setRagRegistry()`, plus a per-session `SessionRequestLogger` via `withRequestLogger()`.
- **RAG:** NO identity-bound view/factory objects. Reuse the existing per-call `rag-query` scope filter (`rag-query.ts:73-86`: `scope:session → ragFilter.sessionId = ctx.sessionId`, `scope:user → ragFilter.userId = ctx.options.userId`). The graph only (a) guarantees `ctx.sessionId == cookie session id` (set via `options.sessionId`, threaded to `default-pipeline.ts:388` / `agent.ts:672`), and (b) creates/closes session collections via the existing `SimpleRagRegistry.createCollection` / `closeSession`. Workers SHARE the parent `IRagRegistry` (`setRagRegistry`), not an isolated `makeRag`.
- **Reentrancy (binding):** per-session pipeline/interpreter/coordinator/worker instances are shared across concurrent same-session requests and MUST be reentrant — all per-run mutable state already lives in the per-request `PipelineContext` (`default-pipeline.ts:386-435`), never on instance fields. The graph holds only session state + shared services. Token-logger request delta is keyed by `traceId`.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), Node ≥22, `node --test` run via `tsx`, Biome, 16 lockstep-versioned packages. Spec: `docs/superpowers/specs/2026-05-27-session-scoped-infrastructure-design.md`.

**Run tests:** `npx tsx --test <path>` (single file). Full type check: `npm run build`. Lint: `npm run lint`.

---

## File Structure (verified composition map)

### How composition works today (read these before editing)

- **`builder.ts:693` `build()`** is the single composition entry. Sequence:
  - `builder.ts:745-746` resolves `toolsRag`; `builder.ts:764-765` resolves `ragRegistry` (`this._ragRegistry ?? new SimpleRagRegistry()`); `builder.ts:772` wires the provider registry; `builder.ts:813-824` installs the live `ragStores` projection (mutation listener).
  - `builder.ts:873` resolves `requestLogger = this._requestLogger ?? new DefaultRequestLogger()`.
  - **`builder.ts:880-1089` — the expensive path:** if `this._mcpClients` is set (via `withMcpClients`), **auto-connect and vectorization are skipped** (`builder.ts:880-882`). Otherwise it connects each MCP wrapper (`builder.ts:906`) and **vectorizes the tools catalog into `toolsRag`** (`builder.ts:917-1069`). THIS is what the factory must skip by injecting pre-built clients + toolsRag.
  - `builder.ts:1127-1129` builds `LlmClassifier(..., requestLogger)`.
  - `builder.ts:1229-1254` resolves the coordinator (`OneShotPlanning`, `HybridDispatch`/`SubAgentDispatch`/`SelfDispatch`) from `this._coordinator`; `toolSource` is derived from `toolsRag`.
  - `builder.ts:1256-1293` constructs `DefaultPipeline({ subAgents, coordinator, dagCoordinator })` and `pipeline.initialize({... toolsRag, ragRegistry, requestLogger, ...})`.
  - `builder.ts:1295-1339` constructs `new SmartAgent({... ragRegistry, pipeline, requestLogger }, agentCfg)`.
  - `builder.ts:1365-1381` returns the `SmartAgentHandle` (`agent`, `chat`, `streamChat`, `requestLogger`, `close`, `ragStores`, ...). **`ragRegistry` is NOT currently on the handle** — Task A4 adds it.
  - **DAG worker wiring:** `withDagCoordinator(deps)` (`builder.ts:561`) stores `this._dagCoordinator`; workers are `ISubAgent` instances in `deps.workers`. The DAG handler `DagCoordinatorHandler` (`dag-coordinator.ts:35` `workers: ReadonlyMap<string, ISubAgent>`) dispatches them.

- **`agent.ts` — requestLogger is a constructor field:** `agent.ts:237` `private readonly requestLogger`, set at `agent.ts:260` from `deps.requestLogger`. Used at `agent.ts:680` (`startRequest`), `agent.ts:1083` (`endRequest`), `agent.ts:1233`/`1582`/`1702`/`1743` (`getSummary().byModel`), `agent.ts:1961` (`logLlmCall` for helper). **`traceId` is per-request** at `agent.ts:642` (`options?.trace?.traceId ?? randomUUID()`). `sessionId` at `agent.ts:672` (`options?.sessionId ?? 'default'`).
  - **Chosen approach (composition seam):** the `SessionGraphFactory` builds a **per-session `SmartAgent`** whose constructor `requestLogger` IS the session's `SessionRequestLogger`. We do NOT thread a per-call logger override into `agent.ts` (that would touch ~6 call sites and the `IRequestLogger` field type). Per-request isolation comes from the **`traceId`-keyed delta inside `SessionRequestLogger`** (Phase C), so one logger instance shared across concurrent requests stays correct. `startRequest`/`endRequest`/`getSummary`/`logLlmCall` calls become `traceId`-aware via Task C6 (propagate `traceId` as `requestId`).

- **`default-pipeline.ts:386-435` `buildContext()`** creates the per-request `PipelineContext`: `sessionId: options?.sessionId ?? 'default'` (`:388`), `requestLogger: this.resolvedRequestLogger` (`:408`), and **`toolAvailabilityRegistry: new ToolAvailabilityRegistry()` (`:411`) + `pendingToolResults: new PendingToolResultsRegistry()` (`:412`)** — per-request `new`, the two sessionId-keyed registries to hoist into the graph.

- **`smart-server.ts` — server composition:**
  - `build()`: `:463` `new SmartAgentBuilder(...)`; `:484-485` `toolsRag = await makeRag(...)` + `setToolsRag`; `:518-521` named stores; `:610-632` builds subagents via `buildSubAgent` and `withSubAgents(registry)`; `:719` `withDagCoordinator(...)`; `:783` **the single `agentHandle = await builder.build()`**; `:784-792` destructures it (no `ragRegistry` yet).
  - **`buildSubAgent` (`:940-1030`):** today each worker calls `makeRag(subCfg.rag)` (`:1012-1017`) → isolated RAG. B replaces this with the shared parent `IRagRegistry`.
  - `_handle` (`:1032`): `:1342` `traceId = randomUUID()`; `:1343` `sessionId = (req.headers['x-session-id'] as string) || 'default'` — **the line cookie identity replaces**; `:1386-1401` `opts` (carries `sessionId`, `trace.traceId`).
  - `/v1/usage` (`:1118-1121`): returns the single global `requestLogger.getSummary()` — C4 makes it per-session.

- **Reuse (do NOT reinvent):** `SimpleRagRegistry.createCollection` / `closeSession` (`simple-rag-registry.ts:86`,`:188`); `InMemoryRagProvider` + provider registry (close-session test pattern, `smart-agent-close-session.test.ts:1-35`); the `rag-query` scope filter (`rag-query.ts:73-86`); `SmartAgent.closeSession` (`agent.ts:408-420`).

### Files created / modified

**Phase A — Session Foundation**
- Create: `packages/llm-agent/src/interfaces/session-identity.ts` — `SessionIdentity` contract.
- Create: `packages/llm-agent-server/src/smart-agent/session-identity-resolver.ts` — cookie parse/validate/mint + `Set-Cookie`.
- Create: `packages/llm-agent-libs/src/session/session-graph.ts` — `SessionGraph` (per-session instances + refcount + disposal flag).
- Create: `packages/llm-agent-libs/src/session/session-graph-factory.ts` — `SessionGraphFactory.build(identity)` (compose-from-injected-globals).
- Create: `packages/llm-agent-libs/src/session/session-registry.ts` — `SessionRegistry` (Map + lazy build + TTL/LRU + **drain** semantics).
- Modify: `packages/llm-agent-libs/src/builder.ts` — expose `ragRegistry` on `SmartAgentHandle` (and the base interface).
- Modify: `packages/llm-agent/src/interfaces/builder.ts` — add `ragRegistry` to `SmartAgentHandle`.
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts:411-412` — take the two registries from injected deps instead of per-request `new`.
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` (`build` + `_handle`) — build globals once, construct `SessionGraphFactory` + `SessionRegistry`, cookie resolve → graph → run on the session pipeline.
- Modify: server config type (`SmartServerConfig`) — add optional `session` block.

**Phase B — Worker RAG sharing**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` `buildSubAgent` (`:940-1030`) + call site (`:612`) — share parent `IRagRegistry`.

**Phase C — Session token-rollup**
- Modify: `packages/llm-agent/src/interfaces/request-logger.ts` — `requestId?` on entries + `startRequest/endRequest/getSummary(requestId?)`.
- Create: `packages/llm-agent-libs/src/logger/session-request-logger.ts` — `SessionRequestLogger` + `aggregate` + `summaryToUsage`.
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts:505`, `translate.ts:46`, `packages/llm-agent-libs/src/classifier/llm-classifier.ts:144`, `agent.ts:1961`, `rag-query.ts:90` — propagate `ctx.options.trace.traceId` as `requestId`.
- Modify: `packages/llm-agent-libs/src/agent.ts` — `startRequest(traceId)` / `endRequest(traceId)`; set `response.usage` from `getSummary(traceId)`.
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:1118` — `/v1/usage` per-session.

---

## PHASE A — Session Foundation

### Task A1: `SessionIdentity` contract type

**Files:**
- Create: `packages/llm-agent/src/interfaces/session-identity.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionIdentity } from '../session-identity.js';

test('SessionIdentity carries sessionId and optional userId', () => {
  const id: SessionIdentity = { sessionId: 's1' };
  assert.equal(id.sessionId, 's1');
  assert.equal(id.userId, undefined);
  const withUser: SessionIdentity = { sessionId: 's1', userId: 'u1' };
  assert.equal(withUser.userId, 'u1');
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Create the type**

```ts
// packages/llm-agent/src/interfaces/session-identity.ts
/**
 * Identity context for a session. `sessionId` is always present (server-issued
 * cookie, RFC 6265). `userId` is populated only by authorization-enabled builds;
 * the default server leaves it undefined. Extensible for future identity facets.
 */
export interface SessionIdentity {
  readonly sessionId: string;
  readonly userId?: string;
}
```

Add to `packages/llm-agent/src/interfaces/index.ts`:

```ts
export type { SessionIdentity } from './session-identity.js';
```

- [ ] **Step 4: Run** the test — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/session-identity.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts
git commit -m "feat(session): add SessionIdentity contract type"
```

---

### Task A2: Cookie identity resolver (mint/validate + `Set-Cookie`)

Resolves a `SessionIdentity` from the request cookie. Implements the spec cookie contract (A.1 / §A.1 cookie contract): opaque UUID id; `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age`, `Secure` WHEN HTTPS; id must match `^[A-Za-z0-9-]{1,128}$` else treat as no-cookie and mint fresh.

**Files:**
- Create: `packages/llm-agent-server/src/smart-agent/session-identity-resolver.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionIdentity } from '../session-identity-resolver.js';

const COOKIE = 'sid';
const base = { cookieName: COOKIE, maxAgeSeconds: 7200, isHttps: false };

test('mints a unique id and a Set-Cookie when no cookie present', () => {
  const r = resolveSessionIdentity({ ...base, cookieHeader: undefined });
  assert.ok(r.identity.sessionId.length > 0);
  assert.equal(r.minted, true);
  assert.match(r.setCookie ?? '', new RegExp(`^${COOKIE}=${r.identity.sessionId};`));
  assert.match(r.setCookie ?? '', /Max-Age=7200/);
  assert.match(r.setCookie ?? '', /HttpOnly/);
  assert.match(r.setCookie ?? '', /SameSite=Lax/);
  assert.match(r.setCookie ?? '', /Path=\//);
  assert.doesNotMatch(r.setCookie ?? '', /Secure/); // not HTTPS
});

test('adds Secure when the request is HTTPS', () => {
  const r = resolveSessionIdentity({ ...base, isHttps: true, cookieHeader: undefined });
  assert.match(r.setCookie ?? '', /Secure/);
});

test('reuses an existing valid session cookie without minting', () => {
  const r = resolveSessionIdentity({ ...base, cookieHeader: `${COOKIE}=abc-123; other=x` });
  assert.equal(r.identity.sessionId, 'abc-123');
  assert.equal(r.minted, false);
  assert.equal(r.setCookie, undefined);
});

test('malformed/empty cookie -> mint fresh (bad value never adopted)', () => {
  for (const bad of ['', 'has space', 'inv@lid', 'x'.repeat(129)]) {
    const r = resolveSessionIdentity({ ...base, cookieHeader: `${COOKIE}=${bad}` });
    assert.equal(r.minted, true, `expected mint for "${bad}"`);
    assert.notEqual(r.identity.sessionId, bad);
  }
});

test('two mints produce distinct ids (no shared default bucket)', () => {
  const a = resolveSessionIdentity({ ...base, cookieHeader: undefined });
  const b = resolveSessionIdentity({ ...base, cookieHeader: undefined });
  assert.notEqual(a.identity.sessionId, b.identity.sessionId);
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-server/src/smart-agent/session-identity-resolver.ts
import { randomUUID } from 'node:crypto';
import type { SessionIdentity } from '@mcp-abap-adt/llm-agent';

/** Opaque session-id format: UUID-compatible, defensive upper bound. */
const ID_RE = /^[A-Za-z0-9-]{1,128}$/;

export interface ResolveSessionInput {
  cookieHeader: string | undefined;
  cookieName: string;
  maxAgeSeconds: number;
  /** True when the request arrived over HTTPS; adds the `Secure` attribute. */
  isHttps: boolean;
}

export interface ResolveSessionResult {
  identity: SessionIdentity;
  /** true when a new id was minted (caller must send `setCookie`). */
  minted: boolean;
  /** Set-Cookie header value, present only when `minted`. */
  setCookie?: string;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const v = part.slice(eq + 1).trim();
      if (v.length > 0) return v;
    }
  }
  return undefined;
}

export function resolveSessionIdentity(input: ResolveSessionInput): ResolveSessionResult {
  const existing = parseCookie(input.cookieHeader, input.cookieName);
  // Validate: never adopt a malformed/empty client value as a sessionId.
  if (existing && ID_RE.test(existing)) {
    return { identity: { sessionId: existing }, minted: false };
  }
  const sessionId = randomUUID();
  const attrs = [
    `${input.cookieName}=${sessionId}`,
    `Max-Age=${input.maxAgeSeconds}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (input.isHttps) attrs.push('Secure');
  return { identity: { sessionId }, minted: true, setCookie: attrs.join('; ') };
}
```

- [ ] **Step 4: Run** the test — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/session-identity-resolver.ts packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts
git commit -m "feat(session): cookie identity resolver (mint/validate + Set-Cookie, HTTPS-aware Secure)"
```

---

### Task A3: `SessionGraph` (per-session instances + refcount + drain flag)

A `SessionGraph` holds the per-session runtime objects produced by the factory and a refcount that pins it against eviction while requests are in flight. It also carries a **mark-for-disposal** flag so the registry can drain a pinned graph (spec A.4). For this task the graph holds the two sessionId-keyed registries + the session logger + an injected per-session `agent` and `disposeFn`; the factory (A3b) populates them. The graph stays construction-injectable so it is unit-testable without the full builder.

**Files:**
- Create: `packages/llm-agent-libs/src/session/session-graph.ts`
- Test: `packages/llm-agent-libs/src/session/__tests__/session-graph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/session/__tests__/session-graph.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionGraph } from '../session-graph.js';
import { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';
import { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';

function make() {
  return new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger: new SessionRequestLogger(),
    dispose: async () => {},
  });
}

test('refcount pins the graph; release updates lastUsed', () => {
  const g = make();
  assert.equal(g.activeRequests, 0);
  assert.equal(g.isPinned, false);
  g.acquire();
  assert.equal(g.activeRequests, 1);
  assert.equal(g.isPinned, true);
  const t0 = g.lastUsedMs;
  g.release();
  assert.equal(g.activeRequests, 0);
  assert.equal(g.isPinned, false);
  assert.ok(g.lastUsedMs >= t0);
});

test('release never goes below zero', () => {
  const g = make();
  g.release();
  assert.equal(g.activeRequests, 0);
});

test('exposes sessionId-keyed registries and logger', () => {
  const g = make();
  assert.ok(g.toolAvailability);
  assert.ok(g.pendingToolResults);
  assert.ok(g.logger);
});

test('markForDisposal flag + dispose() runs the injected hook once', async () => {
  let n = 0;
  const g = new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger: new SessionRequestLogger(),
    dispose: async () => { n++; },
  });
  assert.equal(g.markedForDisposal, false);
  g.markForDisposal();
  assert.equal(g.markedForDisposal, true);
  await g.dispose();
  await g.dispose();
  assert.equal(n, 1);
});
```

> Note: this test imports `SessionRequestLogger`, created in C1. Implement C1's bare class first OR temporarily stub. The recommended order keeps A3 dependent on C1 only for the type; if executing strictly A→B→C, replace the logger arg with a minimal `{ reset(){} }` cast and revisit in C. The plan assumes the logger class exists (C1 is small and can be pulled forward).

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/session/__tests__/session-graph.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/session/session-graph.ts
import type { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import type { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import type { SessionRequestLogger } from '../logger/session-request-logger.js';
import type { SmartAgent } from '../agent.js';

export interface SessionGraphParts {
  readonly sessionId: string;
  /** sessionId-keyed registries hoisted out of per-request pipeline creation. */
  readonly toolAvailability: ToolAvailabilityRegistry;
  readonly pendingToolResults: PendingToolResultsRegistry;
  /** One token-logger shared by this session's agent + workers. */
  readonly logger: SessionRequestLogger;
  /** The per-session agent (built by SessionGraphFactory). Optional in unit tests. */
  readonly agent?: SmartAgent;
  /** Tears down session RAG + closes per-session resources (factory wires this). */
  readonly dispose: (sessionId: string) => Promise<void>;
}

/**
 * Per-session runtime container. Owns the per-session instances produced by the
 * SessionGraphFactory (agent/pipeline/interpreter/coordinator/workers via the
 * agent), the sessionId-keyed registries, and the session token-logger. Tracks
 * in-flight requests so eviction cannot dispose a graph mid-run; supports a
 * mark-for-disposal "drain" so a pinned graph is torn down once it goes idle.
 */
export class SessionGraph {
  readonly sessionId: string;
  readonly toolAvailability: ToolAvailabilityRegistry;
  readonly pendingToolResults: PendingToolResultsRegistry;
  readonly logger: SessionRequestLogger;
  readonly agent?: SmartAgent;
  private readonly disposeFn: (sessionId: string) => Promise<void>;
  private _active = 0;
  private _lastUsedMs = Date.now();
  private _marked = false;
  private _disposed = false;

  constructor(parts: SessionGraphParts) {
    this.sessionId = parts.sessionId;
    this.toolAvailability = parts.toolAvailability;
    this.pendingToolResults = parts.pendingToolResults;
    this.logger = parts.logger;
    this.agent = parts.agent;
    this.disposeFn = parts.dispose;
  }

  get activeRequests(): number { return this._active; }
  get isPinned(): boolean { return this._active > 0; }
  get lastUsedMs(): number { return this._lastUsedMs; }
  get markedForDisposal(): boolean { return this._marked; }

  acquire(): void {
    this._active++;
    this._lastUsedMs = Date.now();
  }
  release(): void {
    if (this._active > 0) this._active--;
    this._lastUsedMs = Date.now();
  }

  markForDisposal(): void { this._marked = true; }

  /** Idempotent: runs the dispose hook (session RAG cleanup + logger reset) once. */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this.logger.reset();
    await this.disposeFn(this.sessionId);
  }
}
```

- [ ] **Step 4: Run** the test — Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/session/session-graph.ts packages/llm-agent-libs/src/session/__tests__/session-graph.test.ts
git commit -m "feat(session): SessionGraph with refcount, mark-for-disposal drain, hoisted registries + session logger"
```

---

### Task A4: Expose `ragRegistry` on `SmartAgentHandle`

The `SessionGraphFactory` injects the global `ragRegistry`/`toolsRag` it gets from the once-built handle. Today the handle does not expose `ragRegistry`; add it.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/builder.ts` (add `ragRegistry` to `SmartAgentHandle`)
- Modify: `packages/llm-agent-libs/src/builder.ts:1365-1381` (return it)
- Test: `packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { makeTestLlm } from '../testing/index.js'; // existing test helper for a fake ILlm

test('build() exposes the ragRegistry it composed', async () => {
  const reg = new SimpleRagRegistry();
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeTestLlm())
    .setRagRegistry(reg)
    .build();
  assert.equal(handle.ragRegistry, reg);
  await handle.close();
});
```

> Implementer note: use whatever fake-LLM helper `packages/llm-agent-libs/src/testing/index.ts` exports (grep for a `makeTestLlm`/`FakeLlm`/`makeDefaultDeps` equivalent); the assertion is only that `handle.ragRegistry === reg`.

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts` — Expected: FAIL (`ragRegistry` not on handle / type error).

- [ ] **Step 3: Implement**

In `packages/llm-agent/src/interfaces/builder.ts`, add to `SmartAgentHandle` (after `ragStores`):

```ts
  /** The RAG registry composed by the builder (shared global, injected per-session). */
  ragRegistry: IRagRegistry;
```

Ensure `IRagRegistry` is imported in that file (it is already used elsewhere in the interfaces package; add the import if missing).

In `packages/llm-agent-libs/src/builder.ts`, in the `return { ... }` object (`:1365`), add `ragRegistry,` (the local `ragRegistry` from `:764` is in scope).

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/builder.ts packages/llm-agent-libs/src/builder.ts packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts
git commit -m "feat(session): expose ragRegistry on SmartAgentHandle for per-session injection"
```

---

### Task A5: Inject sessionId-keyed registries into the pipeline

Replace the per-request `new ToolAvailabilityRegistry()` / `new PendingToolResultsRegistry()` (`default-pipeline.ts:411-412`) with values taken from the per-request `CallOptions`, falling back to fresh instances (preserves embed-as-library behavior). The `SessionGraph` supplies its instances via `options`.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/types.ts` — add optional `toolAvailability` / `pendingToolResults` to `CallOptions`.
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts` — add `resolveSessionRegistries` helper; use it at `:411-412`.
- Test: `packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-session-registries.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-session-registries.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';
import { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import { resolveSessionRegistries } from '../default-pipeline.js';

test('uses injected registries when provided', () => {
  const ta = new ToolAvailabilityRegistry();
  const pr = new PendingToolResultsRegistry();
  const out = resolveSessionRegistries({ toolAvailability: ta, pendingToolResults: pr });
  assert.equal(out.toolAvailability, ta);
  assert.equal(out.pendingToolResults, pr);
});

test('falls back to fresh instances when none provided', () => {
  const out = resolveSessionRegistries({});
  assert.ok(out.toolAvailability instanceof ToolAvailabilityRegistry);
  assert.ok(out.pendingToolResults instanceof PendingToolResultsRegistry);
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-session-registries.test.ts` — Expected: FAIL (`resolveSessionRegistries` not exported).

- [ ] **Step 3: Implement**

In `packages/llm-agent/src/interfaces/types.ts`, extend `CallOptions` (it already has `sessionId`/`userId`/`trace`) with two optional carriers. Use `unknown`-free precise types via a structural import to avoid a libs→contracts dependency cycle: declare them as opaque slots typed only by the registries' public method surface. Simplest correct approach — add:

```ts
  /** Per-session sessionId-keyed registries injected by the SessionGraph.
   *  Untyped here (structural) to avoid a contracts→libs cycle; libs narrows. */
  toolAvailability?: unknown;
  pendingToolResults?: unknown;
```

In `packages/llm-agent-libs/src/pipeline/default-pipeline.ts`, add (top-level export):

```ts
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';

export function resolveSessionRegistries(src: {
  toolAvailability?: ToolAvailabilityRegistry;
  pendingToolResults?: PendingToolResultsRegistry;
}): {
  toolAvailability: ToolAvailabilityRegistry;
  pendingToolResults: PendingToolResultsRegistry;
} {
  return {
    toolAvailability: src.toolAvailability ?? new ToolAvailabilityRegistry(),
    pendingToolResults: src.pendingToolResults ?? new PendingToolResultsRegistry(),
  };
}
```

Replace `default-pipeline.ts:411-412`:

```ts
      toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
      pendingToolResults: new PendingToolResultsRegistry(),
```

with (reading the per-request `options`, narrowing the opaque slots):

```ts
      ...(() => {
        const r = resolveSessionRegistries({
          toolAvailability: options?.toolAvailability as ToolAvailabilityRegistry | undefined,
          pendingToolResults: options?.pendingToolResults as PendingToolResultsRegistry | undefined,
        });
        return {
          toolAvailabilityRegistry: r.toolAvailability,
          pendingToolResults: r.pendingToolResults,
        };
      })(),
```

(`options` is the `CallOptions | undefined` already in scope in `buildContext`, matching `:388`/`:408`.)

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/types.ts packages/llm-agent-libs/src/pipeline/default-pipeline.ts packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-session-registries.test.ts
git commit -m "feat(session): inject sessionId-keyed registries into pipeline via CallOptions (per-session, not per-request)"
```

---

### Task A6: `SessionGraphFactory` — compose per-session graph from injected globals

The central new composition path (spec A.2). `build(identity)` constructs a per-session `SmartAgent` by re-running `SmartAgentBuilder.build()` **with the heavy globals injected**: `withMcpClients(globalMcpClients)` (skips connect+vectorize — `builder.ts:880-882`), `setToolsRag(globalToolsRag)`, `setRagRegistry(globalRagRegistry)`, and a fresh per-session `SessionRequestLogger` via `withRequestLogger`. It also creates the two sessionId-keyed registries and wires `dispose` to `globalRagRegistry.closeSession`. Coordinator/DAG/subagent config is passed through unchanged so the per-session pipeline matches the server's config (and MAY differ per session in future).

**Files:**
- Create: `packages/llm-agent-libs/src/session/session-graph-factory.ts`
- Modify: `packages/llm-agent-libs/src/index.ts` — export `SessionGraphFactory`, `SessionGraph`, `SessionRegistry`.
- Test: `packages/llm-agent-libs/src/session/__tests__/session-graph-factory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/session/__tests__/session-graph-factory.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { SessionGraphFactory } from '../session-graph-factory.js';
import { makeTestLlm } from '../../testing/index.js';

function makeRagRegistry() {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return reg;
}

test('build(identity) yields a graph whose registries differ per session and shares the injected RAG registry', async () => {
  const ragRegistry = makeRagRegistry();
  const factory = new SessionGraphFactory({
    mcpClients: [],            // injected globals (empty here: no connect/vectorize)
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async (parts) => {
      // The factory feeds parts (sessionId, logger, mcpClients, toolsRag, ragRegistry)
      // into a SmartAgentBuilder; in this test we just assert wiring values arrive.
      assert.equal(parts.ragRegistry, ragRegistry);
      assert.ok(parts.logger);
      // Return a minimal agent stand-in: the real factory returns handle.agent.
      const handle = await (await import('../../builder.js')).SmartAgentBuilder
        .prototype; // not used; real impl builds a real agent (see note)
      return undefined as never;
    },
  });

  const g1 = await factory.build({ sessionId: 's1' });
  const g2 = await factory.build({ sessionId: 's2' });
  assert.notEqual(g1, g2);
  assert.notEqual(g1.toolAvailability, g2.toolAvailability);
  assert.notEqual(g1.pendingToolResults, g2.pendingToolResults);
  assert.notEqual(g1.logger, g2.logger);
  assert.equal(g1.sessionId, 's1');
});

test('dispose() of a graph closes session collections on the shared registry only', async () => {
  const ragRegistry = makeRagRegistry();
  const factory = new SessionGraphFactory({
    mcpClients: [],
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async () => undefined as never,
  });
  await ragRegistry.createCollection({ providerName: 'mem', collectionName: 'g-s1', scope: 'session', sessionId: 's1' });
  assert.ok(ragRegistry.get('g-s1'));
  const g = await factory.build({ sessionId: 's1' });
  await g.dispose();
  assert.equal(ragRegistry.get('g-s1'), undefined, 'session collection removed on dispose');
});
```

> Implementer note: the test injects a `buildAgent` seam so the factory is unit-testable without a real MCP/LLM stack. In production the factory's default `buildAgent` runs a real `SmartAgentBuilder.build()`. Keep `buildAgent` an injectable constructor option (defaulting to the real builder path) so this test stays cheap. Drop the placeholder dynamic-import line in the first test — `buildAgent` may return `undefined as never` for these wiring assertions; the registry-isolation assertions are what matter.

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/session/__tests__/session-graph-factory.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/session/session-graph-factory.ts
import type { IMcpClient, IRag, IRagRegistry } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { SessionGraph } from './session-graph.js';

export interface SessionGraphIdentity {
  readonly sessionId: string;
  readonly userId?: string;
}

/** Parts handed to `buildAgent` — the injected globals + per-session services. */
export interface SessionAgentParts {
  readonly sessionId: string;
  readonly mcpClients: IMcpClient[];
  readonly toolsRag: IRag | undefined;
  readonly ragRegistry: IRagRegistry;
  readonly logger: SessionRequestLogger;
}

export interface SessionGraphFactoryOptions {
  /** GLOBAL upstream MCP clients — injected by reference, never re-connected. */
  readonly mcpClients: IMcpClient[];
  /** GLOBAL vectorized tools-catalog RAG — injected by reference, never re-vectorized. */
  readonly toolsRag: IRag | undefined;
  /** GLOBAL RAG provider/registry — shared; the per-call scope filter isolates. */
  readonly ragRegistry: IRagRegistry;
  /**
   * Builds the per-session SmartAgent from `parts`. Production wiring runs a
   * `SmartAgentBuilder.build()` with the injected globals + this session's logger;
   * tests inject a stub. Returns the built agent (or undefined in pure-wiring tests).
   */
  readonly buildAgent: (parts: SessionAgentParts) => Promise<SmartAgent | undefined>;
}

/**
 * Central per-session composition path (spec A.2). Assembles a SessionGraph by
 * injecting the GLOBAL heavy resources (MCP clients, vectorized toolsRag, RAG
 * registry) by reference — it never re-connects MCP or re-vectorizes tools — and
 * allocates the cheap per-session instances (logger + sessionId-keyed registries
 * + the per-session agent/pipeline/interpreter/coordinator/workers).
 */
export class SessionGraphFactory {
  constructor(private readonly opts: SessionGraphFactoryOptions) {}

  async build(identity: SessionGraphIdentity): Promise<SessionGraph> {
    const logger = new SessionRequestLogger();
    const toolAvailability = new ToolAvailabilityRegistry();
    const pendingToolResults = new PendingToolResultsRegistry();

    const agent = await this.opts.buildAgent({
      sessionId: identity.sessionId,
      mcpClients: this.opts.mcpClients,
      toolsRag: this.opts.toolsRag,
      ragRegistry: this.opts.ragRegistry,
      logger,
    });

    return new SessionGraph({
      sessionId: identity.sessionId,
      toolAvailability,
      pendingToolResults,
      logger,
      agent,
      // Reuse the EXISTING registry teardown — closes scope:session collections
      // for this sessionId; global/user collections survive (spec A.4).
      dispose: async (sessionId) => {
        await this.opts.ragRegistry.closeSession(sessionId);
      },
    });
  }
}
```

Export from `packages/llm-agent-libs/src/index.ts`:

```ts
export { SessionGraph } from './session/session-graph.js';
export { SessionGraphFactory } from './session/session-graph-factory.js';
export type {
  SessionAgentParts,
  SessionGraphFactoryOptions,
  SessionGraphIdentity,
} from './session/session-graph-factory.js';
export { SessionRegistry } from './session/session-registry.js';
export type { SessionRegistryOptions } from './session/session-registry.js';
```

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/session/session-graph-factory.ts packages/llm-agent-libs/src/index.ts packages/llm-agent-libs/src/session/__tests__/session-graph-factory.test.ts
git commit -m "feat(session): SessionGraphFactory composes per-session graph from injected globals (no MCP reconnect / re-vectorize)"
```

---

### Task A7: `SessionRegistry` with TTL/LRU + drain semantics

Owns `Map<sessionId, SessionGraph>`, lazy-builds via `SessionGraphFactory.build`, and evicts idle/over-cap graphs respecting the refcount. **Drain semantics (spec A.4 / review MEDIUM):** `enforceCap` marks the LRU candidate for disposal even if pinned (instead of `break`); `release(sessionId)` disposes a marked graph when refcount hits 0; `release` uses a **non-creating lookup** (never `getOrCreate`, so it can't resurrect a removed session).

**Files:**
- Create: `packages/llm-agent-libs/src/session/session-registry.ts`
- Test: `packages/llm-agent-libs/src/session/__tests__/session-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/session/__tests__/session-registry.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../session-registry.js';
import { SessionGraph } from '../session-graph.js';
import { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';
import { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';

function fakeFactory(disposed: string[]) {
  return {
    build: async (identity: { sessionId: string }) =>
      new SessionGraph({
        sessionId: identity.sessionId,
        toolAvailability: new ToolAvailabilityRegistry(),
        pendingToolResults: new PendingToolResultsRegistry(),
        logger: new SessionRequestLogger(),
        dispose: async (id) => { disposed.push(id); },
      }),
  };
}

function makeRegistry(over: Partial<{ idleTtlMs: number; maxSessions: number }> = {}) {
  const disposed: string[] = [];
  const reg = new SessionRegistry({
    idleTtlMs: 10_000,
    maxSessions: 2,
    factory: fakeFactory(disposed),
    ...over,
  });
  return { reg, disposed };
}

test('acquire is lazy and stable per id', async () => {
  const { reg } = makeRegistry();
  const a = await reg.acquire('s1');
  const a2 = await reg.acquire('s1');
  assert.equal(a, a2);
  assert.equal(a.activeRequests, 2);
  assert.equal(reg.size, 1);
});

test('idle-TTL evicts only unpinned graphs and disposes', async () => {
  const { reg, disposed } = makeRegistry({ idleTtlMs: 0 });
  const g = await reg.acquire('s1'); // pinned (active=1)
  await reg.evictIdle();
  assert.deepEqual(disposed, []);   // pinned -> not evicted
  reg.release('s1');
  await reg.evictIdle();
  assert.deepEqual(disposed, ['s1']);
  assert.equal(reg.size, 0);
});

test('LRU cap evicts the least-recently-used unpinned graph', async () => {
  const { reg, disposed } = makeRegistry({ maxSessions: 2, idleTtlMs: 10_000 });
  await reg.acquire('s1'); reg.release('s1');
  await reg.acquire('s2'); reg.release('s2');
  await reg.acquire('s3'); reg.release('s3'); // over cap -> evict LRU (s1)
  await reg.flushEvictions();
  assert.deepEqual(disposed, ['s1']);
  assert.equal(reg.size, 2);
});

test('DRAIN: pinned LRU candidate over cap is marked, then disposed on release at refcount 0', async () => {
  const { reg, disposed } = makeRegistry({ maxSessions: 1, idleTtlMs: 10_000 });
  const g1 = await reg.acquire('s1');        // pinned (active=1)
  await reg.acquire('s2'); reg.release('s2'); // over cap; s1 pinned -> MARK s1, don't dispose yet
  await reg.flushEvictions();
  assert.deepEqual(disposed, [], 'pinned graph not disposed while in-flight');
  assert.equal(g1.markedForDisposal, true);
  reg.release('s1');                          // refcount hits 0 -> dispose now
  await reg.flushEvictions();
  assert.deepEqual(disposed, ['s1']);
  assert.equal(reg.size, 1); // only s2 remains
});

test('release uses a non-creating lookup (unknown session never resurrected)', () => {
  const { reg } = makeRegistry();
  reg.release('never-seen'); // must be a no-op, not create a graph
  assert.equal(reg.size, 0);
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/session/__tests__/session-registry.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/session/session-registry.ts
import type { SessionGraph } from './session-graph.js';
import type { SessionGraphIdentity } from './session-graph-factory.js';

/** Minimal seam over SessionGraphFactory so the registry is unit-testable. */
export interface SessionGraphSource {
  build(identity: SessionGraphIdentity): Promise<SessionGraph>;
}

export interface SessionRegistryOptions {
  /** Idle time before an unpinned graph is evicted. */
  idleTtlMs: number;
  /** Max live sessions before LRU eviction of unpinned graphs (drain if pinned). */
  maxSessions: number;
  factory: SessionGraphSource;
}

export class SessionRegistry {
  private readonly graphs = new Map<string, SessionGraph>();
  private readonly pending: Promise<void>[] = [];

  constructor(private readonly opts: SessionRegistryOptions) {}

  get size(): number { return this.graphs.size; }

  /** Lazy-build + pin. Each in-flight request increments the refcount (spec A.4). */
  async acquire(sessionId: string): Promise<SessionGraph> {
    let g = this.graphs.get(sessionId);
    if (!g) {
      g = await this.opts.factory.build({ sessionId });
      this.graphs.set(sessionId, g);
      this.enforceCap();
    }
    g.acquire();
    return g;
  }

  /**
   * Release one in-flight request. Non-creating lookup: an unknown/removed
   * sessionId is a no-op (never resurrect). Disposes a marked graph once idle.
   */
  release(sessionId: string): void {
    const g = this.graphs.get(sessionId);
    if (!g) return;
    g.release();
    if (g.markedForDisposal && !g.isPinned) {
      this.graphs.delete(sessionId);
      this.pending.push(g.dispose());
    }
  }

  /** Evict every unpinned graph idle longer than idleTtlMs. */
  async evictIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, g] of this.graphs) {
      if (!g.isPinned && now - g.lastUsedMs >= this.opts.idleTtlMs) {
        this.evictNow(id, g);
      }
    }
    await this.flushEvictions();
  }

  /** Resolve all in-flight dispose() calls (test + shutdown helper). */
  async flushEvictions(): Promise<void> {
    await Promise.all(this.pending.splice(0));
  }

  /** Dispose every graph (server shutdown). */
  async disposeAll(): Promise<void> {
    for (const [id, g] of this.graphs) {
      this.graphs.delete(id);
      this.pending.push(g.dispose());
    }
    await this.flushEvictions();
  }

  private enforceCap(): void {
    while (this.liveCount() > this.opts.maxSessions) {
      let lruId: string | undefined;
      let lruGraph: SessionGraph | undefined;
      let lruTime = Number.POSITIVE_INFINITY;
      for (const [id, g] of this.graphs) {
        if (g.markedForDisposal) continue; // already draining
        if (g.lastUsedMs < lruTime) {
          lruTime = g.lastUsedMs;
          lruId = id;
          lruGraph = g;
        }
      }
      if (!lruId || !lruGraph) break; // nothing left to mark
      if (lruGraph.isPinned) {
        // DRAIN: cannot dispose mid-run; mark and stop (release() finishes it).
        lruGraph.markForDisposal();
        break;
      }
      this.evictNow(lruId, lruGraph);
    }
  }

  /** Sessions that still count toward the cap (not yet draining). */
  private liveCount(): number {
    let n = 0;
    for (const g of this.graphs.values()) if (!g.markedForDisposal) n++;
    return n;
  }

  private evictNow(sessionId: string, g: SessionGraph): void {
    this.graphs.delete(sessionId);
    this.pending.push(g.dispose());
  }
}
```

- [ ] **Step 4: Run** the test — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/session/session-registry.ts packages/llm-agent-libs/src/session/__tests__/session-registry.test.ts
git commit -m "feat(session): SessionRegistry with idle-TTL + LRU + drain semantics (mark pinned, dispose on release)"
```

---

### Task A8: Wire the server to cookie identity + SessionGraphFactory + SessionRegistry

Build the GLOBAL handle once (`builder.build()` at `:783`), construct the `SessionGraphFactory` from its injected globals (`agentHandle.ragRegistry`, the global `toolsRag`, the connected MCP clients) and a `SessionRegistry`. In `_handle`: replace `x-session-id` (`:1343`) with the cookie resolver, `await lifecycle.acquire(sessionId)`, `Set-Cookie` when minted, run the request **on the session graph's agent** with `opts.sessionId = sessionId` + `opts.toolAvailability/pendingToolResults` from the graph, and `release` in `finally`. Start an idle-TTL sweep timer. Config from a new `session` block.

The factory's production `buildAgent` re-runs a `SmartAgentBuilder.build()` with `withMcpClients(globalMcpClients)` + `setToolsRag(globalToolsRag)` + `setRagRegistry(globalRagRegistry)` + `withRequestLogger(parts.logger)` + the same coordinator/DAG/subagent config the server already assembled — so the heavy connect/vectorize path is skipped (`builder.ts:880-882`).

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` (`build`: capture global MCP clients + toolsRag; build factory + registry + sweep timer; `_handle`: resolve/acquire/run-on-graph/release)
- Modify: server config type (`SmartServerConfig`) — add the optional `session` block.
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test** (unit on the extracted lifecycle helper)

```ts
// packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionLifecycle } from '../smart-server.js';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';

function makeRagRegistry() {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return reg;
}

test('first request mints a cookie; dispose closes session collections on the shared registry', async () => {
  const ragRegistry = makeRagRegistry();
  const lc = buildSessionLifecycle({
    idleTtlMs: 0,
    maxSessions: 100,
    cookieName: 'sid',
    mcpClients: [],
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async () => undefined as never,
  });

  const r = lc.resolve(undefined, false); // no cookie, not HTTPS
  assert.equal(r.minted, true);
  assert.match(r.setCookie ?? '', /^sid=/);

  const sid = r.identity.sessionId;
  await ragRegistry.createCollection({ providerName: 'mem', collectionName: 'c', scope: 'session', sessionId: sid });
  assert.ok(ragRegistry.get('c'));

  const g = await lc.acquire(sid);
  assert.equal(g.isPinned, true);
  lc.release(sid);
  await lc.evictIdle();

  assert.equal(ragRegistry.get('c'), undefined, 'session collection cleared on evict');
});

test('two no-cookie requests get distinct session ids (no shared default bucket)', () => {
  const lc = buildSessionLifecycle({
    idleTtlMs: 10_000, maxSessions: 100, cookieName: 'sid',
    mcpClients: [], toolsRag: undefined, ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined as never,
  });
  assert.notEqual(lc.resolve(undefined, false).identity.sessionId, lc.resolve(undefined, false).identity.sessionId);
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts` — Expected: FAIL (`buildSessionLifecycle` not exported).

- [ ] **Step 3: Implement `buildSessionLifecycle` and wire it**

Add the exported factory in `smart-server.ts` (keeps `_handle` thin + unit-testable):

```ts
import { SessionGraphFactory, SessionRegistry } from '@mcp-abap-adt/llm-agent-libs';
import type { SessionAgentParts } from '@mcp-abap-adt/llm-agent-libs';
import type { IMcpClient, IRag, IRagRegistry } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '@mcp-abap-adt/llm-agent-libs';
import { resolveSessionIdentity } from './session-identity-resolver.js';

export interface SessionLifecycleOptions {
  idleTtlMs: number;
  maxSessions: number;
  cookieName: string;
  mcpClients: IMcpClient[];
  toolsRag: IRag | undefined;
  ragRegistry: IRagRegistry;
  buildAgent: (parts: SessionAgentParts) => Promise<SmartAgent | undefined>;
}

export function buildSessionLifecycle(opts: SessionLifecycleOptions) {
  const factory = new SessionGraphFactory({
    mcpClients: opts.mcpClients,
    toolsRag: opts.toolsRag,
    ragRegistry: opts.ragRegistry,
    buildAgent: opts.buildAgent,
  });
  const registry = new SessionRegistry({
    idleTtlMs: opts.idleTtlMs,
    maxSessions: opts.maxSessions,
    factory,
  });
  return {
    resolve: (cookieHeader: string | undefined, isHttps: boolean) =>
      resolveSessionIdentity({
        cookieHeader,
        cookieName: opts.cookieName,
        maxAgeSeconds: Math.floor(opts.idleTtlMs / 1000),
        isHttps,
      }),
    acquire: (sessionId: string) => registry.acquire(sessionId),
    release: (sessionId: string) => registry.release(sessionId),
    evictIdle: () => registry.evictIdle(),
    disposeAll: () => registry.disposeAll(),
    registry,
  };
}
```

In `build()`, after `agentHandle = await builder.build()` (`:783`) and the destructure (`:784`), capture the globals and the per-session `buildAgent`. The global MCP clients are not currently surfaced on the handle; capture them from the builder path: the server already knows `toolsRag` (local var, `:484`/`:520`) and `agentHandle.ragRegistry` (Task A4). For MCP clients, pass `withMcpClients` from the *first* connected set — extract by having the server build its own MCP clients once via the builder and reuse. Concretely, add after the destructure:

```ts
    const { ragRegistry } = agentHandle;
    // GLOBAL toolsRag captured above as `toolsRag` (server local). GLOBAL MCP
    // clients: re-resolve from the builder's connected set. Expose them on the
    // handle (small builder change) OR re-use the server's own connection.
    const globalMcpClients = agentHandle.mcpClients ?? []; // see note
    const sessionCfg = this.cfg.session ?? {};
    const lifecycle = buildSessionLifecycle({
      idleTtlMs: sessionCfg.idleTtlMs ?? 7_200_000,
      maxSessions: sessionCfg.maxSessions ?? 1000,
      cookieName: sessionCfg.cookieName ?? 'sid',
      mcpClients: globalMcpClients,
      toolsRag,
      ragRegistry,
      buildAgent: async (parts) => {
        // Re-run the builder with the heavy globals INJECTED -> connect + tool
        // vectorization are skipped (builder.ts:880-882). Coordinator/DAG/subagent
        // config matches the server's primary build so the per-session pipeline
        // is equivalent (and MAY vary per session in future).
        const sub = this.buildSessionAgentBuilder(parts);
        const handle = await sub.build();
        return handle.agent;
      },
    });
    const sweepMs = Math.min(sessionCfg.idleTtlMs ?? 7_200_000, 60_000);
    const sweep = setInterval(() => { void lifecycle.evictIdle(); }, sweepMs);
    sweep.unref?.();
    closeFns.push(async () => { clearInterval(sweep); await lifecycle.disposeAll(); });
```

> Note (MCP clients on the handle): add `mcpClients` to `SmartAgentHandle` (mirror Task A4: it's the `mcpClients` local in `builder.ts` `return`) so the factory can inject them via `withMcpClients`. This is a one-line handle addition + one interface field.

Add the private helper `buildSessionAgentBuilder(parts)` to `SmartServerSmartAgent` that mirrors the primary `build()` builder assembly but injects globals and the session logger:

```ts
  private buildSessionAgentBuilder(parts: SessionAgentParts): SmartAgentBuilder {
    let b = new SmartAgentBuilder({
      agent: this.cfg.agent,
      prompts: this.cfg.prompts,
      skipModelValidation: this.cfg.skipModelValidation,
    })
      .withMainLlm(this._mainLlm)            // captured globals (hoist to fields in build())
      .withClassifierLlm(this._classifierLlm)
      .withLogger(this._fileLogger)
      .withMode(this.cfg.mode ?? 'smart')
      .withMcpClients(parts.mcpClients)      // SKIPS connect + re-vectorize
      .setRagRegistry(parts.ragRegistry)
      .withRequestLogger(parts.logger);      // per-session token-logger
    if (this._helperLlm) b = b.withHelperLlm(this._helperLlm);
    if (parts.toolsRag) b = b.setToolsRag(parts.toolsRag);
    if (this._subAgentRegistry) b = b.withSubAgents(this._subAgentRegistry);
    if (this._dagCoordinatorDeps) b = b.withDagCoordinator(this._dagCoordinatorDeps);
    return b;
  }
```

> Implementer note: in `build()`, hoist the LLM instances (`mainLlm`/`classifierLlm`/`helperLlm`), `fileLogger`, the subagent `registry`, and the resolved DAG-coordinator deps into instance fields (`this._mainLlm`, etc.) so `buildSessionAgentBuilder` can reuse them. These are already locals in `build()` — promote, don't rebuild. Workers in `registry` already share the parent `ragRegistry` after Phase B.

In `_handle`, replace `:1342-1343` and wrap the run:

```ts
    const traceId = randomUUID();
    const isHttps = (req.socket as { encrypted?: boolean }).encrypted === true
      || (req.headers['x-forwarded-proto'] === 'https');
    const resolved = lifecycle.resolve(req.headers['cookie'], isHttps);
    const sessionId = resolved.identity.sessionId;
    if (resolved.minted && resolved.setCookie) res.setHeader('Set-Cookie', resolved.setCookie);
    const graph = await lifecycle.acquire(sessionId);
    try {
      // ... existing request handling. Run on the per-session agent:
      //   const runAgent = graph.agent ?? smartAgent;   // graph.agent is per-session
      // and inject the graph's sessionId-keyed registries + sessionId into opts:
      //   opts.sessionId = sessionId;
      //   opts.toolAvailability = graph.toolAvailability;
      //   opts.pendingToolResults = graph.pendingToolResults;
      //   opts.trace = { traceId };
    } finally {
      lifecycle.release(sessionId);
    }
```

> Implementer note: thread `graph` and `lifecycle` into `_handle` (they live on the server instance set in `build()`). The endpoints that run the agent (`/v1/chat/completions` etc.) must use `graph.agent` and the `opts` additions above. `opts.sessionId = sessionId` guarantees `ctx.sessionId == cookie session id` (verified seam: `default-pipeline.ts:388`, `agent.ts:672`).

Add the `session` block to the server config interface (`SmartServerConfig`):

```ts
  session?: {
    idleTtlMs?: number;     // default 7_200_000 (2h)
    maxSessions?: number;   // default 1000
    cookieName?: string;    // default 'sid'
  };
```

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent/src/interfaces/builder.ts packages/llm-agent-libs/src/builder.ts packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts
git commit -m "feat(session): wire server to cookie identity + SessionGraphFactory + SessionRegistry (Set-Cookie, per-session agent, acquire/release, TTL sweep, closeSession on evict)"
```

---

### Task A9: Phase-A provability tests (spec A.6)

Covers: distinct graphs per session, single dispose on evict, `ctx.sessionId == cookie id`, and reentrancy (two concurrent same-session runs produce independent results with separate per-`traceId` deltas).

**Files:**
- Test: `packages/llm-agent-libs/src/session/__tests__/session-provability.test.ts`
- Test: `packages/llm-agent-libs/src/session/__tests__/session-reentrancy.test.ts`

- [ ] **Step 1: Write the provability tests**

```ts
// packages/llm-agent-libs/src/session/__tests__/session-provability.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../session-registry.js';
import { SessionGraph } from '../session-graph.js';
import { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';
import { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';

function factory(disposed: string[]) {
  return {
    build: async (id: { sessionId: string }) =>
      new SessionGraph({
        sessionId: id.sessionId,
        toolAvailability: new ToolAvailabilityRegistry(),
        pendingToolResults: new PendingToolResultsRegistry(),
        logger: new SessionRequestLogger(),
        dispose: async (s) => { disposed.push(s); },
      }),
  };
}

test('two sessions get distinct graphs (no shared default bucket)', async () => {
  const reg = new SessionRegistry({ idleTtlMs: 10_000, maxSessions: 100, factory: factory([]) });
  const a = await reg.acquire('s1'); reg.release('s1');
  const b = await reg.acquire('s2'); reg.release('s2');
  assert.notEqual(a, b);
});

test('evict triggers dispose exactly once per session', async () => {
  const disposed: string[] = [];
  const reg = new SessionRegistry({ idleTtlMs: 0, maxSessions: 100, factory: factory(disposed) });
  await reg.acquire('s1'); reg.release('s1');
  await reg.evictIdle();
  await reg.evictIdle();
  assert.deepEqual(disposed, ['s1']);
});
```

```ts
// packages/llm-agent-libs/src/session/__tests__/session-reentrancy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';

// Reentrancy contract (spec A.5/A.6): two concurrent runs of ONE session share
// the session logger but keep separate per-traceId deltas — no cross-talk.
test('concurrent same-session requests keep independent per-traceId deltas', () => {
  const logger = new SessionRequestLogger(); // shared by the session graph
  logger.startRequest('trace-A');
  logger.startRequest('trace-B');
  logger.logLlmCall({ component: 'tool-loop', model: 'm', promptTokens: 11, completionTokens: 0, totalTokens: 11, durationMs: 1, requestId: 'trace-A' });
  logger.logLlmCall({ component: 'tool-loop', model: 'm', promptTokens: 22, completionTokens: 0, totalTokens: 22, durationMs: 1, requestId: 'trace-B' });
  assert.equal(logger.getSummary('trace-A').byComponent['tool-loop'].totalTokens, 11);
  assert.equal(logger.getSummary('trace-B').byComponent['tool-loop'].totalTokens, 22);
  // session-cumulative sees both
  assert.equal(logger.getSummary().byComponent['tool-loop'].totalTokens, 33);
});
```

> The `ctx.sessionId == cookie id` and malformed-cookie-mint guarantees are already proven by A2 (resolver) + A8 (`buildSessionLifecycle` sets `opts.sessionId = resolved.identity.sessionId`, and `ctx.sessionId = options?.sessionId` at `default-pipeline.ts:388`). The reentrancy test depends on `SessionRequestLogger` (C1) — pull C1 forward or run this suite after C1.

- [ ] **Step 2: Run** both files — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/session/__tests__/session-provability.test.ts packages/llm-agent-libs/src/session/__tests__/session-reentrancy.test.ts
git commit -m "test(session): phase-A provability — isolation, single dispose, reentrant per-traceId deltas"
```

---

## PHASE B — Worker RAG sharing

### Task B1: Subagents share the parent RAG registry

Today `buildSubAgent` (`smart-server.ts:1007-1018`) builds an isolated RAG via `makeRag(subCfg.rag)`. Replace with the shared parent `IRagRegistry` (`setRagRegistry`) so session/user/global collections written at the top level are visible to workers; the per-call scope filter (`rag-query.ts:73-86`) isolates by `ctx.sessionId`/`ctx.options.userId`. A worker's own declared store registers INTO the shared registry under its namespace.

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` — `buildSubAgent` gains `parentRagRegistry: IRagRegistry`; call site (`:612`) passes `agentHandle.ragRegistry`.
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
import { resolveSubAgentRagRegistry } from '../smart-server.js';

test('subagent reuses the parent registry instead of a fresh one', () => {
  const parent = new SimpleRagRegistry();
  assert.equal(resolveSubAgentRagRegistry({ parentRagRegistry: parent, subHasOwnStore: false }), parent);
});

test('subagent with its own declared store still gets the parent registry', () => {
  const parent = new SimpleRagRegistry();
  assert.equal(resolveSubAgentRagRegistry({ parentRagRegistry: parent, subHasOwnStore: true }), parent);
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts` — Expected: FAIL (`resolveSubAgentRagRegistry` not exported).

- [ ] **Step 3: Implement**

Add the resolver and use it in `buildSubAgent`:

```ts
import type { IRagRegistry } from '@mcp-abap-adt/llm-agent';

export function resolveSubAgentRagRegistry(input: {
  parentRagRegistry: IRagRegistry;
  subHasOwnStore: boolean;
}): IRagRegistry {
  // Always share the parent registry: session/user/global collections created
  // at the top level become visible to the worker; the per-call scope filter
  // isolates by ctx.sessionId/ctx.options.userId. A worker's own declared store
  // is registered INTO this same registry under its namespace.
  return input.parentRagRegistry;
}
```

In `buildSubAgent`, add `parentRagRegistry: IRagRegistry` param and replace the isolated-RAG block (`:1007-1018`) with:

```ts
    subBuilder = subBuilder.setRagRegistry(
      resolveSubAgentRagRegistry({ parentRagRegistry, subHasOwnStore: Boolean(subCfg.rag) }),
    );
    // Only build an isolated tools store when the subagent declares one; it is
    // registered into the shared registry under the subagent's namespace.
    if (subCfg.rag) {
      const ragOptions = { injectedEmbedder: subCfg.embedder, extraFactories: embedderFactories };
      subBuilder = subBuilder.setToolsRag(await makeRag(subCfg.rag, ragOptions));
    }
```

At the call site (`:612`), pass `agentHandle.ragRegistry` (available after Task A4). Since subagents are built *before* `agentHandle` exists, hoist the `ragRegistry` resolution: the server should construct the `SimpleRagRegistry` once up front (or read it back via a two-phase build). Simplest: build the primary handle first to obtain `ragRegistry`, then build subagents and `withSubAgents`, then re-resolve the DAG. Implementer note: if the current ordering builds subagents before `builder.build()`, pass a freshly-constructed `SimpleRagRegistry` into `builder.setRagRegistry(...)` AND into `buildSubAgent` so both share the same instance from the start.

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts
git commit -m "feat(rag): subagents share the parent RAG registry (session/user/global collections visible to workers)"
```

---

### Task B2: Phase-B provability — session artifact visibility (spec B.6)

CONCRETE test (no placeholder): register the in-memory provider, `createCollection` scope:session sessionId `'s1'`, upsert a doc via the editor, query with `ragFilter.sessionId='s1'` → 1 result, `='s2'` → 0. Mirrors `smart-agent-close-session.test.ts` setup.

**Files:**
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/session-artifact-visibility.test.ts`

- [ ] **Step 1: Write the test**

```ts
// packages/llm-agent-server/src/smart-agent/__tests__/session-artifact-visibility.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';

test('session artifact written via shared registry is visible under its sessionId, isolated from another', async () => {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);

  // Create a session-scoped collection for s1 (as the SessionGraph would).
  const created = await reg.createCollection({
    providerName: 'mem',
    collectionName: 'session-artifacts',
    scope: 'session',
    sessionId: 's1',
  });
  assert.ok(created.ok, `createCollection failed: ${!created.ok && created.error.message}`);

  // Upsert a doc via the registry editor (what a worker/coordinator would write).
  const editor = reg.getEditor('session-artifacts');
  assert.ok(editor, 'editor present for session collection');
  const up = await editor.upsertRaw('skill:greet', 'a session-scoped skill artifact', {});
  assert.ok(up.ok, `upsert failed: ${!up.ok && up.error.message}`);

  const store = reg.get('session-artifacts');
  assert.ok(store, 'store present');

  // Query under the matching session -> 1 result; under a different session -> 0.
  const embed = store.embedder ? await store.embedder.embed('greet') : undefined;
  const queryVec = embed?.vector ?? new Array(8).fill(0); // in-memory provider tolerant
  const hit = await store.query(queryVec, 10, { sessionId: 's1', ragFilter: { sessionId: 's1' } });
  const miss = await store.query(queryVec, 10, { sessionId: 's2', ragFilter: { sessionId: 's2' } });
  assert.ok(hit.ok && hit.value.length === 1, 'visible under matching sessionId');
  assert.ok(miss.ok && miss.value.length === 0, 'isolated under different sessionId');
});
```

> Implementer note: match the exact in-memory editor/query surface used by `smart-agent-close-session.test.ts` and `InMemoryRag`. If the in-memory store needs a real embedding, reuse the test embedder from `testing/index.ts`; the only load-bearing assertions are count 1 (matching sessionId) vs 0 (other). Adjust the embedder/query-vector lines to whatever `InMemoryRag.query` expects.

- [ ] **Step 2: Run** the test — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/__tests__/session-artifact-visibility.test.ts
git commit -m "test(rag): phase-B provability — session artifact visible under its sessionId, isolated per session"
```

---

## PHASE C — Session token-rollup

### Task C1: `SessionRequestLogger` (session-cumulative + per-`traceId` delta)

Implements `IRequestLogger`. Keeps a session-cumulative tally across requests plus a per-`traceId` delta map (so concurrent requests don't stomp each other and per-response usage is exact). `startRequest(requestId)` / `endRequest(requestId)` / `getSummary(requestId?)` are keyed; `getSummary()` (no arg) returns session-cumulative.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/request-logger.ts` — `requestId?` on entries + `startRequest/endRequest/getSummary(requestId?)`.
- Create: `packages/llm-agent-libs/src/logger/session-request-logger.ts` (incl. `aggregate` + `summaryToUsage`).
- Test: `packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '../session-request-logger.js';

const call = (component: string, total: number, requestId: string) => ({
  component: component as never, model: 'm', promptTokens: total, completionTokens: 0,
  totalTokens: total, durationMs: 1, requestId,
});

test('per-traceId delta isolates concurrent requests', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.startRequest('r2');
  log.logLlmCall(call('tool-loop', 10, 'r1'));
  log.logLlmCall(call('tool-loop', 5, 'r2'));
  assert.equal(log.getSummary('r1').byComponent['tool-loop'].totalTokens, 10);
  assert.equal(log.getSummary('r2').byComponent['tool-loop'].totalTokens, 5);
});

test('session-cumulative sums across requests and survives endRequest', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.logLlmCall(call('tool-loop', 10, 'r1'));
  log.endRequest('r1');
  log.startRequest('r2');
  log.logLlmCall(call('tool-loop', 7, 'r2'));
  log.endRequest('r2');
  assert.equal(log.getSummary().byComponent['tool-loop'].totalTokens, 17);
});

test('reset clears session-cumulative + deltas (called on session evict)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.logLlmCall(call('tool-loop', 10, 'r1'));
  log.reset();
  assert.equal(Object.keys(log.getSummary().byComponent).length, 0);
});

test('calls without a requestId still land in session-cumulative', () => {
  const log = new SessionRequestLogger();
  log.logLlmCall({ component: 'embedding' as never, model: 'e', promptTokens: 4, completionTokens: 0, totalTokens: 4, durationMs: 1 });
  assert.equal(log.getSummary().byComponent['embedding'].totalTokens, 4);
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Widen the interface in `packages/llm-agent/src/interfaces/request-logger.ts`:

```ts
export interface LlmCallEntry {
  component: LlmComponent;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  estimated?: boolean;
  scope?: 'initialization' | 'request';
  detail?: string;
  /** Request correlation id (the server's traceId). Routes the entry to the
   *  per-request delta; absent → session-cumulative only. */
  requestId?: string;
}

export interface IRequestLogger {
  logLlmCall(entry: LlmCallEntry): void;
  logRagQuery(entry: RagQueryEntry & { requestId?: string }): void;
  logToolCall(entry: ToolCallEntry & { requestId?: string }): void;
  startRequest(requestId?: string): void;
  endRequest(requestId?: string): void;
  getSummary(requestId?: string): RequestSummary;
  reset(): void;
}
```

> `DefaultRequestLogger` and `NoopRequestLogger` keep working: update their method signatures to accept the optional arg (ignore it — no behavior change). Build will flag every implementer; fix each by widening the signature only.

Implement `SessionRequestLogger`:

```ts
// packages/llm-agent-libs/src/logger/session-request-logger.ts
import type {
  IRequestLogger,
  LlmCallEntry,
  RagQueryEntry,
  RequestSummary,
  ToolCallEntry,
  LlmUsage,
} from '@mcp-abap-adt/llm-agent';

interface Bucket {
  llm: LlmCallEntry[];
  rag: number;
  tool: number;
}
function emptyBucket(): Bucket { return { llm: [], rag: 0, tool: 0 }; }

/** Shared aggregation (DRY with DefaultRequestLogger.getSummary). */
export function aggregate(b: Bucket): RequestSummary {
  const byModel: RequestSummary['byModel'] = {};
  const byComponent: RequestSummary['byComponent'] = {};
  const byCategory: RequestSummary['byCategory'] = {};
  let totalDurationMs = 0;
  for (const c of b.llm) {
    totalDurationMs += c.durationMs;
    const m = (byModel[c.model] ??= { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 });
    m.promptTokens += c.promptTokens; m.completionTokens += c.completionTokens; m.totalTokens += c.totalTokens; m.requests++;
    const comp = (byComponent[c.component] ??= { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 });
    comp.promptTokens += c.promptTokens; comp.completionTokens += c.completionTokens; comp.totalTokens += c.totalTokens; comp.requests++;
    const catKey = c.scope ?? 'request';
    const cat = (byCategory[catKey] ??= { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 });
    cat.promptTokens += c.promptTokens; cat.completionTokens += c.completionTokens; cat.totalTokens += c.totalTokens; cat.requests++;
  }
  return { byModel, byComponent, byCategory, ragQueries: b.rag, toolCalls: b.tool, totalDurationMs };
}

/** Sum a summary's components into a flat usage triple for response.usage. */
export function summaryToUsage(s: RequestSummary): LlmUsage {
  let promptTokens = 0, completionTokens = 0, totalTokens = 0;
  for (const v of Object.values(s.byComponent)) {
    promptTokens += v.promptTokens; completionTokens += v.completionTokens; totalTokens += v.totalTokens;
  }
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * One logger per SessionGraph. Two axes (spec C.2):
 *  - session-cumulative (survives across requests, for /v1/usage),
 *  - per-traceId delta (for response.usage; keyed so concurrent requests on the
 *    same session never stomp each other).
 */
export class SessionRequestLogger implements IRequestLogger {
  private readonly cumulative = emptyBucket();
  private readonly deltas = new Map<string, Bucket>();

  startRequest(requestId?: string): void {
    if (requestId) this.deltas.set(requestId, emptyBucket());
  }
  endRequest(requestId?: string): void {
    if (requestId) this.deltas.delete(requestId);
  }

  logLlmCall(entry: LlmCallEntry): void {
    this.cumulative.llm.push(entry);
    if (entry.requestId) (this.deltas.get(entry.requestId) ?? this.startGet(entry.requestId)).llm.push(entry);
  }
  logRagQuery(entry: RagQueryEntry & { requestId?: string }): void {
    this.cumulative.rag++;
    if (entry.requestId) (this.deltas.get(entry.requestId) ?? this.startGet(entry.requestId)).rag++;
  }
  logToolCall(entry: ToolCallEntry & { requestId?: string }): void {
    this.cumulative.tool++;
    if (entry.requestId) (this.deltas.get(entry.requestId) ?? this.startGet(entry.requestId)).tool++;
  }

  getSummary(requestId?: string): RequestSummary {
    if (requestId) return aggregate(this.deltas.get(requestId) ?? emptyBucket());
    return aggregate(this.cumulative);
  }

  reset(): void {
    this.cumulative.llm.length = 0;
    this.cumulative.rag = 0;
    this.cumulative.tool = 0;
    this.deltas.clear();
  }

  private startGet(requestId: string): Bucket {
    const b = emptyBucket();
    this.deltas.set(requestId, b);
    return b;
  }
}
```

> Implementer note: match the exact `RequestSummary`/bucket shape from `DefaultRequestLogger.getSummary` (grep its return). Extract the shared body into `aggregate` and have `DefaultRequestLogger` call it too if trivial; otherwise keep `aggregate` local to the session logger but mirror the shape exactly so `/v1/usage` payloads stay identical.

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS (4 tests); build clean (after widening all `IRequestLogger` impls).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/request-logger.ts packages/llm-agent-libs/src/logger/session-request-logger.ts packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts
git commit -m "feat(usage): SessionRequestLogger — session-cumulative + per-traceId request delta"
```

---

### Task C2: The SessionGraph logger flows into the per-session agent + workers

A8's `buildSessionAgentBuilder` already passes `parts.logger` via `withRequestLogger`, so the per-session `SmartAgent` constructor (`agent.ts:260`) uses the session logger, and the pipeline (`builder.ts:1286`) + classifier (`builder.ts:1129`) + workers (subagents built with `withSubAgents`, sharing the same builder-injected `ragRegistry` and — via the DAG path — the same parent agent's logger) all log into it. This task verifies + locks that wiring.

**Files:**
- Test: `packages/llm-agent-libs/src/session/__tests__/session-logger-wiring.test.ts`

- [ ] **Step 1: Write the test**

```ts
// packages/llm-agent-libs/src/session/__tests__/session-logger-wiring.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionGraphFactory } from '../session-graph-factory.js';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';

test('the logger handed to buildAgent is the SAME instance the graph exposes', async () => {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);

  let seenLogger: unknown;
  const factory = new SessionGraphFactory({
    mcpClients: [],
    toolsRag: undefined,
    ragRegistry: reg,
    buildAgent: async (parts) => { seenLogger = parts.logger; return undefined as never; },
  });
  const g = await factory.build({ sessionId: 's1' });
  assert.equal(seenLogger, g.logger, 'buildAgent receives the graph’s session logger');
});
```

- [ ] **Step 2: Run** the test — Expected: PASS (the factory already passes `logger` into `buildAgent`, C1+A6 in place).

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/session/__tests__/session-logger-wiring.test.ts
git commit -m "test(usage): per-session token-logger flows into the session agent (and workers via the builder)"
```

---

### Task C3: Propagate `traceId` as `requestId` into every token-log entry

Without this, the per-`traceId` delta and non-zero per-response usage stay empty. Add `requestId: ctx.options?.trace?.traceId` (or the agent's `traceId`) to every `logLlmCall`/`logToolCall` at the verified sites.

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts:505` (`logLlmCall`)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/translate.ts:46` (`logLlmCall`)
- Modify: `packages/llm-agent-libs/src/classifier/llm-classifier.ts:144` (`logLlmCall`)
- Modify: `packages/llm-agent-libs/src/agent.ts:1961` (helper `logLlmCall`)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/rag-query.ts:90` (`logRagQuery`)
- Test: `packages/llm-agent-libs/src/logger/__tests__/traceid-propagation.test.ts`

- [ ] **Step 1: Write the failing test** (uses a recording logger fed through tool-loop's log call)

```ts
// packages/llm-agent-libs/src/logger/__tests__/traceid-propagation.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '../session-request-logger.js';

// Contract test: when handlers attach ctx.options.trace.traceId as requestId,
// the per-traceId delta is non-empty. We simulate the handler call shape here;
// the real wiring is asserted by the integration suite (C5).
test('a logLlmCall carrying requestId lands in that traceId delta', () => {
  const log = new SessionRequestLogger();
  const traceId = 'trace-xyz';
  log.startRequest(traceId);
  // shape produced by tool-loop after the fix:
  log.logLlmCall({ component: 'tool-loop' as never, model: 'm', promptTokens: 12, completionTokens: 3, totalTokens: 15, durationMs: 2, requestId: traceId });
  assert.equal(log.getSummary(traceId).byComponent['tool-loop'].totalTokens, 15);
  assert.equal(log.getSummary(traceId).byComponent['tool-loop'].completionTokens, 3);
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/logger/__tests__/traceid-propagation.test.ts` — Expected: PASS already at the logger level (C1). The real failure is at the handlers (they don't set `requestId` yet); the test documents the contract the edits must satisfy. Proceed to wire the handlers.

- [ ] **Step 3: Implement — add `requestId` at each site**

At `tool-loop.ts:505` (inside the `ctx.requestLogger.logLlmCall({...})`):

```ts
      ctx.requestLogger.logLlmCall({
        component: 'tool-loop',
        model: ctx.mainLlm.model ?? 'unknown',
        promptTokens: iterPromptTokens,
        completionTokens: iterCompletionTokens,
        totalTokens: iterTotalTokens,
        durationMs: llmCallDuration,
        requestId: ctx.options?.trace?.traceId,
      });
```

At `translate.ts:46`:

```ts
    ctx.requestLogger.logLlmCall({
      component: 'translate',
      model: llm.model ?? 'unknown',
      promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
      completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
      totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
      durationMs: Date.now() - chatStart,
      requestId: ctx.options?.trace?.traceId,
    });
```

At `llm-classifier.ts:144` (the classifier receives `options` in `classify`): add `requestId: options?.trace?.traceId` to the `logLlmCall` object.

At `agent.ts:1961` (helper summarizer): the method runs inside `process` where `traceId` is in scope (`agent.ts:642`). Pass `traceId` into the summarizer helper (add a param) and add `requestId: traceId` to the `logLlmCall`. If threading the param is awkward, read it from the `opts?.trace?.traceId` already available in that helper's `opts`.

At `rag-query.ts:90` (the `logRagQuery`): add `requestId: ctx.options?.trace?.traceId`.

> Verify `CallOptions.trace.traceId` is the field name (`types.ts:18,24`: `TraceContext { traceId }`, `CallOptions { trace?: TraceContext }`). `ctx.options` is `CallOptions | undefined` (`context.ts:75`).

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts packages/llm-agent-libs/src/pipeline/handlers/translate.ts packages/llm-agent-libs/src/classifier/llm-classifier.ts packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/pipeline/handlers/rag-query.ts packages/llm-agent-libs/src/logger/__tests__/traceid-propagation.test.ts
git commit -m "feat(usage): propagate traceId as requestId into every token-log entry (tool-loop, translate, classifier, helper, rag-query)"
```

---

### Task C4: Non-zero per-response usage from the request delta

Populate `response.usage` from `requestLogger.getSummary(traceId)` so the OpenAI/Anthropic adapter emits real numbers (today the coordinator path leaves it `{0,0,0}`). Also call `startRequest(traceId)` / `endRequest(traceId)` with the request's `traceId`.

**Files:**
- Modify: `packages/llm-agent-libs/src/agent.ts:680` (`startRequest(traceId)`), `:1083` (`endRequest(traceId)`), and the response-assembly sites that set `usage` (`:1582`, plus the coordinator final emit) — use `summaryToUsage(this.requestLogger.getSummary(traceId))`.
- Test: `packages/llm-agent-libs/src/logger/__tests__/usage-summary-totals.test.ts`

- [ ] **Step 1: Write the failing test** (unit on the totals helper)

```ts
// packages/llm-agent-libs/src/logger/__tests__/usage-summary-totals.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryToUsage } from '../session-request-logger.js';

test('summaryToUsage sums all components into prompt/completion/total', () => {
  const usage = summaryToUsage({
    byModel: {}, byCategory: {}, ragQueries: 0, toolCalls: 0, totalDurationMs: 0,
    byComponent: {
      'tool-loop': { promptTokens: 100, completionTokens: 40, totalTokens: 140, requests: 1 },
      translate: { promptTokens: 10, completionTokens: 4, totalTokens: 14, requests: 1 },
    },
  });
  assert.deepEqual(usage, { promptTokens: 110, completionTokens: 44, totalTokens: 154 });
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/logger/__tests__/usage-summary-totals.test.ts` — Expected: PASS at helper level (C1 already exports `summaryToUsage`); if it fails, `summaryToUsage` isn't exported — add it.

- [ ] **Step 3: Implement**

In `agent.ts`:
- `:680` → `this.requestLogger.startRequest(traceId);`
- `:1083` → `this.requestLogger.endRequest(traceId);`
- At the response-assembly site(s) where `usage` is built (e.g. `:1582`, and the coordinator-mode final yield), set the usage triple from the delta:

```ts
        const delta = this.requestLogger.getSummary(traceId);
        const deltaUsage = summaryToUsage(delta);
        // ... existing yield, with usage merged:
        usage: { ...deltaUsage, models: delta.byModel },
```

Import `summaryToUsage` from `./logger/session-request-logger.js`. Keep the existing `byModel` (`:1590`) but source the totals from `deltaUsage` so per-response usage is non-zero. Verify `openai-adapter.ts:133` maps `response.usage` → `prompt_tokens/completion_tokens/total_tokens` (read it to confirm; no change expected).

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/logger/__tests__/usage-summary-totals.test.ts
git commit -m "feat(usage): non-zero per-response usage from the per-traceId request delta"
```

---

### Task C5: `/v1/usage` reports per-session; reset on evict

`/v1/usage` returns the current session's cumulative summary (resolve the session from the cookie like `_handle`). Session-cumulative resets when the graph is evicted (already wired: `SessionGraph.dispose` calls `logger.reset()`, A3).

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:1118` — `/v1/usage` resolves the session graph and returns `graph.logger.getSummary()`.
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/usage-per-session.test.ts`

- [ ] **Step 1: Write the failing test** (two sessions accumulate independently; evicting one resets only its tally)

```ts
// packages/llm-agent-server/src/smart-agent/__tests__/usage-per-session.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionLifecycle } from '../smart-server.js';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';

function rag() {
  const p = new SimpleRagProviderRegistry();
  p.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const r = new SimpleRagRegistry();
  r.setProviderRegistry(p);
  return r;
}

test('per-session usage is independent and resets on evict', async () => {
  const lc = buildSessionLifecycle({
    idleTtlMs: 0, maxSessions: 100, cookieName: 'sid',
    mcpClients: [], toolsRag: undefined, ragRegistry: rag(),
    buildAgent: async () => undefined as never,
  });
  const g1 = await lc.acquire('s1');
  const g2 = await lc.acquire('s2');
  g1.logger.startRequest('r1');
  g1.logger.logLlmCall({ component: 'tool-loop' as never, model: 'm', promptTokens: 10, completionTokens: 0, totalTokens: 10, durationMs: 1, requestId: 'r1' });
  g2.logger.startRequest('r2');
  g2.logger.logLlmCall({ component: 'tool-loop' as never, model: 'm', promptTokens: 3, completionTokens: 0, totalTokens: 3, durationMs: 1, requestId: 'r2' });
  assert.equal(g1.logger.getSummary().byComponent['tool-loop'].totalTokens, 10);
  assert.equal(g2.logger.getSummary().byComponent['tool-loop'].totalTokens, 3);

  lc.release('s1');
  await lc.evictIdle(); // idleTtlMs:0 -> evicts unpinned; g2 still pinned (active=1)
  // g1 disposed -> logger.reset(); g2 untouched.
  assert.equal(g2.logger.getSummary().byComponent['tool-loop'].totalTokens, 3);
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/usage-per-session.test.ts` — Expected: FAIL until C1+A3+A8 land; then PASS.

- [ ] **Step 3: Implement** the `/v1/usage` per-session read at `smart-server.ts:1118`:

```ts
    if (req.method === 'GET' && urlPath === '/v1/usage') {
      const isHttps = (req.socket as { encrypted?: boolean }).encrypted === true
        || (req.headers['x-forwarded-proto'] === 'https');
      const resolved = lifecycle.resolve(req.headers['cookie'], isHttps);
      if (resolved.minted && resolved.setCookie) res.setHeader('Set-Cookie', resolved.setCookie);
      const graph = await lifecycle.acquire(resolved.identity.sessionId);
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(graph.logger.getSummary()));
      } finally {
        lifecycle.release(resolved.identity.sessionId);
      }
      return;
    }
```

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/usage-per-session.test.ts
git commit -m "feat(usage): /v1/usage per-session, reset on session evict"
```

---

### Task C6: External-retrieval honesty (spec C.4)

A consumer-provided MCP retrieval tool is logged as a `toolCall`, never as our LLM/embedding tokens.

**Files:**
- Test: `packages/llm-agent-libs/src/logger/__tests__/external-retrieval-not-counted.test.ts`

- [ ] **Step 1: Write the test**

```ts
// packages/llm-agent-libs/src/logger/__tests__/external-retrieval-not-counted.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '../session-request-logger.js';

test('a consumer MCP retrieval tool call is not counted as our tokens', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.logToolCall({ toolName: 'consumer_rag_search', success: true, durationMs: 5, cached: false, requestId: 'r1' });
  const s = log.getSummary('r1');
  assert.equal(s.toolCalls, 1);
  assert.equal(Object.keys(s.byComponent).length, 0); // no token attribution
});
```

> Implementer note: match `ToolCallEntry`'s exact field names (grep `request-logger.ts`); the load-bearing assertions are `toolCalls === 1` and `byComponent` empty.

- [ ] **Step 2: Run** the test — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/logger/__tests__/external-retrieval-not-counted.test.ts
git commit -m "test(usage): external MCP retrieval logged as tool call, never as our tokens"
```

---

## Final steps (after all phases)

- [ ] **Lint + full build:** `npm run lint && npm run build` — Expected: clean.
- [ ] **Run all new suites:**
  - `npx tsx --test packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts`
  - `npx tsx --test packages/llm-agent-libs/src/session/__tests__/*.test.ts`
  - `npx tsx --test packages/llm-agent-libs/src/logger/__tests__/*.test.ts`
  - `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts packages/llm-agent-server/src/smart-agent/__tests__/session-artifact-visibility.test.ts packages/llm-agent-server/src/smart-agent/__tests__/usage-per-session.test.ts`
  - Expected: all PASS.
- [ ] **Smoke:** `npm run test` (build + start) — server boots, mints a cookie on first `/v1/chat/completions`, `/v1/usage` reflects the session.
- [ ] **Docs:** update `docs/ARCHITECTURE.md` (SessionGraphFactory + global-vs-per-session table + scoping), `docs/QUICK_START.md` (cookie session note + `session:` config block), `docs/EXAMPLES.md` (YAML `session:` block). No release/version bump here.
- [ ] **Delete this plan + the spec** once the epic is merged (repo convention: plans/specs live only while active).

---

## Self-Review notes — spec requirement → task mapping

- **A.1 Identity (cookie mint/validate, Set-Cookie, unique id, opaque UUID, HttpOnly/SameSite=Lax/Path/Max-Age/Secure-on-HTTPS, `^[A-Za-z0-9-]{1,128}$`, malformed→mint):** A1 (type) + A2 (resolver, all attributes + validation + distinct mints) + A8 (server wiring sends Set-Cookie, HTTPS detection).
- **A.2 Per-session graph + `SessionGraphFactory` (compose from injected globals, no MCP reconnect / re-vectorize; owns pipeline/interpreter/coordinator/roles/workers/MCP-server/logger/registries):** A3 (graph) + A6 (factory, `withMcpClients` skips connect+vectorize per `builder.ts:880-882`, `setToolsRag`/`setRagRegistry`/`withRequestLogger`) + A8 (`buildSessionAgentBuilder` mirrors server config) + A4 (`ragRegistry` on handle for injection) + A5 (registries from `CallOptions`).
- **A.3 RAG scoping (reuse per-call filter, no view objects; guarantee `ctx.sessionId`==cookie id; create/close via existing registry):** A8 (`opts.sessionId = cookie id` → `default-pipeline.ts:388`) + A6 (`dispose` → existing `closeSession`); reuse `rag-query.ts:73-86` unchanged.
- **A.4 Lifecycle (idle-TTL 2h default + LRU cap, all configurable; refcount pin; DRAIN mark-and-dispose; session-scope cleared on evict, user/global survive):** A7 (TTL/LRU + drain + non-creating release) + A3 (refcount + markForDisposal + idempotent dispose) + A8 (config block defaults, sweep timer, dispose→closeSession which only removes scope:session — `agent.ts:408-420` semantics).
- **A.5 Concurrency / reentrancy (shared instances reentrant; per-run state in PipelineContext; logger delta keyed by traceId):** A3/A7 (refcount allows concurrency) + A9 reentrancy test + C1 (traceId-keyed delta) + verified seam (per-run state already in `PipelineContext`, `default-pipeline.ts:386-435`).
- **A.6 Provability (two sessions isolated; evict clears only session-scope; unique mint + persistence; logger sums+resets; malformed→mint; `ctx.sessionId`==cookie id; reentrancy):** A9 (isolation, single dispose, reentrancy) + A2 (malformed→mint, distinct mints) + A8 lifecycle test (dispose clears session collection; distinct ids) + B2 (isolation across sessions) + C5 (logger sums + reset).
- **B.3 Sources / B.4 per-subagent store map / B.5 buildSubAgent fix (share parent registry, drop isolated makeRag):** B1 (`resolveSubAgentRagRegistry` + `setRagRegistry`, own store registers into shared registry). External customer RAG / consumer-MCP are reuse-only (no new code) per spec Reuse section.
- **B.6 Provability (session artifact visible across workers, isolated per session; tool-selection vs global catalog):** B2 (concrete in-memory createCollection + upsert + query: 1 for s1, 0 for s2) — mirrors `smart-agent-close-session.test.ts`.
- **C.1 One logger per graph (coordinator + workers):** C1 (logger) + A6/A8 (`withRequestLogger(parts.logger)`) + C2 (wiring test).
- **C.2 Two axes, request id = traceId, every logLlmCall under traceId, worker dispatch threads traceId:** C1 (delta map) + C3 (propagate traceId at tool-loop/translate/classifier/helper/rag-query) + C4 (`startRequest/endRequest(traceId)`).
- **C.3 Non-zero per-response usage from delta:** C4 (`summaryToUsage(getSummary(traceId))` into `response.usage`; openai-adapter mapping verified).
- **C.4 External-retrieval honesty:** C6 (tool call, no token attribution).
- **C.5 Reset on evict:** A3 (`dispose` calls `logger.reset()`) + C5 (verified per-session).
- **C.6 Provability (worker tokens in /v1/usage; per-response non-zero == component sum; session total across requests + reset; concurrent deltas separate; external not counted):** C5 (`/v1/usage` per-session + reset) + C4 (totals) + C1/A9 (concurrent deltas) + C6 (external).

**Reuse discipline:** `createCollection`/`closeSession`/scope-filter/providers/`SmartAgent.closeSession` are REUSED, never reinvented — A6/A8 only *trigger* `closeSession`; B1 only shares the registry; B2 exercises the existing in-memory provider. **Out of scope:** `userId`/auth (the `scope:user` branch in `rag-query.ts:76-78` already exists, fed by a downstream auth build).

### Critical Files for Implementation
- /home/okyslytsia/prj/llm-agent/packages/llm-agent-libs/src/builder.ts
- /home/okyslytsia/prj/llm-agent/packages/llm-agent-server/src/smart-agent/smart-server.ts
- /home/okyslytsia/prj/llm-agent/packages/llm-agent-libs/src/agent.ts
- /home/okyslytsia/prj/llm-agent/packages/llm-agent-libs/src/pipeline/default-pipeline.ts
- /home/okyslytsia/prj/llm-agent/packages/llm-agent/src/interfaces/request-logger.ts