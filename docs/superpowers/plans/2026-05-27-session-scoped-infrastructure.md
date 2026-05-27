# Session-Scoped Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give consumers running with different sessions correct, *provable* scoping via a per-session object **graph** assembled by a `SessionGraphFactory` from injected global resources (vectorized tools-catalog RAG, LLM/embedder clients, RAG registry) plus a per-session MCP client from an injected `mcpClientFactory` (default: shared global client) — never re-vectorizing the catalog or rebuilding LLM clients per session. The graph owns per-session pipeline/interpreter/coordinator/**workers** + the sessionId-keyed registries + a per-session token-logger; identity comes from a server-issued cookie; RAG scoping reuses the existing per-call `rag-query` filter; usage rolls up per session with non-zero per-response numbers.

**Architecture (the locked model):**

- **GLOBAL, built once, injected by reference:** the vectorized tools-catalog RAG (`toolsRag`) — **the STRICT global invariant, never re-vectorized per session** — the **LLM/embedder clients (top-level AND per-worker)**, and the RAG provider/registry (`IRagRegistry`) with global/user collections. The expensive `builder.build()` work (MCP connect + tool vectorization, `builder.ts:880-1089`) runs **once**; the per-worker `makeLlm(...)` / embedder construction (`smart-server.ts:953-1004`) also runs **once** and is cached. The full GLOBAL set is: **(a) vectorized tools-catalog RAG, (b) LLM clients — top-level main/classifier/helper AND per-worker main/classifier/helper, (c) embedder, (d) the RAG provider/registry.**
- **MCP client is per-session-CAPABLE, NOT a strict global.** Resolved via an injected `mcpClientFactory(identity: SessionIdentity) => IMcpClient[]`. The **default** factory returns the once-built **shared global** MCP client(s) (no-per-session-creds case — e.g. the default server keeps ONE upstream connection); a creds-aware build (out of scope) returns a fresh per-session client from per-session ABAP creds. Even when per-session, the tools-catalog RAG is NOT re-vectorized — only the connection differs.
- **PER-SESSION instances, built cheaply from those globals:** pipeline (`DefaultPipeline`), DAG interpreter/coordinator (`DagCoordinatorHandler`), roles, **workers (a FRESH per-session `SubAgentRegistry` + DAG coordinator deps — NOT the server's global worker map)**, the per-session MCP server (handler registration), token-logger (`SessionRequestLogger`), history-memory, `ToolAvailabilityRegistry`, `PendingToolResultsRegistry`. Per-session worker assembly **only re-wires** — it reuses the cached `ILlm`/embedder instances by reference and **never constructs new LLM clients or re-vectorizes**. Per-session = composition + state only.
- **`SessionGraphFactory.build(identity) → SessionGraph`** is the central new composition path. It does NOT re-vectorize tools or rebuild LLM clients; it injects the already-built `toolsRag` / `ragRegistry` / LLM / embedder into a fresh `SmartAgentBuilder` via `setToolsRag()`, `setRagRegistry()`, the cached per-worker LLM/embedder, plus a per-session `SessionRequestLogger` via `withRequestLogger()`, and the MCP client(s) **resolved from `mcpClientFactory(identity)`** via `withMcpClients()` (skips connect+vectorize — `builder.ts:880-882`; the default factory returns the shared global client(s) by reference). **Crucially it ALSO re-wires the session's subagent workers** through the same injected-globals path (one cheap `buildSubAgent` re-wire per worker per session), so every worker shares this session's logger + the global toolsRag/ragRegistry + the cached per-worker LLM/embedder instances + this session's resolved MCP client(s) — never the server's once-built global workers, and never freshly constructed LLM clients.
- **RAG:** NO identity-bound view/factory objects. Reuse the existing per-call `rag-query` scope filter (`rag-query.ts:73-86`: `scope:session → ragFilter.sessionId = ctx.sessionId`, `scope:user → ragFilter.userId = ctx.options.userId`). The graph only (a) guarantees `ctx.sessionId == cookie session id` (set via `options.sessionId`, threaded to `default-pipeline.ts:388` / `agent.ts:672`), and (b) creates/closes session collections via the existing `SimpleRagRegistry.createCollection` / `closeSession`. Workers SHARE the parent `IRagRegistry` (`setRagRegistry`), not an isolated `makeRag`.
- **Token attribution (binding):** one `SessionRequestLogger` per session, shared by the coordinator AND its workers. Its per-request delta is keyed by `traceId` and is **nested-safe via per-`traceId` refcount/depth**: a worker `SmartAgent.process()` runs `startRequest(traceId)`/`endRequest(traceId)` under the SAME `traceId` as the coordinator, so the logger must NOT clear an existing bucket on nested `startRequest` and must NOT delete it on `endRequest`. Only an explicit `dropRequest(traceId)` — called by the SERVER after it has read the response usage — frees the delta. `traceId` is threaded all the way into worker dispatch (`ISubAgentInput.trace`).
- **Reentrancy (binding):** per-session pipeline/interpreter/coordinator/worker instances are shared across concurrent same-session requests and MUST be reentrant — all per-run mutable state already lives in the per-request `PipelineContext` (`default-pipeline.ts:386-435`), never on instance fields. The graph holds only session state + shared services. Token-logger request delta is keyed by `traceId`.
- **Concurrent first-request safety (binding):** the per-session graph is built lazily and `SessionGraphFactory.build` is async, so two concurrent requests for the SAME new sessionId must NOT both build (which would create two graphs for one session — one leaks, requests split across runtimes). The `SessionRegistry` uses a **single-flight guard** so concurrent acquirers of a new sessionId await the SAME in-flight build and receive the identical graph instance.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), Node ≥22, `node --test` run via `tsx`, Biome, 16 lockstep-versioned packages. Spec: `docs/superpowers/specs/2026-05-27-session-scoped-infrastructure-design.md`.

**Run tests:** `npx tsx --test <path>` (single file). Full type check: `npm run build`. Lint: `npm run lint`.

**Execution order is strict top-to-bottom.** There are no "pull forward / stub" instructions anywhere. Every symbol is defined before any task that references it: the `SessionRequestLogger` (Task A3) is defined before any task that injects it; the parameterized `buildSubAgent` + the cached global per-worker LLM/embedder set (Task A7) is defined before the `SessionGraphFactory` (A8) and the server wiring (A10) that depend on it.

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
  - `builder.ts:1365-1381` returns the `SmartAgentHandle` (`agent`, `chat`, `streamChat`, `requestLogger`, `close`, `ragStores`, ...). **`ragRegistry` and `mcpClients` are NOT currently on the handle** — Task A5 adds both.
  - **DAG worker wiring:** `withDagCoordinator(deps)` (`builder.ts:561`) stores `this._dagCoordinator`; workers are `ISubAgent` instances in `deps.workers`. The DAG handler `DagCoordinatorHandler` (`dag-coordinator.ts:35` `workers: ReadonlyMap<string, ISubAgent>`) dispatches them via `interpreter.interpret(plan, { workers, sessionId, signal, ... })` (`dag-coordinator.ts:216-223`).

- **`agent.ts` — requestLogger is a constructor field:** `agent.ts:237` `private readonly requestLogger`, set at `agent.ts:260` from `deps.requestLogger`. Used at `agent.ts:680` (`startRequest()`), `agent.ts:1083` (`endRequest()`), `agent.ts:1233`/`1582`/`1702`/`1743` (`getSummary().byModel`), `agent.ts:1961` (`logLlmCall` for helper). **`traceId` is per-request** at `agent.ts:642` (`options?.trace?.traceId ?? randomUUID()`). `sessionId` at `agent.ts:672` (`options?.sessionId ?? 'default'`).
  - **Chosen approach (composition seam):** the `SessionGraphFactory` builds a **per-session `SmartAgent` AND per-session workers** whose constructor `requestLogger` IS the session's `SessionRequestLogger`. We do NOT thread a per-call logger override into `agent.ts`. Per-request isolation comes from the **`traceId`-keyed delta inside `SessionRequestLogger`** (Phase C), so one logger instance shared across concurrent requests AND across the coordinator+workers stays correct. Because a worker's `process()` calls `startRequest(traceId)`/`endRequest(traceId)` under the coordinator's own `traceId` (nested), the logger MUST be nested-safe (Task A3) and the server frees the delta with `dropRequest(traceId)` after reading usage (Task A10).

- **`default-pipeline.ts:386-435` `buildContext()`** creates the per-request `PipelineContext`: `sessionId: options?.sessionId ?? 'default'` (`:388`), `requestLogger: this.resolvedRequestLogger` (`:408`), and **`toolAvailabilityRegistry: new ToolAvailabilityRegistry()` (`:411`) + `pendingToolResults: new PendingToolResultsRegistry()` (`:412`)** — per-request `new`, the two sessionId-keyed registries to hoist into the graph.

- **`smart-server.ts` — server composition:**
  - `build()`: `:376-412` resolves the top-level `mainLlm`/`classifierLlm`/`helperLlm` via `makeLlm(...)`; `:449` builds `mergedEmbedderFactories`; `:463` `new SmartAgentBuilder(...)`; `:484-485` `toolsRag = await makeRag(...)` + `setToolsRag`; `:518-521` named stores; `:610-632` builds subagents via `buildSubAgent` into a `registry: SubAgentRegistry`, wraps each in `SmartAgentSubAgent`, and `withSubAgents(registry)`; `:678-728` resolves the DAG coordinator (`interpreter`, `workers` map at `:693-695`, `withDagCoordinator({...})` at `:719`); `:783` **the single `agentHandle = await builder.build()`**; `:784-792` destructures it.
  - **`buildSubAgent` (`:940-1030`):** today each worker calls `makeLlm(...)` (`:953-1004`) → **NEW LLM clients per call**, `makeRag(subCfg.rag)` (`:1012-1017`) → isolated RAG, and has its own `DefaultRequestLogger`. **This is the global worker AND the per-call LLM construction the design forbids per session.** Task A7 parameterizes it by injected resources (incl. cached LLM/embedder) and makes it callable PER SESSION as a cheap re-wire.
  - `_handle` (`:1032`): `:1342` `traceId = randomUUID()`; `:1343` `sessionId = (req.headers['x-session-id'] as string) || 'default'` — **the line cookie identity replaces**; `:1386-1401` `opts` (carries `sessionId`, `trace.traceId`).
  - `/v1/usage` (`:1118-1121`): returns the single global `requestLogger.getSummary()` — C8 makes it per-session.

- **Subagent dispatch chain (verified — trace is dropped today):**
  - `dag-coordinator.ts:216-223` → `interpreter.interpret(plan, { inputText, workers, sessionId: ctx.sessionId, signal, errorStrategy, ancestorContext })` — **no trace**.
  - `dag-coordinator.ts:120-124` → `this.deps.stateOracle.run({ task, sessionId: ctx.sessionId, signal })` — **no trace**.
  - `dag-plan-interpreter.ts:64-68` → `this.resolveWorker(n, ctx).run({ task, sessionId: ctx.sessionId, signal: ctx.signal })` — **no trace**.
  - `smart-agent-subagent.ts:29-32` → `this.agent.process(prompt, { sessionId: input.sessionId, signal: input.signal })` — **no trace**.
  - `ISubAgentInput` (`packages/llm-agent/src/interfaces/subagent.ts:18-32`) has `task/context/sessionId/signal` — **no trace field**.
  - `InterpretContext` (`packages/llm-agent/src/interfaces/interpreter.ts:11-22`) has `sessionId/signal` — **no trace field**.
  - `CallOptions` (`packages/llm-agent/src/interfaces/types.ts:23-27`) has `trace?: TraceContext`, `TraceContext.traceId` (`:17-18`). So `process(prompt, { ..., trace })` is the existing seam.

- **Reuse (do NOT reinvent):** `SimpleRagRegistry.createCollection` / `closeSession` (`simple-rag-registry.ts:86`,`:188`); `InMemoryRagProvider` + provider registry (close-session test pattern, `smart-agent-close-session.test.ts:1-35`); the `rag-query` scope filter (`rag-query.ts:73-86`); `SmartAgent.closeSession` (`agent.ts:408-420`).

### Files created / modified

**Phase A — Session Foundation**
- Create: `packages/llm-agent/src/interfaces/session-identity.ts` — `SessionIdentity` contract. (A1)
- Create: `packages/llm-agent-server/src/smart-agent/session-identity-resolver.ts` — cookie parse/validate/mint + `Set-Cookie`. (A2)
- Modify: `packages/llm-agent/src/interfaces/request-logger.ts` — `requestId?` on entries; `startRequest/endRequest/getSummary(requestId?)`; add `dropRequest(requestId?)`. (A3)
- Create: `packages/llm-agent-libs/src/logger/session-request-logger.ts` — nested-safe `SessionRequestLogger` (refcount/depth + `dropRequest`) + `aggregate` + `summaryToUsage`. **(Task A3 — defined here so every later injector has it.)**
- Create: `packages/llm-agent-libs/src/session/session-graph.ts` — `SessionGraph` (per-session instances + refcount + disposal flag). (A4)
- Modify: `packages/llm-agent/src/interfaces/builder.ts` — expose `ragRegistry` + `mcpClients` on `SmartAgentHandle`. (A5)
- Modify: `packages/llm-agent-libs/src/builder.ts` — return `ragRegistry` + `mcpClients` on the handle. (A5)
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts:411-412` — take the two registries from injected deps instead of per-request `new`. (A6)
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` — **(A7)** hoist the cached global per-worker LLM/embedder construction to a one-time step; parameterize `buildSubAgent` by injected `{ ragRegistry, toolsRag, mcpClients, requestLogger, mainLlm, classifierLlm, helperLlm?, embedder }`; share parent `IRagRegistry`; add `resolveSubAgentRagRegistry`. **(Done BEFORE the factory + server wiring that depend on it.)**
- Create: `packages/llm-agent-libs/src/session/session-graph-factory.ts` — `SessionGraphFactory.build(identity)` (compose-from-injected-globals, incl. fresh per-session workers via the parameterized `buildSubAgent`). (A8)
- Create: `packages/llm-agent-libs/src/session/session-registry.ts` — `SessionRegistry` (Map + lazy build + **single-flight build guard** + TTL/LRU + **drain** semantics; `acquire` is async). (A9)
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` (`build` + `_handle`) — build globals once (incl. the cached per-worker LLM/embedder set), construct `SessionGraphFactory` + `SessionRegistry`, cookie resolve → `await graph` → run on the session pipeline; `dropRequest(traceId)` in `finally` after reading usage. (A10)
- Modify: server config type (`SmartServerConfig`) — add optional `session` block. (A10)

**Phase B — Worker session-RAG provability**
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/session-artifact-visibility.test.ts` — the shared-registry session-RAG provability (the `buildSubAgent` parameterization itself moved to A7). (B1)

**Phase C — traceId threading + Session token-rollup**
- Modify: `packages/llm-agent/src/interfaces/subagent.ts` — add `trace?: { traceId: string }` to `ISubAgentInput`. (C1)
- Modify: `packages/llm-agent/src/interfaces/interpreter.ts` — add `trace?: { traceId: string }` to `InterpretContext`. (C1)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` — thread `ctx.options?.trace` into `interpret(...)` and `stateOracle.run(...)`. (C1)
- Modify: `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts` — forward `ctx.trace` into `worker.run({ ..., trace })`. (C1)
- Modify: `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts` — forward `input.trace` into `process(prompt, { ..., trace })`. (C1)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts:505`, `translate.ts:46`, `packages/llm-agent-libs/src/classifier/llm-classifier.ts:144`, `agent.ts:1961`, `rag-query.ts:90` — propagate `ctx.options.trace.traceId` as `requestId`. (C3)
- Modify: `packages/llm-agent-libs/src/agent.ts` — `startRequest(traceId)` / `endRequest(traceId)`; set `response.usage` from `getSummary(traceId)`. (C7)
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:1118` — `/v1/usage` per-session. (C8)

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

Resolves a `SessionIdentity` from the request cookie. Implements the spec cookie contract (§A.1): opaque UUID id; `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age`, `Secure` WHEN HTTPS; id must match `^[A-Za-z0-9-]{1,128}$` else treat as no-cookie and mint fresh.

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

### Task A3: `SessionRequestLogger` — nested-safe per-`traceId` delta (refcount/depth + `dropRequest`)

> **Defined early:** the logger is defined here, before any task that injects it (`SessionGraph` A4, `SessionGraphFactory` A8, server wiring A10). Strict top-to-bottom execution works; there is no "pull forward / stub".

Implements `IRequestLogger`. Keeps a **session-cumulative** tally (survives across requests, for `/v1/usage`) plus a **per-`traceId` delta** map (for exact per-response usage). The delta is **nested-safe** because a worker `SmartAgent.process()` calls `startRequest(traceId)`/`endRequest(traceId)` under the SAME `traceId` as the coordinator (`agent.ts:680`/`agent.ts:1083`). Therefore:

- `startRequest(id)` → increment `depth[id]`; create the delta bucket **only if absent** (NEVER clear an existing one — a nested worker start must not wipe the coordinator's tokens).
- `endRequest(id)` → decrement `depth[id]`; **does NOT delete** the bucket (a nested worker end must not drop the coordinator's delta before the server reads `response.usage`).
- `dropRequest(id)` → the explicit free. The SERVER calls it once, after reading `getSummary(traceId)` for the response usage (only the outermost/top-level owner frees the delta).
- `logLlmCall` accrues to **session-cumulative regardless of depth**, and to the per-`traceId` bucket when `requestId` is set.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/request-logger.ts` — `requestId?` on entries; `startRequest/endRequest/getSummary(requestId?)`; add `dropRequest(requestId?)`.
- Create: `packages/llm-agent-libs/src/logger/session-request-logger.ts` (incl. `aggregate` + `summaryToUsage`).
- Test: `packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '../session-request-logger.js';

const call = (component: string, total: number, requestId?: string) => ({
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

test('NESTED start does NOT clear an existing delta (coordinator tokens survive a worker start)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t');                       // coordinator (depth 1)
  log.logLlmCall(call('translate', 7, 't'));   // coordinator's own aux call
  log.startRequest('t');                        // nested worker start (depth 2) — must NOT wipe
  log.logLlmCall(call('tool-loop', 30, 't'));   // worker tokens
  assert.equal(log.getSummary('t').byComponent['translate'].totalTokens, 7);
  assert.equal(log.getSummary('t').byComponent['tool-loop'].totalTokens, 30);
});

test('NESTED end does NOT delete the delta (worker endRequest leaves it for the server)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t');                        // coordinator (depth 1)
  log.startRequest('t');                        // worker (depth 2)
  log.logLlmCall(call('tool-loop', 42, 't'));
  log.endRequest('t');                          // worker end (depth 1) — bucket survives
  assert.equal(log.getSummary('t').byComponent['tool-loop'].totalTokens, 42);
  log.endRequest('t');                          // coordinator end (depth 0) — STILL survives
  assert.equal(log.getSummary('t').byComponent['tool-loop'].totalTokens, 42,
    'endRequest never deletes; only dropRequest frees');
});

test('dropRequest frees the delta (server calls it after reading usage)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t');
  log.logLlmCall(call('tool-loop', 42, 't'));
  assert.equal(log.getSummary('t').byComponent['tool-loop'].totalTokens, 42);
  log.dropRequest('t');
  assert.equal(Object.keys(log.getSummary('t').byComponent).length, 0,
    'delta freed; getSummary(t) now empty');
});

test('session-cumulative sums across requests regardless of depth and survives end+drop', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.logLlmCall(call('tool-loop', 10, 'r1'));
  log.endRequest('r1'); log.dropRequest('r1');
  log.startRequest('r2');
  log.logLlmCall(call('tool-loop', 7, 'r2'));
  log.endRequest('r2'); log.dropRequest('r2');
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
  log.logLlmCall(call('embedding', 4));
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
  /** Enter a request scope. Nested-safe: depth-counted, bucket created if absent,
   *  NEVER clears an existing bucket. */
  startRequest(requestId?: string): void;
  /** Leave a request scope. Depth-counted; NEVER deletes the bucket. */
  endRequest(requestId?: string): void;
  /** Explicitly free a request delta. The top-level owner (server) calls this
   *  AFTER reading getSummary(requestId) for the response usage. */
  dropRequest(requestId?: string): void;
  getSummary(requestId?: string): RequestSummary;
  reset(): void;
}
```

> `DefaultRequestLogger` and `NoopRequestLogger` keep working: add a `dropRequest(requestId?)` method and widen `startRequest/endRequest/getSummary` to accept the optional arg. For `DefaultRequestLogger`, map `dropRequest` to whatever its current `endRequest` did (its single-request semantics are unchanged — it has no nesting); for `NoopRequestLogger`, no-op. Build will flag every implementer; fix each by widening the signature + adding the no-op/`dropRequest`.

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
 * One logger per SessionGraph, shared by the coordinator AND its workers. Two
 * accounting axes (spec C.2):
 *  - session-cumulative (survives across requests, for /v1/usage),
 *  - per-traceId delta (for response.usage; keyed so concurrent requests never
 *    stomp each other).
 *
 * NESTED-SAFE: a worker's SmartAgent.process() runs startRequest(traceId) /
 * endRequest(traceId) under the SAME traceId as the coordinator. Therefore:
 *   - startRequest is depth-counted and creates the bucket ONLY if absent
 *     (never clears an existing one — a worker start must not wipe coordinator
 *     tokens already logged under that traceId),
 *   - endRequest is depth-counted and NEVER deletes the bucket (a worker end
 *     must not drop the delta before the server emits response.usage),
 *   - dropRequest is the explicit free, called by the top-level owner (the
 *     server) AFTER it has read getSummary(traceId).
 */
export class SessionRequestLogger implements IRequestLogger {
  private readonly cumulative = emptyBucket();
  private readonly deltas = new Map<string, Bucket>();
  private readonly depth = new Map<string, number>();

  startRequest(requestId?: string): void {
    if (!requestId) return;
    this.depth.set(requestId, (this.depth.get(requestId) ?? 0) + 1);
    if (!this.deltas.has(requestId)) this.deltas.set(requestId, emptyBucket());
  }

  endRequest(requestId?: string): void {
    if (!requestId) return;
    const d = this.depth.get(requestId);
    if (d === undefined) return;
    if (d <= 1) this.depth.delete(requestId);
    else this.depth.set(requestId, d - 1);
    // Intentionally does NOT delete the delta bucket: the server frees it via
    // dropRequest() after reading response.usage.
  }

  /** Explicit free of a request delta. Called once by the top-level owner. */
  dropRequest(requestId?: string): void {
    if (!requestId) return;
    this.deltas.delete(requestId);
    this.depth.delete(requestId);
  }

  logLlmCall(entry: LlmCallEntry): void {
    this.cumulative.llm.push(entry);
    if (entry.requestId) this.deltaFor(entry.requestId).llm.push(entry);
  }
  logRagQuery(entry: RagQueryEntry & { requestId?: string }): void {
    this.cumulative.rag++;
    if (entry.requestId) this.deltaFor(entry.requestId).rag++;
  }
  logToolCall(entry: ToolCallEntry & { requestId?: string }): void {
    this.cumulative.tool++;
    if (entry.requestId) this.deltaFor(entry.requestId).tool++;
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
    this.depth.clear();
  }

  /** Get-or-create the delta bucket for a requestId (used by log* when a call
   *  arrives before startRequest, e.g. a deeply nested worker). */
  private deltaFor(requestId: string): Bucket {
    let b = this.deltas.get(requestId);
    if (!b) { b = emptyBucket(); this.deltas.set(requestId, b); }
    return b;
  }
}
```

> Implementer note: match the exact `RequestSummary`/bucket shape from `DefaultRequestLogger.getSummary` (grep its return). Extract the shared body into `aggregate` and have `DefaultRequestLogger` call it too if trivial; otherwise keep `aggregate` local but mirror the shape exactly so `/v1/usage` payloads stay identical.

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS (7 tests); build clean (after widening all `IRequestLogger` impls + adding `dropRequest`).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/request-logger.ts packages/llm-agent-libs/src/logger/session-request-logger.ts packages/llm-agent-libs/src/logger/__tests__/session-request-logger.test.ts
git commit -m "feat(usage): nested-safe SessionRequestLogger — depth-counted startRequest/endRequest, explicit dropRequest, session-cumulative + per-traceId delta"
```

---

### Task A4: `SessionGraph` (per-session instances + refcount + drain flag)

A `SessionGraph` holds the per-session runtime objects produced by the factory and a refcount that pins it against eviction while requests are in flight. It also carries a **mark-for-disposal** flag so the registry can drain a pinned graph (spec A.4). It holds the two sessionId-keyed registries + the session logger + an injected per-session `agent` and `disposeFn`; the factory (A8) populates them. The graph stays construction-injectable so it is unit-testable without the full builder.

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

### Task A5: Expose `ragRegistry` + `mcpClients` on `SmartAgentHandle`

The `SessionGraphFactory` injects the global `ragRegistry`/`toolsRag`/MCP clients it gets from the once-built handle. Today the handle exposes neither `ragRegistry` nor `mcpClients`; add both (the factory needs `mcpClients` to call `withMcpClients(...)` and skip connect+vectorize).

**Files:**
- Modify: `packages/llm-agent/src/interfaces/builder.ts` (add `ragRegistry` + `mcpClients` to `SmartAgentHandle`)
- Modify: `packages/llm-agent-libs/src/builder.ts:1365-1381` (return both)
- Test: `packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { makeTestLlm } from '../testing/index.js'; // existing test helper for a fake ILlm

test('build() exposes the ragRegistry it composed and an mcpClients array', async () => {
  const reg = new SimpleRagRegistry();
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeTestLlm())
    .setRagRegistry(reg)
    .build();
  assert.equal(handle.ragRegistry, reg);
  assert.ok(Array.isArray(handle.mcpClients));
  await handle.close();
});
```

> Implementer note: use whatever fake-LLM helper `packages/llm-agent-libs/src/testing/index.ts` exports (grep for a `makeTestLlm`/`FakeLlm`/`makeDefaultDeps` equivalent); the load-bearing assertions are `handle.ragRegistry === reg` and `Array.isArray(handle.mcpClients)`.

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts` — Expected: FAIL (`ragRegistry`/`mcpClients` not on handle / type error).

- [ ] **Step 3: Implement**

In `packages/llm-agent/src/interfaces/builder.ts`, add to `SmartAgentHandle` (after `ragStores`):

```ts
  /** The RAG registry composed by the builder (shared global, injected per-session). */
  ragRegistry: IRagRegistry;
  /** The connected upstream MCP clients (shared global, injected per-session
   *  via withMcpClients to skip re-connect + re-vectorize). Empty when no MCP. */
  mcpClients: IMcpClient[];
```

Ensure `IRagRegistry` and `IMcpClient` are imported in that file (both are already used elsewhere in the interfaces package; add the imports if missing).

In `packages/llm-agent-libs/src/builder.ts`, in the `return { ... }` object (`:1365`), add `ragRegistry,` (the local from `:764`) and `mcpClients,` (the connected-clients local resolved in the build path; if no local exists, use `this._mcpClients ?? []`).

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/builder.ts packages/llm-agent-libs/src/builder.ts packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts
git commit -m "feat(session): expose ragRegistry + mcpClients on SmartAgentHandle for per-session injection"
```

---

### Task A6: Inject sessionId-keyed registries into the pipeline

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

In `packages/llm-agent/src/interfaces/types.ts`, extend `CallOptions` (it already has `sessionId`/`userId`/`trace`) with two optional carriers, typed structurally to avoid a contracts→libs cycle:

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

### Task A7: Cache global per-worker LLM/embedder clients + parameterize `buildSubAgent` by injected resources

> **Moved early (review HIGH #1):** the parameterized `buildSubAgent` is defined HERE, before the `SessionGraphFactory` (A8) and the server wiring (A10) that invoke it. Strict top-to-bottom now compiles in order. (Previously this work lived in old Task B1, AFTER the A-phase tasks that already called the parameterized form — that broke top-to-bottom execution.)

Three coupled changes, all in `smart-server.ts`:

1. **Cache the global per-worker LLM/embedder clients (review MEDIUM #3).** Today `buildSubAgent` (`:953-1004`) calls `makeLlm(...)` on every invocation — so a per-session rebuild would construct **new** LLM clients per session, breaking the locked invariant "LLM/embedder clients are global heavy resources built once and injected by reference." Hoist the per-worker `makeLlm(...)` (main/classifier/optional helper) + embedder resolution to a **one-time** step keyed by worker name, the first time the server builds subagents. Cache the resulting `ILlm`/embedder instances in `this._workerLlmCache: Map<string, WorkerLlmSet>`. Per-session worker assembly then RE-WIRES with these cached instances by reference — it never constructs new LLM clients or re-vectorizes.
2. **Share the parent `IRagRegistry`** (`setRagRegistry`) so session/user/global collections written at the top level are visible to workers; the per-call scope filter (`rag-query.ts:73-86`) isolates by `ctx.sessionId`/`ctx.options.userId`. A worker's own declared store registers INTO the shared registry under its namespace.
3. **Parameterize `buildSubAgent` by an optional injected record** so the per-session `buildSessionAgent` (A10) can re-wire a fresh worker per session that shares the session logger + the global toolsRag/MCP clients + the cached per-worker LLM/embedder. The injected record is the full GLOBAL set per worker:
   `{ ragRegistry, toolsRag, mcpClients, requestLogger, mainLlm, classifierLlm, helperLlm?, embedder }`.
   The param is **optional**: the primary `build()` path (which builds the global agent once and is where the cache is populated) keeps working unchanged when it does not pass injected LLMs (it builds them, then caches them).

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` — add `WorkerLlmSet` type + `this._workerLlmCache`; add `resolveSubAgentRagRegistry`; split `buildSubAgent` into a cached LLM/embedder resolver + a re-wire body parameterized by `injected?`.
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/worker-llm-cache.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
import { resolveSubAgentRagRegistry } from '../smart-server.js';

test('subagent reuses the injected parent registry instead of a fresh one', () => {
  const parent = new SimpleRagRegistry();
  assert.equal(resolveSubAgentRagRegistry({ parentRagRegistry: parent }), parent);
});

test('without an injected parent registry, returns undefined (builder allocates its own)', () => {
  assert.equal(resolveSubAgentRagRegistry({ parentRagRegistry: undefined }), undefined);
});
```

```ts
// packages/llm-agent-server/src/smart-agent/__tests__/worker-llm-cache.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerLlmSet } from '../smart-server.js';

// A worker LLM set is built ONCE per worker name and reused by reference on
// subsequent (per-session) calls — never reconstructed. The factory counts how
// many times it actually constructs an LLM.
test('resolveWorkerLlmSet builds once per worker and returns the cached set by reference', async () => {
  let built = 0;
  const cache = new Map<string, { mainLlm: object; classifierLlm: object; helperLlm?: object; embedder?: object }>();
  const fakeMake = async () => { built++; return {} as object; };

  const first = await resolveWorkerLlmSet({
    name: 'w', cache, makeMain: fakeMake, makeClassifier: fakeMake,
  });
  const second = await resolveWorkerLlmSet({
    name: 'w', cache, makeMain: fakeMake, makeClassifier: fakeMake,
  });

  assert.equal(first, second, 'same cached set instance returned by reference');
  assert.equal(first.mainLlm, second.mainLlm, 'main LLM not rebuilt');
  assert.equal(first.classifierLlm, second.classifierLlm, 'classifier LLM not rebuilt');
  assert.equal(built, 2, 'exactly two constructions total (main + classifier), once — NOT per call');
});
```

> Implementer note: `resolveWorkerLlmSet` is the extracted, unit-testable seam that performs the `makeLlm`/embedder construction the first time a worker name is seen and stores it in `cache`. The `makeMain`/`makeClassifier`/`makeHelper` closures in production wrap the existing `:953-1004` `makeLlm(...)` calls (preserving the same provider/temperature derivation); the test injects stubs. The load-bearing assertion is `built === 2` (one main + one classifier built once across two calls), proving no per-session reconstruction.

- [ ] **Step 2: Run** both tests — Expected: FAIL (`resolveSubAgentRagRegistry` / `resolveWorkerLlmSet` not exported).

- [ ] **Step 3: Implement**

Add the RAG resolver:

```ts
import type { IRagRegistry } from '@mcp-abap-adt/llm-agent';

export function resolveSubAgentRagRegistry(input: {
  parentRagRegistry: IRagRegistry | undefined;
}): IRagRegistry | undefined {
  // Share the injected parent registry when present: session/user/global
  // collections created at the top level become visible to the worker; the
  // per-call scope filter isolates by ctx.sessionId/ctx.options.userId. A
  // worker's own declared store is registered INTO this same registry.
  return input.parentRagRegistry;
}
```

Add the worker-LLM cache type + the cached resolver (the GLOBAL per-worker LLM/embedder set, built once):

```ts
import type { ILlm, IEmbedder } from '@mcp-abap-adt/llm-agent';

/** GLOBAL per-worker heavy clients — built once, injected by reference per session. */
export interface WorkerLlmSet {
  mainLlm: ILlm;
  classifierLlm: ILlm;
  helperLlm?: ILlm;
  embedder?: IEmbedder;
}

/**
 * Build-once-per-worker resolver. The first time a worker name is seen, it
 * constructs the worker's main/classifier/(optional helper) LLM + embedder and
 * caches the set; every later call (e.g. each per-session worker re-wire)
 * returns the SAME set by reference — never reconstructing LLM clients
 * (locked invariant: LLM/embedder clients are global, built once).
 */
export async function resolveWorkerLlmSet(input: {
  name: string;
  cache: Map<string, WorkerLlmSet>;
  makeMain: () => Promise<ILlm>;
  makeClassifier: () => Promise<ILlm>;
  makeHelper?: () => Promise<ILlm>;
  makeEmbedder?: () => Promise<IEmbedder>;
}): Promise<WorkerLlmSet> {
  const hit = input.cache.get(input.name);
  if (hit) return hit;
  const mainLlm = await input.makeMain();
  const classifierLlm = await input.makeClassifier();
  const helperLlm = input.makeHelper ? await input.makeHelper() : undefined;
  const embedder = input.makeEmbedder ? await input.makeEmbedder() : undefined;
  const set: WorkerLlmSet = { mainLlm, classifierLlm, helperLlm, embedder };
  input.cache.set(input.name, set);
  return set;
}
```

Add the cache field on the server (next to the other build-time fields):

```ts
  private readonly _workerLlmCache = new Map<string, WorkerLlmSet>();
```

Refactor `buildSubAgent` (`:940-1030`) to (a) resolve the worker LLM set through the cache (so LLMs are built once), and (b) accept the optional injected resources, RE-WIRING with them rather than constructing new clients:

```ts
  private async buildSubAgent(
    name: string,
    subCfg: Omit<SmartServerConfig, 'log'>,
    parentLogger: ILogger,
    embedderFactories: Record<string, EmbedderFactory>,
    injected?: {
      ragRegistry: IRagRegistry;
      toolsRag: IRag | undefined;
      mcpClients: IMcpClient[];
      requestLogger: IRequestLogger;
      mainLlm: ILlm;
      classifierLlm: ILlm;
      helperLlm?: ILlm;
      embedder?: IEmbedder;
    },
  ): Promise<SmartAgent> {
    if (!subCfg.llm?.apiKey && !subCfg.pipeline?.llm?.main) {
      throw new Error(`subagent '${name}': LLM API key is required`);
    }
    const subPipeline = subCfg.pipeline;

    // LLM/embedder clients: when the per-session re-wire injected them, use those
    // cached instances by reference (NEVER reconstruct). Otherwise (the primary
    // build()), build-once via the cache so the global agent build also populates
    // it and later per-session re-wires reuse the SAME instances.
    let mainLlm: ILlm;
    let classifierLlm: ILlm;
    let helperLlm: ILlm | undefined;
    let embedder: IEmbedder | undefined;
    if (injected) {
      mainLlm = injected.mainLlm;
      classifierLlm = injected.classifierLlm;
      helperLlm = injected.helperLlm;
      embedder = injected.embedder;
    } else {
      const mainTemp = Number(
        subPipeline?.llm?.main?.temperature ?? subCfg.llm.temperature ?? 0.7,
      );
      const classifierTemp = Number(
        subPipeline?.llm?.classifier?.temperature ?? subCfg.llm.classifierTemperature ?? 0.1,
      );
      const set = await resolveWorkerLlmSet({
        name,
        cache: this._workerLlmCache,
        // Preserve the existing :953-1004 makeLlm derivation exactly.
        makeMain: () => subPipeline?.llm?.main
          ? makeLlm(subPipeline.llm.main, mainTemp)
          : makeLlm(
              { provider: subCfg.llm.provider ?? 'deepseek', apiKey: subCfg.llm.apiKey, baseURL: subCfg.llm.url, model: subCfg.llm.model },
              mainTemp,
            ),
        makeClassifier: () => subPipeline?.llm?.classifier
          ? makeLlm(subPipeline.llm.classifier, classifierTemp)
          : subPipeline?.llm?.main
            ? makeLlm(subPipeline.llm.main, classifierTemp)
            : makeLlm(
                { provider: subCfg.llm.provider ?? 'deepseek', apiKey: subCfg.llm.apiKey, baseURL: subCfg.llm.url, model: subCfg.llm.model },
                classifierTemp,
              ),
        makeHelper: subPipeline?.llm?.helper
          ? () => makeLlm(subPipeline.llm.helper, Number(subPipeline.llm.helper.temperature ?? 0.1))
          : undefined,
        // Embedder (when the worker config declares one) — resolved once too.
        makeEmbedder: subCfg.embedder
          ? () => resolveEmbedder(subCfg.embedder, embedderFactories)
          : undefined,
      });
      mainLlm = set.mainLlm;
      classifierLlm = set.classifierLlm;
      helperLlm = set.helperLlm;
      embedder = set.embedder;
    }

    let subBuilder = new SmartAgentBuilder({
      mcp: subPipeline?.mcp ?? subCfg.mcp,
      agent: subCfg.agent,
      prompts: subCfg.prompts,
      skipModelValidation: subCfg.skipModelValidation,
    })
      .withMainLlm(mainLlm)
      .withClassifierLlm(classifierLlm)
      .withLogger(parentLogger)
      .withMode(subCfg.mode ?? 'smart');
    if (helperLlm) subBuilder = subBuilder.withHelperLlm(helperLlm);

    // SHARE the parent RAG registry + session logger when injected (per-session
    // worker re-wire). The per-call scope filter isolates by ctx.sessionId.
    const sharedReg = resolveSubAgentRagRegistry({ parentRagRegistry: injected?.ragRegistry });
    if (sharedReg) subBuilder = subBuilder.setRagRegistry(sharedReg);
    if (injected?.requestLogger) subBuilder = subBuilder.withRequestLogger(injected.requestLogger);

    // Tools RAG: prefer the injected GLOBAL toolsRag (already vectorized) when
    // present; otherwise build only when the subagent declares its own store
    // (primary build()). NEVER re-vectorize during a per-session re-wire.
    if (injected?.toolsRag) {
      subBuilder = subBuilder.setToolsRag(injected.toolsRag);
    } else if (subCfg.rag) {
      const ragOptions = { injectedEmbedder: subCfg.embedder, extraFactories: embedderFactories };
      subBuilder = subBuilder.setToolsRag(await makeRag(subCfg.rag, ragOptions));
      subBuilder = subBuilder.setHistoryRag(await makeRag({ ...subCfg.rag }, ragOptions));
    }

    if (subCfg.skillManager) {
      subBuilder = subBuilder.withSkillManager(subCfg.skillManager);
    }

    // MCP clients: inject the GLOBAL connected clients per session (skips
    // re-connect); else fall back to the subagent's own configured clients.
    if (injected?.mcpClients && injected.mcpClients.length > 0) {
      subBuilder = subBuilder.withMcpClients(injected.mcpClients);
    } else if (subCfg.mcpClients && subCfg.mcpClients.length > 0) {
      subBuilder = subBuilder.withMcpClients(subCfg.mcpClients);
    }

    const handle = await subBuilder.build();
    return handle.agent;
  }
```

> Implementer note:
> - The primary `build()` call site (`:612`) passes NO `injected` arg — behavior unchanged for the global agent build, EXCEPT it now resolves LLMs through `resolveWorkerLlmSet` so the cache is populated. The per-session `buildSessionAgent` (A10) passes the full injected record, including the cached per-worker LLM/embedder pulled from `this._workerLlmCache.get(name)`.
> - When `injected` is provided, the old isolated `setToolsRag(makeRag(...))` / `setHistoryRag(makeRag(...))` (`:1012-1017`) is skipped — tools/history RAG comes from the shared registry / injected toolsRag (no re-vectorize).
> - Import `IRag`, `IMcpClient`, `IRequestLogger`, `ILlm`, `IEmbedder` from `@mcp-abap-adt/llm-agent` if not already imported; import `resolveEmbedder` from `@mcp-abap-adt/llm-agent-rag` if the embedder branch is used (verify the exact embedder-resolution helper the server already uses at build — grep `resolveEmbedder`/`prefetchEmbedderFactories`; if the embedder is not separately resolvable in this server, drop the embedder branch and let the shared registry's store carry its embedder, keeping the `embedder?` slot for forward-compat).

- [ ] **Step 4: Run** both tests + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts packages/llm-agent-server/src/smart-agent/__tests__/worker-llm-cache.test.ts
git commit -m "feat(session): cache global per-worker LLM/embedder once + parameterize buildSubAgent by injected resources (share parent RAG registry, session logger; per-session re-wire never rebuilds LLM clients)"
```

---

### Task A8: `SessionGraphFactory` — compose per-session graph (incl. FRESH per-session workers) from injected globals

The central new composition path (spec A.2). `build(identity)` resolves this session's MCP client(s) via the injected `mcpClientFactory(identity)` (default: shared global client(s) by reference) and constructs a per-session `SmartAgent` **and a fresh per-session worker set** by re-running `SmartAgentBuilder.build()` **with the heavy globals injected**: `withMcpClients(resolvedMcpClients)` (skips connect+vectorize — `builder.ts:880-882`), `setToolsRag(globalToolsRag)`, `setRagRegistry(globalRagRegistry)`, the cached per-worker LLM/embedder (from A7), and a fresh per-session `SessionRequestLogger` via `withRequestLogger`. It also creates the two sessionId-keyed registries and wires `dispose` to `globalRagRegistry.closeSession`. The tools-catalog `toolsRag` is the SAME global instance every session (never re-vectorized).

> **Review HIGH #1 — why per-session workers, and why this depends on A7:** the server builds subagents ONCE before the main handle (`smart-server.ts:610-632`), wraps them in `SmartAgentSubAgent` (`:620`), and keeps that global worker map in the DAG deps (`:719-728`). Reusing that global worker map per session would keep workers GLOBAL with their original `DefaultRequestLogger`/RAG — contradicting per-session workers + one shared session logger. So the factory's `buildAgent` MUST re-wire a fresh `SubAgentRegistry` + DAG coordinator deps **per session**, re-wiring each worker via the parameterized `buildSubAgent` from A7 (which injects globals + the session logger + the cached per-worker LLM/embedder). Re-wiring per session stays cheap because the LLMs/toolsRag/MCP clients are injected (no construct, no re-vectorize). The factory invokes the server-supplied `buildAgent` seam that performs this fresh-per-session assembly.

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

function makeRagRegistry() {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return reg;
}

test('build(identity) yields a graph whose registries+logger differ per session and shares the injected RAG registry; buildAgent receives a FRESH logger per session', async () => {
  const ragRegistry = makeRagRegistry();
  const seenLoggers: unknown[] = [];
  let mcpFactoryCalls = 0;
  const factory = new SessionGraphFactory({
    mcpClientFactory: (_identity) => { mcpFactoryCalls++; return []; }, // default-style: shared (empty here)
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async (parts) => {
      // The factory feeds parts (sessionId, logger, mcpClients, toolsRag, ragRegistry)
      // into the server's fresh-per-session worker assembly; here we assert wiring.
      assert.equal(parts.ragRegistry, ragRegistry);
      assert.ok(parts.logger);
      seenLoggers.push(parts.logger);
      return undefined; // pure-wiring test: real impl returns the built agent
    },
  });

  const g1 = await factory.build({ sessionId: 's1' });
  const g2 = await factory.build({ sessionId: 's2' });
  assert.notEqual(g1, g2);
  assert.notEqual(g1.toolAvailability, g2.toolAvailability);
  assert.notEqual(g1.pendingToolResults, g2.pendingToolResults);
  assert.notEqual(g1.logger, g2.logger);
  assert.equal(g1.sessionId, 's1');
  // The logger each buildAgent saw is exactly the one its graph exposes (fresh per session).
  assert.equal(seenLoggers[0], g1.logger);
  assert.equal(seenLoggers[1], g2.logger);
  // MCP client is resolved per session via the factory (default returns shared global).
  assert.equal(mcpFactoryCalls, 2);
});

test('dispose() of a graph closes session collections on the shared registry only', async () => {
  const ragRegistry = makeRagRegistry();
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async () => undefined,
  });
  await ragRegistry.createCollection({ providerName: 'mem', collectionName: 'g-s1', scope: 'session', sessionId: 's1' });
  assert.ok(ragRegistry.get('g-s1'));
  const g = await factory.build({ sessionId: 's1' });
  await g.dispose();
  assert.equal(ragRegistry.get('g-s1'), undefined, 'session collection removed on dispose');
});
```

> Implementer note: the test injects a `buildAgent` seam so the factory is unit-testable without a real MCP/LLM stack. In production the server supplies a `buildAgent` that performs the fresh-per-session worker re-wire (Task A10). The registry-isolation + fresh-logger assertions are what matter.

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

/** Parts handed to `buildAgent` — the injected globals + per-session services.
 *  The server's buildAgent uses these to assemble a FRESH per-session agent AND
 *  a fresh per-session worker set (each worker re-wired via the inject-globals
 *  path with this session's logger + the cached per-worker LLM/embedder). */
export interface SessionAgentParts {
  readonly sessionId: string;
  readonly mcpClients: IMcpClient[];
  readonly toolsRag: IRag | undefined;
  readonly ragRegistry: IRagRegistry;
  readonly logger: SessionRequestLogger;
}

export interface SessionGraphFactoryOptions {
  /** Resolve this session's MCP client(s). Per-session-CAPABLE: the default
   *  factory returns the shared GLOBAL client(s) by reference (no re-connect);
   *  a creds-aware build (out of scope) returns a fresh per-session client.
   *  Either way the tools-catalog RAG is never re-vectorized. */
  readonly mcpClientFactory: (identity: SessionGraphIdentity) => IMcpClient[];
  /** GLOBAL vectorized tools-catalog RAG — injected by reference, never re-vectorized. */
  readonly toolsRag: IRag | undefined;
  /** GLOBAL RAG provider/registry — shared; the per-call scope filter isolates. */
  readonly ragRegistry: IRagRegistry;
  /**
   * Builds the per-session SmartAgent + FRESH per-session workers from `parts`.
   * Production wiring runs a `SmartAgentBuilder.build()` with the injected globals
   * + this session's logger AND re-wires the subagent registry/DAG deps per session
   * (Task A10), reusing the cached per-worker LLM/embedder (Task A7). Tests inject
   * a stub. Returns the built agent (or undefined in pure-wiring tests).
   */
  readonly buildAgent: (parts: SessionAgentParts) => Promise<SmartAgent | undefined>;
}

/**
 * Central per-session composition path (spec A.2). Assembles a SessionGraph by
 * injecting the GLOBAL heavy resources (vectorized toolsRag, RAG registry,
 * cached per-worker LLM/embedder) by reference — never re-vectorizing tools or
 * rebuilding LLM clients — resolving this session's MCP client(s) via
 * `mcpClientFactory(identity)` (default: shared global by reference), and
 * allocating the cheap
 * per-session instances (logger + sessionId-keyed registries + the per-session
 * agent/pipeline/interpreter/coordinator/WORKERS). The per-session worker set is
 * FRESH per session (re-wired via buildAgent with the session logger), never the
 * server's global worker map.
 */
export class SessionGraphFactory {
  constructor(private readonly opts: SessionGraphFactoryOptions) {}

  async build(identity: SessionGraphIdentity): Promise<SessionGraph> {
    const logger = new SessionRequestLogger();
    const toolAvailability = new ToolAvailabilityRegistry();
    const pendingToolResults = new PendingToolResultsRegistry();

    const mcpClients = this.opts.mcpClientFactory(identity);
    const agent = await this.opts.buildAgent({
      sessionId: identity.sessionId,
      mcpClients,
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
git commit -m "feat(session): SessionGraphFactory composes per-session graph + FRESH per-session workers from injected globals (no MCP reconnect / re-vectorize / LLM rebuild)"
```

---

### Task A9: `SessionRegistry` with single-flight build + TTL/LRU + drain semantics

Owns `Map<sessionId, SessionGraph>`, lazy-builds via `SessionGraphFactory.build`, and evicts idle/over-cap graphs respecting the refcount.

> **Review HIGH #2 — single-flight build (race fix):** `factory.build` is async, so two concurrent requests for the SAME new sessionId could both observe `!graph`, both `await factory.build(...)`, and create two different graphs for one session (one leaks; requests split across runtimes). `acquire` is therefore **async** and uses a **single-flight guard**: a `private pendingBuilds = new Map<string, Promise<SessionGraph>>()`. The first caller stores its in-flight build promise; concurrent callers `await` the SAME promise. The pending entry is cleared once the build settles and the resulting graph is stored in the main Map.

> **Drain semantics (spec A.4):** `enforceCap` marks the LRU candidate for disposal even if pinned (instead of `break`); `release(sessionId)` disposes a marked graph when refcount hits 0; `release` uses a **non-creating lookup** (never `acquire`, so it can't resurrect a removed session).

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

function fakeFactory(disposed: string[], counter?: { n: number }) {
  return {
    build: async (identity: { sessionId: string }) => {
      if (counter) counter.n++;
      // Yield a microtask so concurrent acquire() of the same new id overlaps the build.
      await Promise.resolve();
      return new SessionGraph({
        sessionId: identity.sessionId,
        toolAvailability: new ToolAvailabilityRegistry(),
        pendingToolResults: new PendingToolResultsRegistry(),
        logger: new SessionRequestLogger(),
        dispose: async (id) => { disposed.push(id); },
      });
    },
  };
}

function makeRegistry(over: Partial<{ idleTtlMs: number; maxSessions: number }> = {}, counter?: { n: number }) {
  const disposed: string[] = [];
  const reg = new SessionRegistry({
    idleTtlMs: 10_000,
    maxSessions: 2,
    factory: fakeFactory(disposed, counter),
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

test('SINGLE-FLIGHT: concurrent acquire of the same NEW sessionId builds exactly once and returns the same graph instance', async () => {
  const counter = { n: 0 };
  const { reg } = makeRegistry({}, counter);
  // Two concurrent acquires for the same brand-new id — both see !graph before the
  // first build settles, but the single-flight guard must collapse them to ONE build.
  const [g1, g2] = await Promise.all([reg.acquire('new'), reg.acquire('new')]);
  assert.equal(counter.n, 1, 'factory.build called exactly once for the new sessionId');
  assert.equal(g1, g2, 'both callers receive the identical graph instance');
  assert.equal(g1.activeRequests, 2, 'both acquires pinned the same graph');
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
  /** Single-flight guard: in-flight builds keyed by sessionId (review HIGH #2). */
  private readonly pendingBuilds = new Map<string, Promise<SessionGraph>>();
  private readonly pending: Promise<void>[] = [];

  constructor(private readonly opts: SessionRegistryOptions) {}

  get size(): number { return this.graphs.size; }

  /**
   * Lazy-build + pin. Async because factory.build is async. SINGLE-FLIGHT: two
   * concurrent acquires for the SAME new sessionId await the SAME build promise
   * and receive the identical graph (never two graphs for one session). Each
   * in-flight request increments the refcount (spec A.4).
   */
  async acquire(sessionId: string): Promise<SessionGraph> {
    let g = this.graphs.get(sessionId);
    if (!g) {
      let build = this.pendingBuilds.get(sessionId);
      if (!build) {
        build = this.opts.factory.build({ sessionId }).then((graph) => {
          this.graphs.set(sessionId, graph);
          this.pendingBuilds.delete(sessionId);
          this.enforceCap();
          return graph;
        }).catch((err) => {
          // Clear the in-flight entry so a later request can retry the build.
          this.pendingBuilds.delete(sessionId);
          throw err;
        });
        this.pendingBuilds.set(sessionId, build);
      }
      g = await build;
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

- [ ] **Step 4: Run** the test — Expected: PASS (6 tests, incl. single-flight).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/session/session-registry.ts packages/llm-agent-libs/src/session/__tests__/session-registry.test.ts
git commit -m "feat(session): SessionRegistry with single-flight build guard + idle-TTL + LRU + drain semantics (async acquire, mark pinned, dispose on release)"
```

---

### Task A10: Wire the server to cookie identity + SessionGraphFactory + SessionRegistry (fresh per-session workers + `dropRequest` after usage)

Build the GLOBAL handle once (`builder.build()` at `:783`), construct the `SessionGraphFactory` from its injected globals (`agentHandle.ragRegistry`, the global `toolsRag`, `agentHandle.mcpClients`) and a `SessionRegistry`. In `_handle`: replace `x-session-id` (`:1343`) with the cookie resolver, `await lifecycle.acquire(sessionId)`, `Set-Cookie` when minted, run the request **on the session graph's agent** with `opts.sessionId = sessionId` + `opts.trace.traceId` + `opts.toolAvailability/pendingToolResults` from the graph, read the response usage from `graph.logger.getSummary(traceId)`, then `graph.logger.dropRequest(traceId)` **and** `lifecycle.release(sessionId)` in `finally`. Start an idle-TTL sweep timer. Config from a new `session` block.

> **Review HIGH #2 (dropRequest ownership):** the server is the top-level owner of the request delta. The per-session agent + its workers call `startRequest(traceId)`/`endRequest(traceId)` (nested, same traceId) but NEVER `dropRequest`. The server calls `dropRequest(traceId)` once, in the request `finally`, AFTER it has read the usage. This is the only place the delta is freed.

> **Review HIGH #1 (fresh per-session workers, no LLM rebuild):** the server's `buildAgent` re-wires a FRESH `SubAgentRegistry` + DAG coordinator deps PER SESSION via the parameterized `buildSubAgent` (A7). It does NOT reuse the global `registry`/DAG-deps captured during the primary `build()`. Each worker is re-wired with the full injected record `{ ragRegistry, toolsRag, mcpClients, requestLogger: parts.logger, mainLlm, classifierLlm, helperLlm?, embedder }` — the LLM/embedder taken from the cache `this._workerLlmCache.get(name)` (A7), so per-session assembly never constructs new LLM clients.

> **`acquire` is async (review HIGH #2):** all call sites in `_handle` and `/v1/usage` (C8) `await lifecycle.acquire(...)`.

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts` (`build`: capture global MCP clients + toolsRag; build factory + registry + sweep timer; `_handle`: resolve/acquire/run-on-graph/read-usage/drop+release)
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
    buildAgent: async () => undefined,
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
    buildAgent: async () => undefined,
  });
  assert.notEqual(lc.resolve(undefined, false).identity.sessionId, lc.resolve(undefined, false).identity.sessionId);
});

test('dropRequest frees the delta but session-cumulative survives (server-owned free)', async () => {
  const lc = buildSessionLifecycle({
    idleTtlMs: 10_000, maxSessions: 100, cookieName: 'sid',
    mcpClients: [], toolsRag: undefined, ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
  });
  const g = await lc.acquire('s1');
  g.logger.startRequest('t');
  g.logger.logLlmCall({ component: 'tool-loop' as never, model: 'm', promptTokens: 9, completionTokens: 0, totalTokens: 9, durationMs: 1, requestId: 't' });
  g.logger.endRequest('t');                 // worker/agent end — delta survives
  assert.equal(g.logger.getSummary('t').byComponent['tool-loop'].totalTokens, 9);
  g.logger.dropRequest('t');                // server frees AFTER reading usage
  assert.equal(Object.keys(g.logger.getSummary('t').byComponent).length, 0);
  assert.equal(g.logger.getSummary().byComponent['tool-loop'].totalTokens, 9, 'cumulative survives');
  lc.release('s1');
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts` — Expected: FAIL (`buildSessionLifecycle` not exported).

- [ ] **Step 3: Implement `buildSessionLifecycle`, the per-session worker re-wire, and wire `_handle`**

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
    // Default mcpClientFactory: every session shares the once-built GLOBAL
    // client(s) by reference (single upstream connection — the default server
    // case). A credentials-aware build (out of scope) swaps this for a factory
    // returning a fresh per-session client from per-session ABAP creds.
    mcpClientFactory: (_identity) => opts.mcpClients,
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
    acquire: (sessionId: string) => registry.acquire(sessionId), // async
    release: (sessionId: string) => registry.release(sessionId),
    evictIdle: () => registry.evictIdle(),
    disposeAll: () => registry.disposeAll(),
    registry,
  };
}
```

In `build()`, after `agentHandle = await builder.build()` (`:783`) and the destructure (`:784`), capture the globals and wire the per-session `buildAgent` that **re-wires fresh workers per session**:

```ts
    const { ragRegistry, mcpClients: globalMcpClients } = agentHandle; // Task A5 added both
    // GLOBAL toolsRag captured above as `toolsRag` (server local, :484/:520).
    const sessionCfg = this.cfg.session ?? {};
    const lifecycle = buildSessionLifecycle({
      idleTtlMs: sessionCfg.idleTtlMs ?? 7_200_000,
      maxSessions: sessionCfg.maxSessions ?? 1000,
      cookieName: sessionCfg.cookieName ?? 'sid',
      mcpClients: globalMcpClients,
      toolsRag,
      ragRegistry,
      buildAgent: (parts) => this.buildSessionAgent(parts),
    });
    this._lifecycle = lifecycle; // hoist to a field so _handle can use it
    const sweepMs = Math.min(sessionCfg.idleTtlMs ?? 7_200_000, 60_000);
    const sweep = setInterval(() => { void lifecycle.evictIdle(); }, sweepMs);
    sweep.unref?.();
    closeFns.push(async () => { clearInterval(sweep); await lifecycle.disposeAll(); });
```

Add the private `buildSessionAgent(parts)` that re-wires a FRESH per-session agent AND a FRESH per-session worker set + DAG deps, all on this session's logger + injected globals + the CACHED per-worker LLM/embedder:

```ts
  /**
   * Builds a per-session SmartAgent from injected globals. Re-wires the subagent
   * registry + DAG coordinator deps FRESH per session (review HIGH #1): each
   * worker is re-wired via the parameterized buildSubAgent (Task A7) with this
   * session's logger + the global ragRegistry/toolsRag/mcpClients + the CACHED
   * per-worker LLM/embedder (this._workerLlmCache). NEVER reuses the server's
   * global `registry`/DAG-deps from the primary build(), and NEVER constructs
   * new LLM clients (review MEDIUM #3).
   */
  private async buildSessionAgent(parts: SessionAgentParts): Promise<SmartAgent | undefined> {
    let b = new SmartAgentBuilder({
      agent: this.cfg.agent,
      prompts: this.cfg.prompts,
      skipModelValidation: this.cfg.skipModelValidation,
    })
      .withMainLlm(this._mainLlm)            // cached top-level global LLM (hoisted in build())
      .withClassifierLlm(this._classifierLlm)
      .withLogger(this._fileLogger)
      .withMode(this.cfg.mode ?? 'smart')
      .withMcpClients(parts.mcpClients)      // SKIPS connect + re-vectorize (builder.ts:880-882)
      .setRagRegistry(parts.ragRegistry)
      .withRequestLogger(parts.logger);      // per-session token-logger
    if (this._helperLlm) b = b.withHelperLlm(this._helperLlm);
    if (parts.toolsRag) b = b.setToolsRag(parts.toolsRag);

    // FRESH per-session workers: re-wire the registry from the SAME subagent
    // configs the primary build() used, injecting globals + the session logger +
    // the CACHED per-worker LLM/embedder so every worker shares this session's
    // accounting + the global toolsRag/ragRegistry/MCP clients, WITHOUT building
    // new LLM clients or re-vectorizing.
    if (this.cfg.subAgentConfigs && this.cfg.subAgentConfigs.length > 0) {
      const registry: SubAgentRegistry = new Map();
      for (const sub of this.cfg.subAgentConfigs) {
        const cached = this._workerLlmCache.get(sub.name); // populated by the primary build() (A7)
        if (!cached) throw new Error(`worker LLM set not cached for '${sub.name}'`);
        const subAgent = await this.buildSubAgent(sub.name, sub.config, this._fileLogger, this._mergedEmbedderFactories, {
          ragRegistry: parts.ragRegistry,
          toolsRag: parts.toolsRag,
          mcpClients: parts.mcpClients,
          requestLogger: parts.logger,
          mainLlm: cached.mainLlm,
          classifierLlm: cached.classifierLlm,
          helperLlm: cached.helperLlm,
          embedder: cached.embedder,
        });
        registry.set(sub.name, new SmartAgentSubAgent(sub.name, subAgent, { description: sub.description }));
      }
      b = b.withSubAgents(registry);
      // Re-wire the DAG coordinator deps per session against THIS worker set,
      // mirroring the primary build()'s coordinator resolution (planner/reviewer/
      // interpreter/stateOracle/errorStrategy/activation/maxRoundTrips).
      if (this._dagCoordinatorTemplate) {
        const workers: SubAgentRegistry = new Map(
          [...registry].filter(([name]) => name !== this._dagCoordinatorTemplate!.oracleName),
        );
        b = b.withDagCoordinator({
          ...this._dagCoordinatorTemplate.deps,   // planner/interpreter/reviewer/activation/errorStrategy/maxRoundTrips (stateless or LLM-bound, reusable)
          workers,
          stateOracle: this._dagCoordinatorTemplate.oracleName
            ? registry.get(this._dagCoordinatorTemplate.oracleName)
            : undefined,
        });
      }
    }
    const handle = await b.build();
    return handle.agent;
  }
```

> Implementer note (hoist to fields in `build()`): promote the existing `build()` locals into instance fields so `buildSessionAgent` reuses them by reference: `this._mainLlm`/`this._classifierLlm`/`this._helperLlm` (top-level LLM instances — reusable globals built once at `:376-412`), `this._fileLogger`, `this._mergedEmbedderFactories` (the `mergedEmbedderFactories` local at `:449`), and a `this._dagCoordinatorTemplate = { deps: { planner, interpreter, reviewer, activation, errorStrategy, maxRoundTrips }, oracleName }` captured where the primary DAG deps are resolved (`:719-728`). The planner/interpreter/reviewer/errorStrategy are stateless or LLM-bound and safe to reuse across sessions; only the **`workers` map and `stateOracle`** are re-wired per session. The per-worker LLM/embedder cache `this._workerLlmCache` is populated by the primary `build()`'s `buildSubAgent` calls (A7, no `injected` arg). Do NOT reuse the primary `registry` (`:609`) — that is the global worker map this finding forbids reusing.

In `_handle`, replace `:1342-1343` and wrap the run (note `await` on `acquire`):

```ts
    const lifecycle = this._lifecycle;
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
      // and inject the graph's sessionId-keyed registries + sessionId + traceId:
      //   opts.sessionId = sessionId;
      //   opts.toolAvailability = graph.toolAvailability;
      //   opts.pendingToolResults = graph.pendingToolResults;
      //   opts.trace = { traceId };
      // After the run completes, response.usage is set by the agent (Task C7)
      // from graph.logger.getSummary(traceId). For /v1/usage-free endpoints that
      // read usage explicitly, read it here BEFORE dropRequest.
    } finally {
      // Top-level owner frees the per-traceId delta AFTER usage was read; then
      // release the refcount pin (review HIGH #2).
      graph.logger.dropRequest(traceId);
      lifecycle.release(sessionId);
    }
```

> Implementer note: `opts.sessionId = sessionId` guarantees `ctx.sessionId == cookie session id` (verified seam: `default-pipeline.ts:388`, `agent.ts:672`). The endpoints that run the agent (`/v1/chat/completions` etc.) must use `graph.agent` and the `opts` additions above, and must `await lifecycle.acquire(...)`. The `dropRequest(traceId)` in `finally` runs after the streamed/awaited response has been assembled (so `response.usage` — set in Task C7 from `getSummary(traceId)` — is already computed). Order in `finally` is `dropRequest` then `release`.

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
git commit -m "feat(session): wire server to cookie identity + SessionGraphFactory + SessionRegistry (fresh per-session workers reusing cached LLMs, async acquire, dropRequest after usage, TTL sweep, closeSession on evict)"
```

---

### Task A11: Phase-A provability tests (spec A.6)

Covers: distinct graphs per session, single dispose on evict, `ctx.sessionId == cookie id`, and reentrancy (two concurrent same-session runs produce independent results with separate per-`traceId` deltas — and nested start/end don't corrupt them).

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
// the session logger but keep separate per-traceId deltas — no cross-talk — and
// nested worker start/end under one traceId must not corrupt that traceId's delta.
test('concurrent same-session requests keep independent per-traceId deltas', () => {
  const logger = new SessionRequestLogger(); // shared by the session graph
  logger.startRequest('trace-A');
  logger.startRequest('trace-B');
  logger.logLlmCall({ component: 'tool-loop' as never, model: 'm', promptTokens: 11, completionTokens: 0, totalTokens: 11, durationMs: 1, requestId: 'trace-A' });
  logger.logLlmCall({ component: 'tool-loop' as never, model: 'm', promptTokens: 22, completionTokens: 0, totalTokens: 22, durationMs: 1, requestId: 'trace-B' });
  assert.equal(logger.getSummary('trace-A').byComponent['tool-loop'].totalTokens, 11);
  assert.equal(logger.getSummary('trace-B').byComponent['tool-loop'].totalTokens, 22);
  assert.equal(logger.getSummary().byComponent['tool-loop'].totalTokens, 33);
});

test('nested worker start/end under one traceId does not corrupt the delta', () => {
  const logger = new SessionRequestLogger();
  logger.startRequest('t');                                   // coordinator
  logger.logLlmCall({ component: 'translate' as never, model: 'm', promptTokens: 5, completionTokens: 0, totalTokens: 5, durationMs: 1, requestId: 't' });
  logger.startRequest('t');                                   // worker (nested)
  logger.logLlmCall({ component: 'tool-loop' as never, model: 'm', promptTokens: 40, completionTokens: 0, totalTokens: 40, durationMs: 1, requestId: 't' });
  logger.endRequest('t');                                     // worker end
  logger.endRequest('t');                                     // coordinator end
  assert.equal(logger.getSummary('t').byComponent['translate'].totalTokens, 5);
  assert.equal(logger.getSummary('t').byComponent['tool-loop'].totalTokens, 40);
  logger.dropRequest('t');
  assert.equal(Object.keys(logger.getSummary('t').byComponent).length, 0);
});
```

> The `ctx.sessionId == cookie id` and malformed-cookie-mint guarantees are already proven by A2 (resolver) + A10 (`buildSessionLifecycle` sets `opts.sessionId = resolved.identity.sessionId`, and `ctx.sessionId = options?.sessionId` at `default-pipeline.ts:388`). The single-flight build guarantee is proven by A9's single-flight test. The reentrancy test depends on `SessionRequestLogger` (A3, already implemented above).

- [ ] **Step 2: Run** both files — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/session/__tests__/session-provability.test.ts packages/llm-agent-libs/src/session/__tests__/session-reentrancy.test.ts
git commit -m "test(session): phase-A provability — isolation, single dispose, reentrant + nested-safe per-traceId deltas"
```

---

## PHASE B — Worker session-RAG provability

> The `buildSubAgent` parameterization + shared parent registry moved EARLY into Task A7 (review HIGH #1) because the factory (A8) and server wiring (A10) depend on it. Phase B now holds only the session-RAG visibility provability that builds on the shared registry.

### Task B1: Phase-B provability — session artifact visibility (spec B.6)

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

## PHASE C — traceId threading + Session token-rollup

### Task C1: Thread `traceId` through subagent dispatch (interface + interpreter + coordinator + SmartAgentSubAgent)

Without threading `traceId` into worker dispatch, worker log entries land under no `requestId` and never reach the coordinator's per-`traceId` delta (review HIGH #2). Today `SmartAgentSubAgent.run()` calls `worker.process(prompt, { sessionId, signal })` and drops trace (`smart-agent-subagent.ts:29`); `InterpretContext` (`interpreter.ts:11`) and `ISubAgentInput` (`subagent.ts:18`) carry no trace; the DAG coordinator's `interpret(...)` (`dag-coordinator.ts:216`) and `stateOracle.run(...)` (`dag-coordinator.ts:120`) pass `sessionId` but no trace.

Add a `trace` carrier through the whole chain so worker-side `logLlmCall`s attribute to the coordinator's `traceId` (the shared session logger then sees them under the same delta).

**Files:**
- Modify: `packages/llm-agent/src/interfaces/subagent.ts` — add `trace?: { traceId: string }` to `ISubAgentInput`.
- Modify: `packages/llm-agent/src/interfaces/interpreter.ts` — add `trace?: { traceId: string }` to `InterpretContext`.
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` — pass `trace: ctx.options?.trace` into `interpret(...)` and `stateOracle.run(...)`.
- Modify: `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts` — forward `ctx.trace` into `worker.run({ ..., trace: ctx.trace })`.
- Modify: `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts` — forward `input.trace` into `process(prompt, { ..., trace: input.trace })`.
- Test: `packages/llm-agent-libs/src/subagent/__tests__/subagent-threads-trace.test.ts`

- [ ] **Step 1: Write the failing test** (a recording `SmartAgent` stand-in proves trace arrives at `process`)

```ts
// packages/llm-agent-libs/src/subagent/__tests__/subagent-threads-trace.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';
import type { SmartAgent } from '../../agent.js';

test('SmartAgentSubAgent forwards input.trace into agent.process options', async () => {
  let seenTrace: unknown;
  const fakeAgent = {
    process: async (_prompt: string, opts?: { trace?: { traceId: string } }) => {
      seenTrace = opts?.trace;
      return { ok: true as const, value: { content: 'ok', toolCalls: undefined, usage: undefined } };
    },
  } as unknown as SmartAgent;

  const sub = new SmartAgentSubAgent('w', fakeAgent);
  await sub.run({ task: 'do', sessionId: 's1', trace: { traceId: 'trace-123' } });
  assert.deepEqual(seenTrace, { traceId: 'trace-123' });
});
```

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/subagent/__tests__/subagent-threads-trace.test.ts` — Expected: FAIL (trace not forwarded; and `ISubAgentInput` has no `trace` field → type error).

- [ ] **Step 3: Implement**

In `packages/llm-agent/src/interfaces/subagent.ts`, add to `ISubAgentInput` (after `signal`):

```ts
  /** Request correlation, threaded from the coordinator so worker token-log
   *  entries attribute to the same request delta (traceId). */
  trace?: { traceId: string };
```

In `packages/llm-agent/src/interfaces/interpreter.ts`, add to `InterpretContext` (after `signal`):

```ts
  /** Request correlation, threaded into each worker dispatch. */
  trace?: { traceId: string };
```

In `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`:
- In the `interpreter.interpret(plan, { ... })` call (`:216-223`), add `trace: ctx.options?.trace,`.
- In the `this.deps.stateOracle.run({ ... })` call (`:120-124`), add `trace: ctx.options?.trace,`.

In `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`, in the `this.resolveWorker(n, ctx).run({ ... })` call (`:64-68`), add `trace: ctx.trace,`.

In `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`, change the `process` call (`:29-32`):

```ts
    const res = await this.agent.process(prompt, {
      sessionId: input.sessionId,
      signal: input.signal,
      trace: input.trace,
    });
```

> Verify `CallOptions.trace` shape is `{ traceId: string }` (`types.ts:17-18` `TraceContext { traceId }`, `:24` `CallOptions { trace?: TraceContext }`) — `{ traceId }` is assignable. When the worker `process` runs, it reads `options?.trace?.traceId` at `agent.ts:642` (so the worker's own `traceId` equals the coordinator's), and its `startRequest(traceId)`/`endRequest(traceId)` (Task C7) are nested-safe under the shared session logger (A3).

- [ ] **Step 4: Run** the test + `npm run build` — Expected: PASS; build clean (interface widening flows through all `ISubAgent`/interpreter implementers; the new field is optional so non-trace callers compile unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/subagent.ts packages/llm-agent/src/interfaces/interpreter.ts packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts packages/llm-agent-libs/src/subagent/__tests__/subagent-threads-trace.test.ts
git commit -m "feat(usage): thread traceId through subagent dispatch (ISubAgentInput.trace -> interpreter -> SmartAgentSubAgent.process) so worker tokens reach the request delta"
```

---

### Task C2: The SessionGraph logger flows into the per-session agent + workers

A10's `buildSessionAgent` passes `parts.logger` via `withRequestLogger` to BOTH the per-session `SmartAgent` AND every per-session worker (via the injected `buildSubAgent`), so the coordinator (`agent.ts:260`), pipeline (`builder.ts:1286`), classifier (`builder.ts:1129`), and all workers log into the SAME `SessionRequestLogger`. This task verifies + locks that the factory hands the graph's logger to `buildAgent`.

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
    mcpClientFactory: () => [],
    toolsRag: undefined,
    ragRegistry: reg,
    buildAgent: async (parts) => { seenLogger = parts.logger; return undefined; },
  });
  const g = await factory.build({ sessionId: 's1' });
  assert.equal(seenLogger, g.logger, 'buildAgent receives the graph’s session logger');
});
```

- [ ] **Step 2: Run** the test — Expected: PASS (the factory already passes `logger` into `buildAgent`; A3+A8 in place).

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/session/__tests__/session-logger-wiring.test.ts
git commit -m "test(usage): per-session token-logger flows into the session agent (and workers via the builder)"
```

---

### Task C3: Propagate `traceId` as `requestId` into every token-log entry (handler sites)

With the dispatch chain threaded (C1), the in-process log sites must stamp `requestId = ctx.options?.trace?.traceId` so entries land in the per-`traceId` delta. Add it at the verified sites.

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts:505` (`logLlmCall`)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/translate.ts:46` (`logLlmCall`)
- Modify: `packages/llm-agent-libs/src/classifier/llm-classifier.ts:144` (`logLlmCall`)
- Modify: `packages/llm-agent-libs/src/agent.ts:1961` (helper `logLlmCall`)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/rag-query.ts:90` (`logRagQuery`)

- [ ] **Step 1: Implement — add `requestId` at each site**

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

> Verify `CallOptions.trace.traceId` is the field name (`types.ts:17-18,24`: `TraceContext { traceId }`, `CallOptions { trace?: TraceContext }`). `ctx.options` is `CallOptions | undefined`.

- [ ] **Step 2: Run** `npm run build` — Expected: build clean. (Behavior is asserted by Task C4's handler-level + integration tests.)

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts packages/llm-agent-libs/src/pipeline/handlers/translate.ts packages/llm-agent-libs/src/classifier/llm-classifier.ts packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/pipeline/handlers/rag-query.ts
git commit -m "feat(usage): stamp traceId as requestId on every token-log entry (tool-loop, translate, classifier, helper, rag-query)"
```

---

### Task C4: Handler-level + integration coverage that the `requestId` wiring actually fires

> **Review MEDIUM #5:** a logger-only assertion would pass without the handler edits. This task asserts the EDITS: handler-level tests run each modified handler through a `PipelineContext` carrying `options.trace.traceId` against a recording logger, asserting the emitted entry has `requestId === traceId`; AND one integration test runs a coordinator (DAG) path and asserts `getSummary(traceId)` is non-empty and carries the worker/tool-loop component tokens.

**Files:**
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/traceid-stamping.test.ts` (handler-level)
- Test: `packages/llm-agent-libs/src/session/__tests__/coordinator-usage-integration.test.ts` (integration)

- [ ] **Step 1: Write the failing handler-level tests**

```ts
// packages/llm-agent-libs/src/pipeline/handlers/__tests__/traceid-stamping.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRequestLogger, LlmCallEntry, RagQueryEntry, ToolCallEntry } from '@mcp-abap-adt/llm-agent';

/** Records exactly what each handler stamps. */
class RecordingLogger implements IRequestLogger {
  llm: LlmCallEntry[] = [];
  rag: (RagQueryEntry & { requestId?: string })[] = [];
  logLlmCall(e: LlmCallEntry) { this.llm.push(e); }
  logRagQuery(e: RagQueryEntry & { requestId?: string }) { this.rag.push(e); }
  logToolCall(_e: ToolCallEntry & { requestId?: string }) {}
  startRequest() {}
  endRequest() {}
  dropRequest() {}
  getSummary() { return { byModel: {}, byComponent: {}, byCategory: {}, ragQueries: 0, toolCalls: 0, totalDurationMs: 0 }; }
  reset() {}
}

// For each modified handler, build a minimal PipelineContext whose options carry
// trace.traceId and a RecordingLogger, drive the handler's log call, and assert
// requestId === traceId. Implementer wires each handler with the SAME minimal
// ctx/test-double surface those handlers already use in sibling __tests__ files
// (grep packages/llm-agent-libs/src/pipeline/handlers/__tests__ for the existing
// ctx builders for tool-loop / translate / rag-query and the llm-classifier
// classify(options) signature). The load-bearing assertion per handler:

test('tool-loop stamps requestId = ctx.options.trace.traceId', async () => {
  const rec = new RecordingLogger();
  const traceId = 'trace-tl';
  // ... run the tool-loop handler with ctx.requestLogger = rec,
  //     ctx.options = { trace: { traceId } }, a fake mainLlm returning a final
  //     answer (no tool calls), reusing the existing tool-loop test harness.
  // After the run:
  assert.ok(rec.llm.length >= 1, 'tool-loop logged at least one LLM call');
  assert.ok(rec.llm.every((e) => e.requestId === traceId), 'every tool-loop entry carries the traceId');
});

test('translate stamps requestId = ctx.options.trace.traceId', async () => {
  const rec = new RecordingLogger();
  const traceId = 'trace-tr';
  // ... run translate handler with rec + options.trace.traceId, fake llm.
  assert.ok(rec.llm.length === 1 && rec.llm[0].requestId === traceId);
});

test('rag-query stamps requestId = ctx.options.trace.traceId', async () => {
  const rec = new RecordingLogger();
  const traceId = 'trace-rq';
  // ... run rag-query handler with rec + options.trace.traceId, a store returning 1 hit.
  assert.ok(rec.rag.length >= 1 && rec.rag.every((e) => e.requestId === traceId));
});

test('classifier stamps requestId = options.trace.traceId', async () => {
  const rec = new RecordingLogger();
  const traceId = 'trace-cl';
  // ... construct LlmClassifier(fakeLlm, rec) and call classify(input, { trace: { traceId } }).
  assert.ok(rec.llm.length >= 1 && rec.llm.every((e) => e.requestId === traceId));
});
```

> Implementer note: each block reuses the EXISTING per-handler test harness (the sibling `__tests__` files already construct a minimal `PipelineContext` / fake `ILlm` for tool-loop, translate, rag-query, and instantiate `LlmClassifier`). The only additions vs those harnesses are: set `ctx.requestLogger = new RecordingLogger()` (or pass it to the classifier ctor) and `ctx.options = { trace: { traceId } }` (classifier: pass `{ trace: { traceId } }` as the `classify` options). Assert `requestId === traceId` on the recorded entries. These FAIL before C3 (entries have `requestId === undefined`) and PASS after.

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/pipeline/handlers/__tests__/traceid-stamping.test.ts` — Expected: PASS (C3 already landed; if any handler still lacks the stamp, this is where it surfaces).

- [ ] **Step 3: Write the integration test** (coordinator path → `getSummary(traceId)` carries worker tokens)

```ts
// packages/llm-agent-libs/src/session/__tests__/coordinator-usage-integration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';
import { DagPlanInterpreter } from '../../coordinator/dag/dag-plan-interpreter.js';
import { AbortErrorStrategy } from '../../coordinator/dag/abort-error-strategy.js'; // verify exact path
import type { ISubAgent, ISubAgentInput, ISubAgentResult, DagPlan } from '@mcp-abap-adt/llm-agent';

// A worker that logs tokens under the traceId it RECEIVES (proving the chain:
// coordinator traceId -> InterpretContext.trace -> ISubAgentInput.trace -> log).
class LoggingWorker implements ISubAgent {
  readonly name = 'w';
  readonly capabilities = { contextPolicy: 'optional' as const };
  constructor(private readonly logger: SessionRequestLogger) {}
  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    const traceId = input.trace?.traceId;
    this.logger.startRequest(traceId);          // nested under coordinator's traceId
    this.logger.logLlmCall({ component: 'tool-loop' as never, model: 'm', promptTokens: 50, completionTokens: 10, totalTokens: 60, durationMs: 1, requestId: traceId });
    this.logger.endRequest(traceId);
    return { output: 'done' };
  }
}

test('interpreter forwards trace so worker tokens land in getSummary(traceId)', async () => {
  const logger = new SessionRequestLogger();
  const traceId = 'trace-int';
  logger.startRequest(traceId); // coordinator owns the delta

  const plan: DagPlan = {
    objective: 'do it',
    nodes: [{ id: 'n1', agent: 'w', task: 'go' }],
  };
  const interpreter = new DagPlanInterpreter();
  const workers = new Map<string, ISubAgent>([['w', new LoggingWorker(logger)]]);
  const result = await interpreter.interpret(plan, {
    inputText: 'do it',
    workers,
    sessionId: 's1',
    trace: { traceId },                          // coordinator passes its traceId
    errorStrategy: new AbortErrorStrategy(),
  });
  assert.ok(result.ok, 'plan executed');

  const summary = logger.getSummary(traceId);
  assert.ok(Object.keys(summary.byComponent).length > 0, 'delta non-empty');
  assert.equal(summary.byComponent['tool-loop'].totalTokens, 60, 'worker tokens reached the coordinator delta');
});
```

> Implementer note: verify the exact `DagPlan` node shape (`packages/llm-agent/src/interfaces/dag-plan.ts`) and the `AbortErrorStrategy` import path before writing — adjust the plan literal and import to match. The load-bearing assertion is that `getSummary(traceId)` carries the worker's `tool-loop` tokens (60), proving C1's trace threading + C3's stamping work end-to-end through the interpreter.

- [ ] **Step 4: Run** `npx tsx --test packages/llm-agent-libs/src/session/__tests__/coordinator-usage-integration.test.ts` + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/__tests__/traceid-stamping.test.ts packages/llm-agent-libs/src/session/__tests__/coordinator-usage-integration.test.ts
git commit -m "test(usage): handler-level requestId stamping + coordinator integration proving worker tokens reach getSummary(traceId)"
```

---

### Task C5: External-retrieval honesty (spec C.4)

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

### Task C6: `summaryToUsage` totals helper coverage

Lock the helper used to populate `response.usage` (Task C7).

**Files:**
- Test: `packages/llm-agent-libs/src/logger/__tests__/usage-summary-totals.test.ts`

- [ ] **Step 1: Write the test**

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

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-libs/src/logger/__tests__/usage-summary-totals.test.ts` — Expected: PASS (A3 exports `summaryToUsage`).

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/logger/__tests__/usage-summary-totals.test.ts
git commit -m "test(usage): summaryToUsage sums components into response usage triple"
```

---

### Task C7: Non-zero per-response usage from the request delta

Populate `response.usage` from `requestLogger.getSummary(traceId)` so the OpenAI/Anthropic adapter emits real numbers (today the coordinator path leaves it `{0,0,0}`). Also call `startRequest(traceId)` / `endRequest(traceId)` with the request's `traceId`.

> The agent does NOT call `dropRequest` — that is the server's responsibility (Task A10, `finally`), after the response usage has been assembled. `endRequest(traceId)` here is nested-safe and leaves the delta intact for the server to read + drop.

**Files:**
- Modify: `packages/llm-agent-libs/src/agent.ts:680` (`startRequest(traceId)`), `:1083` (`endRequest(traceId)`), and the response-assembly sites that set `usage` (`:1582`, plus the coordinator final emit) — use `summaryToUsage(this.requestLogger.getSummary(traceId))`.
- Test: `packages/llm-agent-libs/src/logger/__tests__/agent-usage-from-delta.test.ts` (see note)

- [ ] **Step 1: Implement**

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

- [ ] **Step 2: Add a focused test** that drives `process` end-to-end on a `SessionRequestLogger` and asserts the yielded `usage` is the component sum (non-zero). Reuse the existing agent test harness (grep `packages/llm-agent-libs/src/__tests__` for a `process()` test that constructs a `SmartAgent` with a fake pipeline/logger). The load-bearing assertion: after a run whose handlers log e.g. 60 tokens under the traceId, the response `usage.totalTokens === 60` (was `0` before). If the existing harness makes a full `process()` run heavy, assert at the seam instead: call `summaryToUsage(logger.getSummary(traceId))` after a simulated handler log and confirm the agent assembles `usage` from it (the integration in C4 already proves the delta is populated through the coordinator).

- [ ] **Step 3: Run** the test + `npm run build` — Expected: PASS; build clean.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/logger/__tests__/agent-usage-from-delta.test.ts
git commit -m "feat(usage): non-zero per-response usage from the per-traceId request delta (startRequest/endRequest(traceId); server drops the delta)"
```

---

### Task C8: `/v1/usage` reports per-session; reset on evict

`/v1/usage` returns the current session's cumulative summary (resolve the session from the cookie like `_handle`). Session-cumulative resets when the graph is evicted (already wired: `SessionGraph.dispose` calls `logger.reset()`, A4).

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
    buildAgent: async () => undefined,
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

- [ ] **Step 2: Run** `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/usage-per-session.test.ts` — Expected: FAIL until A3+A4+A10 land; then PASS.

- [ ] **Step 3: Implement** the `/v1/usage` per-session read at `smart-server.ts:1118` (note `await` on `acquire`):

```ts
    if (req.method === 'GET' && urlPath === '/v1/usage') {
      const lifecycle = this._lifecycle;
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

## Final steps (after all phases)

- [ ] **Lint + full build:** `npm run lint && npm run build` — Expected: clean.
- [ ] **Run all new suites:**
  - `npx tsx --test packages/llm-agent/src/interfaces/__tests__/session-identity.test.ts`
  - `npx tsx --test packages/llm-agent-libs/src/session/__tests__/*.test.ts`
  - `npx tsx --test packages/llm-agent-libs/src/logger/__tests__/*.test.ts`
  - `npx tsx --test packages/llm-agent-libs/src/subagent/__tests__/subagent-threads-trace.test.ts`
  - `npx tsx --test packages/llm-agent-libs/src/pipeline/handlers/__tests__/traceid-stamping.test.ts`
  - `npx tsx --test packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-session-registries.test.ts`
  - `npx tsx --test packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts packages/llm-agent-server/src/smart-agent/__tests__/worker-llm-cache.test.ts packages/llm-agent-server/src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts packages/llm-agent-server/src/smart-agent/__tests__/subagent-shared-rag.test.ts packages/llm-agent-server/src/smart-agent/__tests__/session-artifact-visibility.test.ts packages/llm-agent-server/src/smart-agent/__tests__/usage-per-session.test.ts`
  - Expected: all PASS.
- [ ] **Smoke:** `npm run test` (build + start) — server boots, mints a cookie on first `/v1/chat/completions`, `/v1/usage` reflects the session, per-response `usage` is non-zero on a coordinator run.
- [ ] **Docs:** update `docs/ARCHITECTURE.md` (SessionGraphFactory + fresh-per-session-workers + the full GLOBAL-vs-per-session table — note LLM/embedder clients, top-level AND per-worker, are global built-once + cached, injected by reference; per-session = composition + state only — + single-flight session build + scoping + nested-safe logger + traceId threading), `docs/QUICK_START.md` (cookie session note + `session:` config block), `docs/EXAMPLES.md` (YAML `session:` block). No release/version bump here.
- [ ] **Delete this plan + the spec** once the epic is merged (repo convention: plans/specs live only while active).

---

## Self-Review notes — spec requirement → task mapping

- **A.1 Identity (cookie mint/validate, Set-Cookie, unique id, opaque UUID, HttpOnly/SameSite=Lax/Path/Max-Age/Secure-on-HTTPS, `^[A-Za-z0-9-]{1,128}$`, malformed→mint):** A1 (type) + A2 (resolver, all attributes + validation + distinct mints) + A10 (server wiring sends Set-Cookie, HTTPS detection).
- **A.2 Per-session graph + `SessionGraphFactory` (compose from injected globals, no MCP reconnect / re-vectorize / LLM rebuild; owns pipeline/interpreter/coordinator/roles/WORKERS/MCP-server/logger/registries):** A4 (graph) + A7 (cache global per-worker LLM/embedder once + parameterized `buildSubAgent`) + A8 (factory, `withMcpClients` skips connect+vectorize per `builder.ts:880-882`; FRESH per-session workers via `buildAgent`) + A10 (`buildSessionAgent` re-wires a fresh `SubAgentRegistry` + DAG deps per session — review HIGH #1 — never reusing the global worker map at `smart-server.ts:609`/`:719`, reusing cached LLMs from A7) + A5 (`ragRegistry`+`mcpClients` on handle for injection) + A6 (registries from `CallOptions`).
- **A.3 RAG scoping (reuse per-call filter, no view objects; guarantee `ctx.sessionId`==cookie id; create/close via existing registry):** A10 (`opts.sessionId = cookie id` → `default-pipeline.ts:388`) + A8 (`dispose` → existing `closeSession`); reuse `rag-query.ts:73-86` unchanged.
- **A.4 Lifecycle (idle-TTL 2h default + LRU cap, all configurable; refcount pin; DRAIN mark-and-dispose; session-scope cleared on evict, user/global survive):** A9 (single-flight build + TTL/LRU + drain + non-creating release) + A4 (refcount + markForDisposal + idempotent dispose) + A10 (config block defaults, sweep timer, dispose→closeSession which only removes scope:session — `agent.ts:408-420` semantics).
- **A.5 Concurrency / reentrancy (shared instances reentrant; per-run state in PipelineContext; logger delta keyed by traceId; NESTED-safe; concurrent first-request safety):** A4/A9 (refcount allows concurrency; single-flight build prevents two graphs for one new session — review HIGH #2) + A11 reentrancy + nested-safety tests + A3 (nested-safe traceId-keyed delta: depth-counted start/end, explicit dropRequest) + verified seam (per-run state already in `PipelineContext`, `default-pipeline.ts:386-435`).
- **A.6 Provability (two sessions isolated; evict clears only session-scope; unique mint + persistence; logger sums+resets; malformed→mint; `ctx.sessionId`==cookie id; reentrancy; single-flight build):** A11 (isolation, single dispose, reentrancy + nested-safety) + A2 (malformed→mint, distinct mints) + A9 (single-flight: one build, identical graph for concurrent new-id acquires) + A10 lifecycle test (dispose clears session collection; distinct ids; dropRequest frees while cumulative survives) + B1 (isolation across sessions) + C8 (logger sums + reset).
- **B.3/B.4/B.5 buildSubAgent fix (share parent registry, drop isolated makeRag, parameterized per session, global per-worker LLMs cached):** A7 (`resolveSubAgentRagRegistry` + `setRagRegistry`; parameterized by `{ ragRegistry, toolsRag, mcpClients, requestLogger, mainLlm, classifierLlm, helperLlm?, embedder }` so per-session workers share session logger + globals + cached LLMs; own store registers into shared registry; `resolveWorkerLlmSet` builds LLM/embedder once per worker — review MEDIUM #3). External customer RAG / consumer-MCP are reuse-only per spec Reuse section.
- **B.6 Provability (session artifact visible across workers, isolated per session; tool-selection vs global catalog):** B1 (concrete in-memory createCollection + upsert + query: 1 for s1, 0 for s2).
- **C.1 One logger per graph (coordinator + workers):** A3 (logger) + A8/A10 (`withRequestLogger(parts.logger)` on agent AND every per-session worker) + C2 (wiring test).
- **C.2 Two axes, request id = traceId, every logLlmCall under traceId, worker dispatch threads traceId, NESTED-safe:** A3 (delta map, depth-counted + dropRequest) + C1 (thread traceId through `ISubAgentInput`/`InterpretContext`/coordinator/`SmartAgentSubAgent.process`) + C3 (stamp traceId at tool-loop/translate/classifier/helper/rag-query) + C7 (`startRequest/endRequest(traceId)`; server-owned `dropRequest`) + C4 (handler-level + integration proof).
- **C.3 Non-zero per-response usage from delta:** C7 (`summaryToUsage(getSummary(traceId))` into `response.usage`; openai-adapter mapping verified) + C6 (totals helper).
- **C.4 External-retrieval honesty:** C5 (tool call, no token attribution).
- **C.5 Reset on evict:** A4 (`dispose` calls `logger.reset()`) + C8 (verified per-session).
- **C.6 Provability (worker tokens in /v1/usage; per-response non-zero == component sum; session total across requests + reset; concurrent deltas separate; external not counted):** C8 (`/v1/usage` per-session + reset) + C7 (totals) + C4 (worker tokens reach `getSummary(traceId)` through the coordinator) + A3/A11 (concurrent + nested deltas) + C5 (external).

**Review-finding closure:**
1. **Task ordering / strict top-to-bottom (HIGH):** the parameterized `buildSubAgent` is now Task A7, placed BEFORE the `SessionGraphFactory` (A8) and the server wiring (A10) that call it. No task references a symbol defined in a later task. Phase B now holds only the session-RAG visibility provability (B1).
2. **SessionRegistry build race (HIGH):** A9 makes `acquire` async with a single-flight `pendingBuilds` guard — concurrent acquires of the same new sessionId await the SAME build promise and get the identical graph (test asserts `factory.build` called once + identical instance). A10 + C8 + all lifecycle tests `await lifecycle.acquire(...)`.
3. **Global per-worker LLM/embedder, built once (MEDIUM):** A7 hoists `makeLlm`/embedder construction to a one-time `resolveWorkerLlmSet` keyed by worker name (cached in `this._workerLlmCache`, populated by the primary `build()`); the parameterized `buildSubAgent` accepts injected `{ ..., mainLlm, classifierLlm, helperLlm?, embedder }`; A10's per-session `buildSessionAgent` re-wires using those cached instances by reference, never constructing new LLM clients or re-vectorizing. The `worker-llm-cache.test.ts` asserts build-once (`built === 2` across two calls). Architecture/global-resource notes (top of plan + Final-steps docs item) make the full GLOBAL set explicit: vectorized tools-catalog RAG, LLM clients (top-level AND per-worker), embedder, RAG registry; per-session = composition + state only.
4. **Real C4 coverage:** handler-level recording-logger tests assert `requestId === traceId` per modified handler + a coordinator integration test asserts `getSummary(traceId)` carries worker tokens.
5. **MCP client per-session-capable; only tools-catalog RAG strictly global (MEDIUM):** `SessionGraphFactory` takes an injected `mcpClientFactory(identity)` (not a fixed global `mcpClients`); `build(identity)` resolves the MCP client(s) per session and feeds them into `buildAgent`/`buildSubAgent` via `withMcpClients(...)`. `buildSessionLifecycle` wires the DEFAULT factory `(_identity) => globalMcpClients` (the once-built shared client(s) — single upstream connection, default server), and documents the creds-aware extension seam (out of scope). The vectorized tools-catalog `toolsRag` stays the STRICT global invariant (`setToolsRag(globalToolsRag)` — SAME instance by reference every session, never re-vectorized); the factory test asserts `mcpClientFactory` is called once per `build`.

**Reuse discipline:** `createCollection`/`closeSession`/scope-filter/providers/`SmartAgent.closeSession` are REUSED, never reinvented — A8/A10 only *trigger* `closeSession`; A7 only shares the registry + caches LLMs; B1 exercises the existing in-memory provider. **Out of scope:** `userId`/auth (the `scope:user` branch in `rag-query.ts` already exists, fed by a downstream auth build).

### Critical Files for Implementation
- /home/okyslytsia/prj/llm-agent/packages/llm-agent-server/src/smart-agent/smart-server.ts
- /home/okyslytsia/prj/llm-agent/packages/llm-agent-libs/src/logger/session-request-logger.ts
- /home/okyslytsia/prj/llm-agent/packages/llm-agent-libs/src/session/session-registry.ts
- /home/okyslytsia/prj/llm-agent/packages/llm-agent-libs/src/session/session-graph-factory.ts
- /home/okyslytsia/prj/llm-agent/packages/llm-agent-libs/src/agent.ts
