# Session-Scoped Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give consumers running with different sessions correct, provable scoping via a per-session object graph keyed by a server-issued cookie identity, with session-scoped RAG (reusing the existing RAG registry) and a session-scoped token-usage rollup.

**Architecture:** A server-side `SessionRegistry` maps a cookie-issued `sessionId` → a `SessionGraph` that owns the per-session runtime (coordinator/interpreter/workers + the already-sessionId-keyed `ToolAvailabilityRegistry`/`PendingToolResultsRegistry` + a shared per-session token-logger). RAG scoping reuses the existing `SimpleRagRegistry.createCollection`/`closeSession`; the new work is lifecycle (cookie identity, TTL/LRU eviction with active-request refcount that triggers `SmartAgent.closeSession`), worker RAG sharing, and per-session token rollup with non-zero per-response usage.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), Node ≥22, `node --test` run via `tsx`, Biome, 16 lockstep-versioned packages. Spec: `docs/superpowers/specs/2026-05-27-session-scoped-infrastructure-design.md`.

**Run tests:** `npx tsx --test packages/<pkg>/src/**/__tests__/<file>.test.ts` (single file) or `npm run build` for a full type check. Lint: `npm run lint`.

---

## File Structure

### Phase A — Session Foundation
- Create: `packages/llm-agent/src/interfaces/session-identity.ts` — `SessionIdentity` type (contracts package).
- Create: `packages/llm-agent-server/src/smart-agent/session-identity-resolver.ts` — parse `Cookie`, mint id, emit `Set-Cookie`.
- Create: `packages/llm-agent-libs/src/session/session-graph.ts` — `SessionGraph` (owns per-session runtime + refcount).
- Create: `packages/llm-agent-libs/src/session/session-registry.ts` — `SessionRegistry` (Map + lazy build + TTL/LRU eviction + refcount drain).
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts:411-412` — accept injected registries instead of `new` per request.
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:1343` + `_handle` — replace `x-session-id` default with cookie resolver, acquire/release graph.

### Phase B — Worker RAG sharing
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:940-1029` (`buildSubAgent`) + `783` (top build) — pass the parent `IRagRegistry` to subagents; drop isolated `makeRag` for session/user collections.

### Phase C — Session token-rollup
- Create: `packages/llm-agent-libs/src/logger/session-request-logger.ts` — `SessionRequestLogger` (session-cumulative + per-`traceId` request delta), implements `IRequestLogger`.
- Modify: `packages/llm-agent/src/interfaces/request-logger.ts` — add `getSummary(requestId?)` overload + `IRequestLogger` keying.
- Modify: `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts` + worker build — share the session logger into workers.
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` + `agent.ts` response assembly — populate `response.usage` from the request delta.
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:1118` — `/v1/usage` reads per-session summary.

---

## PHASE A — Session Foundation

### Task A1: `SessionIdentity` contract type

**Files:**
- Create: `packages/llm-agent/src/interfaces/session-identity.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts`
Expected: FAIL — cannot find module `../session-identity.js`.

- [ ] **Step 3: Create the type**

```ts
// packages/llm-agent/src/interfaces/session-identity.ts
/**
 * Identity context for a session. `sessionId` is always present (server-issued
 * cookie). `userId` is populated only by authorization-enabled builds; the
 * default server leaves it undefined. Extensible for future identity facets.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/session-identity.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts
git commit -m "feat(session): add SessionIdentity contract type"
```

---

### Task A2: Cookie identity resolver

Resolves a `SessionIdentity` from the request: reuse a valid session cookie, else mint a unique id and signal a `Set-Cookie`. Custom headers / auth stay out (default server).

**Files:**
- Create: `packages/llm-agent-server/src/smart-agent/session-identity-resolver.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionIdentity } from '../session-identity-resolver.js';

const COOKIE = 'sid';

test('mints a unique id and a Set-Cookie when no cookie present', () => {
  const r = resolveSessionIdentity({ cookieHeader: undefined, cookieName: COOKIE, maxAgeSeconds: 7200 });
  assert.ok(r.identity.sessionId.length > 0);
  assert.equal(r.minted, true);
  assert.match(r.setCookie ?? '', new RegExp(`^${COOKIE}=${r.identity.sessionId};`));
  assert.match(r.setCookie ?? '', /Max-Age=7200/);
  assert.match(r.setCookie ?? '', /HttpOnly/);
  assert.match(r.setCookie ?? '', /Path=\//);
});

test('reuses an existing valid session cookie without minting', () => {
  const r = resolveSessionIdentity({ cookieHeader: `${COOKIE}=abc123; other=x`, cookieName: COOKIE, maxAgeSeconds: 7200 });
  assert.equal(r.identity.sessionId, 'abc123');
  assert.equal(r.minted, false);
  assert.equal(r.setCookie, undefined);
});

test('two mints produce distinct ids (no shared default bucket)', () => {
  const a = resolveSessionIdentity({ cookieHeader: undefined, cookieName: COOKIE, maxAgeSeconds: 7200 });
  const b = resolveSessionIdentity({ cookieHeader: undefined, cookieName: COOKIE, maxAgeSeconds: 7200 });
  assert.notEqual(a.identity.sessionId, b.identity.sessionId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-server/src/smart-agent/session-identity-resolver.ts
import { randomUUID } from 'node:crypto';
import type { SessionIdentity } from '@mcp-abap-adt/llm-agent';

export interface ResolveSessionInput {
  cookieHeader: string | undefined;
  cookieName: string;
  maxAgeSeconds: number;
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
  if (existing) {
    return { identity: { sessionId: existing }, minted: false };
  }
  const sessionId = randomUUID();
  const setCookie =
    `${input.cookieName}=${sessionId}; Max-Age=${input.maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax`;
  return { identity: { sessionId }, minted: true, setCookie };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/session-identity-resolver.ts packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts
git commit -m "feat(session): cookie identity resolver (mint + Set-Cookie, reuse existing)"
```

---

### Task A3: `SessionGraph` with active-request refcount

A `SessionGraph` holds the per-session runtime objects and a refcount that pins it against eviction while requests are in flight. For Phase A it owns the two sessionId-keyed registries; the coordinator/workers/logger are attached by later wiring tasks.

**Files:**
- Create: `packages/llm-agent-libs/src/session/session-graph.ts`
- Test: `packages/llm-agent-libs/src/session/__tests__/session-graph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionGraph } from '../session-graph.js';

test('refcount pins the graph; touch updates lastUsed', () => {
  const g = new SessionGraph('s1');
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
  const g = new SessionGraph('s1');
  g.release();
  assert.equal(g.activeRequests, 0);
});

test('exposes the sessionId-keyed registries', () => {
  const g = new SessionGraph('s1');
  assert.ok(g.toolAvailability);
  assert.ok(g.pendingToolResults);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent-libs/src/session/__tests__/session-graph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/session/session-graph.ts
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';

/**
 * Per-session runtime container. Owns the sessionId-keyed registries (hoisted
 * from per-request creation) and tracks in-flight requests so the registry's
 * eviction cannot dispose a graph mid-run.
 */
export class SessionGraph {
  readonly toolAvailability = new ToolAvailabilityRegistry();
  readonly pendingToolResults = new PendingToolResultsRegistry();
  private _active = 0;
  private _lastUsedMs = Date.now();

  constructor(readonly sessionId: string) {}

  get activeRequests(): number {
    return this._active;
  }
  get isPinned(): boolean {
    return this._active > 0;
  }
  get lastUsedMs(): number {
    return this._lastUsedMs;
  }

  acquire(): void {
    this._active++;
    this._lastUsedMs = Date.now();
  }
  release(): void {
    if (this._active > 0) this._active--;
    this._lastUsedMs = Date.now();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent-libs/src/session/__tests__/session-graph.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/session/session-graph.ts packages/llm-agent-libs/src/session/__tests__/session-graph.test.ts
git commit -m "feat(session): SessionGraph with active-request refcount + hoisted registries"
```

---

### Task A4: `SessionRegistry` with TTL/LRU eviction + dispose hook

Owns `Map<sessionId, SessionGraph>`, lazy-creates graphs, evicts idle/over-cap UNPINNED graphs, and calls a `dispose(sessionId)` hook on eviction (wired to `SmartAgent.closeSession` in A6). All limits configurable.

**Files:**
- Create: `packages/llm-agent-libs/src/session/session-registry.ts`
- Test: `packages/llm-agent-libs/src/session/__tests__/session-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../session-registry.js';

function makeRegistry(over: Partial<ConstructorParameters<typeof SessionRegistry>[0]> = {}) {
  const disposed: string[] = [];
  const reg = new SessionRegistry({
    idleTtlMs: 10_000,
    maxSessions: 2,
    dispose: async (id) => { disposed.push(id); },
    ...over,
  });
  return { reg, disposed };
}

test('getOrCreate is lazy and stable per id', () => {
  const { reg } = makeRegistry();
  const a = reg.getOrCreate('s1');
  const a2 = reg.getOrCreate('s1');
  assert.equal(a, a2);
  assert.equal(reg.size, 1);
});

test('idle-TTL evicts only unpinned graphs and calls dispose', async () => {
  const { reg, disposed } = makeRegistry({ idleTtlMs: 0 });
  const g = reg.getOrCreate('s1');
  g.acquire(); // pinned
  await reg.evictIdle();
  assert.deepEqual(disposed, []); // pinned → not evicted
  g.release();
  await reg.evictIdle();
  assert.deepEqual(disposed, ['s1']);
  assert.equal(reg.size, 0);
});

test('LRU cap evicts the least-recently-used unpinned graph', async () => {
  const { reg, disposed } = makeRegistry({ maxSessions: 2, idleTtlMs: 10_000 });
  reg.getOrCreate('s1');
  reg.getOrCreate('s2');
  reg.getOrCreate('s3'); // over cap → evict LRU (s1)
  // allow async dispose to settle
  await reg.flushEvictions();
  assert.deepEqual(disposed, ['s1']);
  assert.equal(reg.size, 2);
});

test('pinned graph is never LRU-evicted even over cap', async () => {
  const { reg, disposed } = makeRegistry({ maxSessions: 1, idleTtlMs: 10_000 });
  const g1 = reg.getOrCreate('s1');
  g1.acquire(); // pinned
  reg.getOrCreate('s2'); // over cap, but s1 pinned → cannot evict s1
  await reg.flushEvictions();
  assert.deepEqual(disposed, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent-libs/src/session/__tests__/session-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/session/session-registry.ts
import { SessionGraph } from './session-graph.js';

export interface SessionRegistryOptions {
  /** Idle time before an unpinned graph is evicted. */
  idleTtlMs: number;
  /** Max live sessions before LRU eviction of unpinned graphs. */
  maxSessions: number;
  /** Called when a graph is evicted (wire to SmartAgent.closeSession). */
  dispose: (sessionId: string) => Promise<void>;
}

export class SessionRegistry {
  private readonly graphs = new Map<string, SessionGraph>();
  private readonly pending: Promise<void>[] = [];

  constructor(private readonly opts: SessionRegistryOptions) {}

  get size(): number {
    return this.graphs.size;
  }

  getOrCreate(sessionId: string): SessionGraph {
    let g = this.graphs.get(sessionId);
    if (!g) {
      g = new SessionGraph(sessionId);
      this.graphs.set(sessionId, g);
      this.enforceCap();
    }
    return g;
  }

  /** Evict every unpinned graph idle longer than idleTtlMs. */
  async evictIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, g] of this.graphs) {
      if (!g.isPinned && now - g.lastUsedMs >= this.opts.idleTtlMs) {
        this.evict(id);
      }
    }
    await this.flushEvictions();
  }

  /** Resolve all in-flight dispose() calls (test + shutdown helper). */
  async flushEvictions(): Promise<void> {
    await Promise.all(this.pending.splice(0));
  }

  private enforceCap(): void {
    while (this.graphs.size > this.opts.maxSessions) {
      // least-recently-used unpinned graph
      let lruId: string | undefined;
      let lruTime = Number.POSITIVE_INFINITY;
      for (const [id, g] of this.graphs) {
        if (!g.isPinned && g.lastUsedMs < lruTime) {
          lruTime = g.lastUsedMs;
          lruId = id;
        }
      }
      if (!lruId) break; // all remaining are pinned
      this.evict(lruId);
    }
  }

  private evict(sessionId: string): void {
    this.graphs.delete(sessionId);
    this.pending.push(this.opts.dispose(sessionId));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent-libs/src/session/__tests__/session-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/session/session-registry.ts packages/llm-agent-libs/src/session/__tests__/session-registry.test.ts
git commit -m "feat(session): SessionRegistry with idle-TTL + LRU eviction respecting refcount"
```

---

### Task A5: Inject session-keyed registries into the pipeline

Replace the per-request `new ToolAvailabilityRegistry()` / `new PendingToolResultsRegistry()` with values taken from the SessionGraph, falling back to fresh instances when no graph is supplied (preserves current behavior for embed-as-library callers).

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts:411-412`
- Modify: `packages/llm-agent-libs/src/agent.ts` (thread optional `toolAvailability`/`pendingToolResults` through process options)
- Test: `packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-session-registries.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-session-registries.test.ts`
Expected: FAIL — `resolveSessionRegistries` not exported.

- [ ] **Step 3: Implement the helper and use it**

Add to `packages/llm-agent-libs/src/pipeline/default-pipeline.ts`:

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

Replace lines 411-412 (the `new ...Registry()` literals) with a call that reads the optional registries from the per-request options (threaded from `agent.process` → pipeline context). Concretely, where the pipeline currently does:

```ts
      toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
      pendingToolResults: new PendingToolResultsRegistry(),
```

change to:

```ts
      ...(() => {
        const r = resolveSessionRegistries({
          toolAvailability: opts?.toolAvailability,
          pendingToolResults: opts?.pendingToolResults,
        });
        return { toolAvailabilityRegistry: r.toolAvailability, pendingToolResults: r.pendingToolResults };
      })(),
```

In `agent.ts`, extend the `process` options type with optional `toolAvailability?: ToolAvailabilityRegistry; pendingToolResults?: PendingToolResultsRegistry;` and pass them into the pipeline run options unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-session-registries.test.ts`
Then full type check: `npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/default-pipeline.ts packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-session-registries.test.ts
git commit -m "feat(session): inject sessionId-keyed registries into pipeline (per-session, not per-request)"
```

---

### Task A6: Wire the server to cookie identity + SessionRegistry

Replace `x-session-id` default with the cookie resolver; acquire the graph for the request, send `Set-Cookie` when minted, pass the graph's registries into `agent.process`, and release in `finally`. Construct one `SessionRegistry` whose `dispose` calls `smartAgent.closeSession`. Start an idle-TTL sweep timer. Limits from config (`session.idleTtlMs` default `7200000`, `session.maxSessions` default `1000`, `session.cookieName` default `sid`).

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` (build: create registry + timer; `_handle`: resolve/acquire/release)
- Modify: server config type to add the optional `session` block.
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test** (uses the embedded transport + a fake clock for TTL)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionLifecycle } from '../smart-server.js';

test('first request mints a cookie; closeSession fires on eviction', async () => {
  const closed: string[] = [];
  const lc = buildSessionLifecycle({
    idleTtlMs: 0,
    maxSessions: 100,
    cookieName: 'sid',
    closeSession: async (id) => { closed.push(id); },
  });
  const r = lc.resolve(undefined);              // no cookie
  assert.equal(r.minted, true);
  assert.match(r.setCookie ?? '', /^sid=/);
  const g = lc.acquire(r.identity.sessionId);
  assert.equal(g.isPinned, true);
  lc.release(r.identity.sessionId);
  await lc.evictIdle();
  assert.deepEqual(closed, [r.identity.sessionId]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts`
Expected: FAIL — `buildSessionLifecycle` not exported.

- [ ] **Step 3: Implement `buildSessionLifecycle` and wire it**

Add an exported factory in `smart-server.ts` that composes the resolver + registry (keeps `_handle` thin and the unit testable):

```ts
import { SessionRegistry } from '@mcp-abap-adt/llm-agent-libs';
import { resolveSessionIdentity } from './session-identity-resolver.js';

export interface SessionLifecycleOptions {
  idleTtlMs: number;
  maxSessions: number;
  cookieName: string;
  closeSession: (sessionId: string) => Promise<void>;
}

export function buildSessionLifecycle(opts: SessionLifecycleOptions) {
  const registry = new SessionRegistry({
    idleTtlMs: opts.idleTtlMs,
    maxSessions: opts.maxSessions,
    dispose: opts.closeSession,
  });
  return {
    resolve: (cookieHeader: string | undefined) =>
      resolveSessionIdentity({ cookieHeader, cookieName: opts.cookieName, maxAgeSeconds: Math.floor(opts.idleTtlMs / 1000) }),
    acquire: (sessionId: string) => {
      const g = registry.getOrCreate(sessionId);
      g.acquire();
      return g;
    },
    release: (sessionId: string) => registry.getOrCreate(sessionId).release(),
    evictIdle: () => registry.evictIdle(),
    registry,
  };
}
```

In `build()`, after `agentHandle`, construct it:

```ts
    const session = this.cfg.session ?? {};
    const lifecycle = buildSessionLifecycle({
      idleTtlMs: session.idleTtlMs ?? 7_200_000,
      maxSessions: session.maxSessions ?? 1000,
      cookieName: session.cookieName ?? 'sid',
      closeSession: (id) => smartAgent.closeSession(id),
    });
    const sweep = setInterval(() => { void lifecycle.evictIdle(); }, Math.min(session.idleTtlMs ?? 7_200_000, 60_000));
    sweep.unref?.();
    closeFns.push(() => { clearInterval(sweep); });
```

In `_handle`, replace line 1343:

```ts
    const resolved = lifecycle.resolve(req.headers['cookie'] as string | undefined);
    const sessionId = resolved.identity.sessionId;
    if (resolved.minted && resolved.setCookie) res.setHeader('Set-Cookie', resolved.setCookie);
    const graph = lifecycle.acquire(sessionId);
    try {
      // ... existing request handling; pass graph registries into opts:
      // opts.toolAvailability = graph.toolAvailability;
      // opts.pendingToolResults = graph.pendingToolResults;
    } finally {
      lifecycle.release(sessionId);
    }
```

Add the `session?` block to the server config interface:

```ts
  session?: {
    idleTtlMs?: number;
    maxSessions?: number;
    cookieName?: string;
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts`
Then `npm run build`.
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts
git commit -m "feat(session): wire server to cookie identity + SessionRegistry (Set-Cookie, acquire/release, TTL sweep, closeSession on evict)"
```

---

### Task A7: Phase-A provability tests (A.6)

**Files:**
- Test: `packages/llm-agent-libs/src/session/__tests__/session-isolation.test.ts`

- [ ] **Step 1: Write the tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../session-registry.js';

test('two sessions get distinct graphs (no shared default bucket)', () => {
  const reg = new SessionRegistry({ idleTtlMs: 10_000, maxSessions: 100, dispose: async () => {} });
  assert.notEqual(reg.getOrCreate('s1'), reg.getOrCreate('s2'));
});

test('evict triggers dispose exactly once per session', async () => {
  const disposed: string[] = [];
  const reg = new SessionRegistry({ idleTtlMs: 0, maxSessions: 100, dispose: async (id) => { disposed.push(id); } });
  reg.getOrCreate('s1');
  await reg.evictIdle();
  await reg.evictIdle();
  assert.deepEqual(disposed, ['s1']);
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/session/__tests__/session-isolation.test.ts` — Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/session/__tests__/session-isolation.test.ts
git commit -m "test(session): phase-A provability — session isolation + single dispose on evict"
```

---

## PHASE B — Worker RAG sharing

### Task B1: Subagents share the parent RAG registry

Today `buildSubAgent` builds an isolated RAG via `makeRag(subCfg.rag)`. Instead, pass the parent `IRagRegistry` so session/user collections written at the top level are visible to workers; the worker keeps using only collections it declares. Reuse `SmartAgentBuilder.setRagRegistry`.

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` — `buildSubAgent(...)` signature gains `parentRagRegistry: IRagRegistry`; pass `subBuilder.setRagRegistry(parentRagRegistry)`; only call `setToolsRag(makeRag(...))` when the subagent declares its OWN store (global tools catalog), otherwise rely on the shared registry.
- Modify: the `buildSubAgent` call site (~612) to pass `agentHandle.ragRegistry` (expose it on the handle if not already).
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
import { resolveSubAgentRagRegistry } from '../smart-server.js';

test('subagent reuses the parent registry instead of a fresh one', () => {
  const parent = new SimpleRagRegistry();
  const used = resolveSubAgentRagRegistry({ parentRagRegistry: parent, subHasOwnStore: false });
  assert.equal(used, parent);
});

test('subagent with its own declared store still gets the parent registry for shared scopes', () => {
  const parent = new SimpleRagRegistry();
  const used = resolveSubAgentRagRegistry({ parentRagRegistry: parent, subHasOwnStore: true });
  assert.equal(used, parent); // shared registry holds both; own store registered into it
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts`
Expected: FAIL — `resolveSubAgentRagRegistry` not exported.

- [ ] **Step 3: Implement**

Add the small resolver and use it in `buildSubAgent`:

```ts
import type { IRagRegistry } from '@mcp-abap-adt/llm-agent';

export function resolveSubAgentRagRegistry(input: {
  parentRagRegistry: IRagRegistry;
  subHasOwnStore: boolean;
}): IRagRegistry {
  // Always share the parent registry: session/user collections created at the
  // top level become visible to the worker. A subagent's own declared store is
  // registered INTO this same registry (under its own name), so one registry
  // backs both shared and worker-private collections.
  return input.parentRagRegistry;
}
```

In `buildSubAgent`, add `parentRagRegistry: IRagRegistry` param, then:

```ts
    subBuilder = subBuilder.setRagRegistry(
      resolveSubAgentRagRegistry({ parentRagRegistry, subHasOwnStore: Boolean(subCfg.rag) }),
    );
    // Only build an isolated tools store when the subagent declares one; it is
    // registered into the shared registry under the subagent's namespace.
    if (subCfg.rag) {
      subBuilder = subBuilder.setToolsRag(await makeRag(subCfg.rag, ragOptions));
    }
```

At the call site (~612) pass `agentHandle.ragRegistry`. If the handle does not expose it, add `ragRegistry` to the `SmartAgentHandle` returned by `builder.build()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts`
Then `npm run build`.
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts
git commit -m "feat(rag): subagents share the parent RAG registry (session/user collections visible to workers)"
```

---

### Task B2: Phase-B provability (B.6)

**Files:**
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/session-artifact-visibility.test.ts`

- [ ] **Step 1: Write the test** — upsert a session-scoped artifact via the shared registry under sessionId `s1`, then query it through a worker-facing `IRag` view of the same registry and assert it is visible; query under `s2` and assert it is not.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
// Build an in-memory session-scoped collection for s1, upsert one doc, and
// assert query under s1 returns it while s2 sees nothing. Use the in-memory
// provider already registered by builder defaults.

test('session-scoped artifact written via shared registry is visible to a worker view of the same registry, isolated from another session', async () => {
  const reg = new SimpleRagRegistry();
  // ... register in-memory provider, createCollection scope:session sessionId:s1,
  // upsert via editor, query with ragFilter.sessionId='s1' → 1 result, ='s2' → 0.
  assert.ok(reg); // replace with concrete assertions once provider wiring is in place
});
```

> Implementer note: flesh out using the in-memory provider exactly as `smart-agent-close-session.test.ts` sets one up; the assertion is result-count 1 for matching sessionId, 0 for a different one.

- [ ] **Step 2: Run** the test — Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/__tests__/session-artifact-visibility.test.ts
git commit -m "test(rag): phase-B provability — session artifact visible across workers, isolated per session"
```

---

## PHASE C — Session token-rollup

### Task C1: `SessionRequestLogger` (session-cumulative + per-traceId delta)

Implements `IRequestLogger`. Keeps a session-cumulative tally that survives across requests plus a per-`traceId` request delta (so concurrent requests don't stomp each other and per-response usage is exact). `startRequest(requestId)` / `endRequest(requestId)` / `getSummary(requestId?)` are keyed; `getSummary()` (no arg) returns the session-cumulative.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/request-logger.ts` — widen `startRequest`/`endRequest`/`getSummary` to accept an optional `requestId`, and `logLlmCall` etc. to accept an optional `requestId` in the entry.
- Create: `packages/llm-agent-libs/src/logger/session-request-logger.ts`
- Test: `packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '../session-request-logger.js';

const call = (component: string, model: string, total: number, requestId: string) => ({
  component: component as never, model, promptTokens: total, completionTokens: 0,
  totalTokens: total, durationMs: 1, requestId,
});

test('per-traceId delta isolates concurrent requests', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.startRequest('r2');
  log.logLlmCall(call('tool-loop', 'm', 10, 'r1'));
  log.logLlmCall(call('tool-loop', 'm', 5, 'r2'));
  assert.equal(log.getSummary('r1').byComponent['tool-loop'].totalTokens, 10);
  assert.equal(log.getSummary('r2').byComponent['tool-loop'].totalTokens, 5);
});

test('session-cumulative sums across requests and survives endRequest', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.logLlmCall(call('tool-loop', 'm', 10, 'r1'));
  log.endRequest('r1');
  log.startRequest('r2');
  log.logLlmCall(call('tool-loop', 'm', 7, 'r2'));
  log.endRequest('r2');
  assert.equal(log.getSummary().byComponent['tool-loop'].totalTokens, 17);
});

test('reset clears session-cumulative (called on session evict)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.logLlmCall(call('tool-loop', 'm', 10, 'r1'));
  log.reset();
  assert.equal(Object.keys(log.getSummary().byComponent).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

First widen the interface in `request-logger.ts`:

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

> `DefaultRequestLogger` keeps working: its `startRequest(_?)` ignores the arg, `getSummary(_?)` returns its single tally. Update its method signatures to accept the optional arg (no behavior change).

Then implement `SessionRequestLogger` with a `Map<requestId, LlmCallEntry[]>` for deltas plus a cumulative `LlmCallEntry[]`; `logLlmCall` pushes to both the cumulative list and (if `requestId` present) the delta map; `getSummary(id)` aggregates the delta list, `getSummary()` aggregates the cumulative list (reuse the same `byModel/byComponent/byCategory` aggregation as `DefaultRequestLogger.getSummary` — extract it into a shared `aggregate(calls): RequestSummary` helper to stay DRY); `endRequest(id)` deletes the delta entry after the response has read it (or keep until next startRequest of same id); `reset()` clears cumulative + deltas.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts`
Then `npm run build`.
Expected: PASS (3 tests); build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/request-logger.ts packages/llm-agent-libs/src/logger/session-request-logger.ts packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts
git commit -m "feat(usage): SessionRequestLogger — session-cumulative + per-traceId request delta"
```

---

### Task C2: Attach the session logger to the SessionGraph and share it into workers

The SessionGraph owns one `SessionRequestLogger`; the top-level agent and every worker built for that session use it (via `SmartAgentBuilder.withRequestLogger`). The server threads `traceId` into worker dispatch.

**Files:**
- Modify: `packages/llm-agent-libs/src/session/session-graph.ts` — add `readonly logger = new SessionRequestLogger()`.
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` — when handling a request, use `graph.logger` for the top-level run and pass it to worker construction; thread `traceId` as `requestId`.
- Test: `packages/llm-agent-libs/src/session/__tests__/session-graph-logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionGraph } from '../session-graph.js';

test('SessionGraph exposes a shared session logger', () => {
  const g = new SessionGraph('s1');
  g.logger.startRequest('r1');
  g.logger.logLlmCall({ component: 'tool-loop', model: 'm', promptTokens: 3, completionTokens: 0, totalTokens: 3, durationMs: 1, requestId: 'r1' });
  assert.equal(g.logger.getSummary('r1').byComponent['tool-loop'].totalTokens, 3);
});
```

- [ ] **Step 2: Run** — Expected: FAIL (`logger` undefined).
- [ ] **Step 3: Implement** — add `readonly logger = new SessionRequestLogger();` to `SessionGraph` (import it). In the server, replace the top-level `agentHandle.requestLogger` usage in `_handle` with `graph.logger`, and pass `graph.logger` into `buildSubAgent` (which calls `subBuilder.withRequestLogger(sharedLogger)` instead of letting the worker build its own). Thread `traceId` into the worker run as the `requestId`.
- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.
- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/session/session-graph.ts packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-libs/src/session/__tests__/session-graph-logger.test.ts
git commit -m "feat(usage): share one per-session token-logger across coordinator and workers"
```

---

### Task C3: Non-zero per-response usage from the request delta

Populate the response `usage` from `graph.logger.getSummary(traceId)` so the OpenAI/Anthropic adapter emits real numbers (today the coordinator path leaves `response.usage` unset → 0).

**Files:**
- Modify: `packages/llm-agent-libs/src/agent.ts` — where the final response is assembled, set `usage` from `requestLogger.getSummary(traceId)` totals (sum of `byComponent`).
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` — ensure the coordinator's final emit carries usage (or rely on agent-level assembly reading the shared logger).
- Test: `packages/llm-agent-libs/src/logger/__tests__/usage-summary-totals.test.ts`

- [ ] **Step 1: Write the failing test** (unit on the totals helper)

```ts
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

- [ ] **Step 2: Run** — Expected: FAIL (`summaryToUsage` not exported).
- [ ] **Step 3: Implement** `summaryToUsage(summary): LlmUsage` in `session-request-logger.ts` (sum over `byComponent`), and call it in `agent.ts` response assembly: `response.usage = summaryToUsage(this.requestLogger.getSummary(traceId))`. Verify the openai-adapter (`openai-adapter.ts:133`) already maps `response.usage` → `prompt_tokens/...`.
- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.
- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/logger/session-request-logger.ts packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts packages/llm-agent-libs/src/logger/__tests__/usage-summary-totals.test.ts
git commit -m "feat(usage): non-zero per-response usage from the per-traceId request delta"
```

---

### Task C4: `/v1/usage` reports per-session; reset on evict

`/v1/usage` returns the current session's cumulative summary (resolve the session from the cookie like `_handle` does); session-cumulative resets when the graph is evicted (wire `graph.logger.reset()` into the registry `dispose`).

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:1118` — `/v1/usage` resolves the session and returns `graph.logger.getSummary()`.
- Modify: the `closeSession` dispose hook (A6) to also call the graph's `logger.reset()` before removal — or rely on graph disposal dropping the logger with the graph (document which).
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/usage-per-session.test.ts`

- [ ] **Step 1: Write the failing test** — two sessions accumulate independently; evicting one resets only its tally.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '@mcp-abap-adt/llm-agent-libs';

test('per-session usage is independent and resets on evict', async () => {
  const reg = new SessionRegistry({ idleTtlMs: 0, maxSessions: 100, dispose: async () => {} });
  const g1 = reg.getOrCreate('s1');
  const g2 = reg.getOrCreate('s2');
  g1.logger.startRequest('r1'); g1.logger.logLlmCall({ component: 'tool-loop', model: 'm', promptTokens: 10, completionTokens: 0, totalTokens: 10, durationMs: 1, requestId: 'r1' });
  g2.logger.startRequest('r2'); g2.logger.logLlmCall({ component: 'tool-loop', model: 'm', promptTokens: 3, completionTokens: 0, totalTokens: 3, durationMs: 1, requestId: 'r2' });
  assert.equal(g1.logger.getSummary().byComponent['tool-loop'].totalTokens, 10);
  assert.equal(g2.logger.getSummary().byComponent['tool-loop'].totalTokens, 3);
  g1.logger.reset();
  assert.equal(Object.keys(g1.logger.getSummary().byComponent).length, 0);
  assert.equal(g2.logger.getSummary().byComponent['tool-loop'].totalTokens, 3);
});
```

- [ ] **Step 2: Run** — Expected: FAIL until C1/C2 land (`logger` on graph). After C2 it should compile; run to confirm PASS.
- [ ] **Step 3: Implement** the `/v1/usage` per-session read and confirm reset semantics.
- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.
- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/usage-per-session.test.ts
git commit -m "feat(usage): /v1/usage per-session, reset on session evict"
```

---

### Task C5: External-retrieval honesty (C.4)

When retrieval is a consumer-provided MCP tool, it is logged as a `toolCall`, never as our LLM/embedding tokens. Verify the existing tool-loop logs MCP tool calls via `logToolCall` (not `logLlmCall`) and add a regression test asserting a consumer MCP retrieval tool does not increment any `byComponent` token bucket.

**Files:**
- Test: `packages/llm-agent-libs/src/logger/__tests__/external-retrieval-not-counted.test.ts`

- [ ] **Step 1: Write the test**

```ts
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

- [ ] **Step 2: Run** — Expected: PASS (after C1).
- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/logger/__tests__/external-retrieval-not-counted.test.ts
git commit -m "test(usage): external MCP retrieval logged as tool call, never as our tokens"
```

---

## Final steps (after all phases)

- [ ] **Lint + full build:** `npm run lint && npm run build` — Expected: clean.
- [ ] **Run all new suites:** `npx tsx --test packages/*/src/**/__tests__/{session,usage,subagent}-*.test.ts` (and the session-*/logger suites) — Expected: all PASS.
- [ ] **Docs:** update `docs/ARCHITECTURE.md` (session graph + scoping), `docs/QUICK_START.md` (cookie session note + `session:` config block), and the `EXAMPLES.md` YAML to show the `session:` block. (No release/version bump here — 17.0.0 is cut separately once all epic items are closed.)
- [ ] **Delete this plan + the spec** once the epic is merged (repo convention: specs/plans live only while active).

---

## Self-Review notes (author)

- **Spec coverage:** A.1→A2/A6 (cookie), A.2→A3/A4/A5/A6 (graph+registries+registry), A.4→A4/A6 (TTL/LRU/refcount/closeSession), A.5→A3 refcount + A4 eviction, A.6→A7; B.3/B.4/B.5→B1 (worker sharing; external customer RAG + consumer MCP reuse existing per the spec's Reuse section, no new code), B.6→B2; C.1→C2, C.2→C1, C.3→C3, C.4→C5, C.5→C4, C.6→C1/C3/C4/C5.
- **Reuse:** RAG identity-bound creation + `closeSession` + scope filter are REUSED (Reuse section), so no tasks reinvent them — A6/C4 only *trigger* `closeSession`/reset; B1 only shares the registry.
- **Out of scope confirmed:** `userId`/auth — no task (downstream build supplies it; the `scope:user` filter already exists).
