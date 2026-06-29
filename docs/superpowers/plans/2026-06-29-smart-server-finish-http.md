# Smart-server Finish-HTTP + Tools-RAG-Handle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For EACH task follow TDD (baseline green → change → green), run the lint gate (exit-code 0, no grep), and end with exactly one `refactor:` commit. Do NOT batch tasks into one commit. Do NOT touch the 3 already-delegating routes (config / messages / chat) or `_buildInfra` / the composition root.

## Goal

Finish extracting the HTTP layer out of `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (currently 2775 lines) and remove the one clear bespoke-glue violation:

1. The 7 routes in `_buildRouteTable` that still carry **inline `handle:` bodies** move into focused `http/*-route-handler.ts` free functions, so every `handle:` becomes a one-line call.
2. The 7×-repeated session-cookie pattern collapses into ONE helper `resolveSessionCookie(rc, lifecycle)`.
3. The ~70-line inline `IToolsRagHandle` object literal in `buildToolsRagHandle` becomes a reusable factory `makeToolsRagHandle(...)` in its own module, with a NEW focused unit test.

This is a **behaviour-preserving refactor** (third in a series). No route status / JSON / SSE shape changes. No public package API changes.

## Architecture

`SmartServer._buildRouteTable()` builds an `HttpRouteTable` of 10 routes (registration order is semantically significant — first method+path match wins). `_buildRouteTable` is a **private method that STAYS** on `SmartServer`; only the inline `handle:` *bodies* move out. The registration arrows stay lexically inside the class, so they may legally read the server's `private` fields (`rc.server._lifecycle`, `rc.server._sessionMetaStore`, `rc.server._stepperKnowledgeBackend`) and thread them as explicit parameters into the extracted free functions.

> **KEY DESIGN — private-field access (this is the biggest gotcha):** the extracted free functions live OUTSIDE the `SmartServer` class, so they CANNOT reference `rc.server._lifecycle` / `rc.server._sessionMetaStore` / `rc.server._stepperKnowledgeBackend` — those are TypeScript `private` and the compiler rejects cross-class access. Therefore each free function takes the server state it needs as **explicit parameters**, and the in-class registration arrow reads the private field and passes it. Routes that only read public `rc` locals (`rc.req`, `rc.res`, `rc.rawUrl`, `rc.modelProvider`, `rc.healthChecker`, `rc.ready`) need no threading.

The existing extracted handlers (`http/adapter-route-handler.ts`, `http/chat-route-handler.ts`, `http/config-route-handler.ts`) set the precedent: free functions take `rc` and/or threaded deps; none reach into `rc.server` privates. We follow the same shape.

## Tech Stack

- TypeScript (ESM, `"type": "module"`, `.js` import extensions, strict mode), Node ≥ 22.
- Test runner: `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'` (`npm test` in `packages/llm-agent-server-libs`), assertions via `node:assert/strict`, structure via `node:test` (`test`, `before`, `after`).
- Lint/format: Biome (`npm run format`, `npx @biomejs/biome check --write <files>`, `npm run lint:check`).

## Global Constraints (binding — copied verbatim)

- **ONE PR, 3 commits = 3 tasks**, in order: (1) sessions + cookie helper, (2) remaining infra routes, (3) tools-rag-handle factory. Each task ends with exactly one `refactor:` commit.
- **Each PR = a complete concern: after Task 2 NO inline route body remains** in `_buildRouteTable` — every `handle:` is a one-line call to an `http/` free function (the HTTP layer is fully extracted); **after Task 3 the bespoke `IToolsRagHandle` is gone** — `buildToolsRagHandle` is a one-line delegation to `makeToolsRagHandle(...)`.
- **Behaviour-preserving:** move bodies BYTE-FOR-BYTE. The only permitted edits are `this.`→`rc.server.`/parameter threading and replacing the inline cookie pattern with `resolveSessionCookie(rc, lifecycle)`. No route status / JSON / SSE shape change, no reordering of `table.add(...)` registrations.
- **Public API byte-stable:** these are PRIVATE inline bodies / a private method — extracting changes NO public surface. Do NOT add anything to a barrel (`index.ts`). Do NOT change the visibility of any `SmartServer` field/method. Verify nothing extracted is imported by another package.
- **`_buildInfra` and the composition root are NOT touched** (except `buildToolsRagHandle`'s one-line shrink in Task 3). **R4 / MCP untouched.** Do NOT touch the 3 already-delegating routes: config (→ `handleConfigUpdate`), messages (→ `handleAdapterRequest` inside `_withSession`), chat (→ `handleChat` inside `_withSession`).
- **`_withSession` stays a `SmartServer` method** (it touches `this._lifecycle` / `this._sessionMetaStore`). Do NOT fold it into the cookie helper. Reusing `resolveSessionCookie` inside `_withSession` is OPTIONAL and is intentionally NOT done here (see Task 1, Step note) — `_withSession` operates on raw `req`/`res` (no `rc`) and must stay byte-stable.
- **Lint gate per task:** run `npm run format`, then `npx @biomejs/biome check --write <changed files>`, then `npm run lint:check` requiring **exit code 0** (warnings/infos are fine). Do NOT grep for "Found 0 errors." — Biome prints no such line when clean; a grep gate is a false red. Gate on the process exit code only.
- **TDD:** routes are pinned by EXISTING tests — `route-table.test.ts`, `sessions-endpoints.test.ts`, `usage-per-session.test.ts`, `readiness-gate.test.ts`, `smart-server-api-adapters.test.ts`. Baseline GREEN before each task, GREEN after. Task 3's factory gets a NEW unit test.

## File Structure

All paths under `packages/llm-agent-server-libs/src/smart-agent/`.

NEW modules:

```
http/session-cookie.ts          Task 1  resolveSessionCookie(rc, lifecycle)
http/sessions-route-handler.ts  Task 1  handleSessionsList / handleSessionResume / handleSessionDelete
http/models-route-handler.ts    Task 2  handleModelsList / handleEmbeddingModelsList
http/usage-route-handler.ts     Task 2  handleUsageRoute
http/health-route-handler.ts    Task 2  handleHealthRoute
tools-rag-handle.ts             Task 3  makeToolsRagHandle(...)
__tests__/tools-rag-handle.test.ts  Task 3  NEW focused unit test
```

MODIFIED:

```
smart-server.ts
  Task 1  add imports; replace the 3 sessions route bodies (~2514, ~2543, ~2579) with one-line calls
  Task 2  add imports; replace models (~2418) / embedding-models (~2455) / usage (~2484) / health (~2656) bodies with one-line calls
  Task 3  add import; buildToolsRagHandle (~1849-1919) shrinks to `this._toolsRagHandle = await makeToolsRagHandle(...)`
```

Decisions & justifications:
- **New `http/session-cookie.ts` (not `response-helpers.ts`).** `response-helpers.ts` is documented as "Pure HTTP response helpers" with zero coupling to session lifecycle. `resolveSessionCookie` depends on `SessionLifecycle` (and `RouteContext`). Putting it in `response-helpers.ts` would pull a lifecycle/route-table dependency into the pure-helpers module; a dedicated tiny module keeps the layering clean.
- **Sibling models routes share one file** (`models-route-handler.ts`): `/v1/models` and `/v1/embedding-models` are the same concern. Each function keeps its own verbatim body (the embedding variant defaults `data = []` and omits the `exclude_embedding` query parse) — we do NOT factor a shared `mapModel`, to honour byte-for-byte movement.

---

### Task 1 — `resolveSessionCookie` helper + sessions routes

**Files:** NEW `http/session-cookie.ts`, NEW `http/sessions-route-handler.ts`; MODIFY `smart-server.ts`.

**Pins (must stay green):** `sessions-endpoints.test.ts` (list/resume/delete + cookie), `usage-per-session.test.ts` (lifecycle unaffected).

**Interfaces / signatures:**

```ts
// http/session-cookie.ts
import type { RouteContext } from './route-table.js';
import type { SessionLifecycle } from '../session-lifecycle/index.js';

/**
 * Resolve session identity from the request cookie and mint+set a Set-Cookie
 * header when a new session id was minted. Extracted verbatim from the 7×
 * repeated inline block in `_buildRouteTable` / `_withSession`. Returns the
 * resolved identity so callers read `resolved.identity.sessionId`.
 */
export function resolveSessionCookie(
  rc: RouteContext,
  lifecycle: SessionLifecycle,
): ReturnType<SessionLifecycle['resolve']>;
```

```ts
// http/sessions-route-handler.ts
export async function handleSessionsList(
  rc: RouteContext,
  lifecycle: SessionLifecycle | undefined,
  metaStore: ISessionMetaStore,
): Promise<void>;
export async function handleSessionResume(
  rc: RouteContext,
  lifecycle: SessionLifecycle | undefined,
  metaStore: ISessionMetaStore,
): Promise<void>;
export async function handleSessionDelete(
  rc: RouteContext,
  lifecycle: SessionLifecycle | undefined,
  metaStore: ISessionMetaStore,
  knowledgeBackend: KnowledgeBackend | undefined,
): Promise<void>;
```

Steps:

- [ ] **Baseline.** `cd packages/llm-agent-server-libs && npm test` → confirm green (note pass count for `sessions-endpoints.test.ts` and `usage-per-session.test.ts`).
- [ ] **Census the cookie block.** Confirm the 4 in-route occurrences are byte-identical before factoring: usage (~2496–2502), sessions-list (~2526–2532), sessions-resume (~2560–2566), sessions-delete (~2594–2600), plus `_withSession` (~2316–2323). Each is:
  ```ts
  const isHttps =
    (rc.req.socket as { encrypted?: boolean }).encrypted === true ||
    rc.req.headers['x-forwarded-proto'] === 'https';
  const resolved = lifecycle.resolve(rc.req.headers['cookie'], isHttps);
  if (resolved.minted && resolved.setCookie) {
    rc.res.setHeader('Set-Cookie', resolved.setCookie);
  }
  ```
  (`_withSession`'s copy uses raw `req`/`res`, not `rc` — see note below; do NOT change it.)
- [ ] **Create `http/session-cookie.ts`** with the body lifted verbatim:
  ```ts
  export function resolveSessionCookie(
    rc: RouteContext,
    lifecycle: SessionLifecycle,
  ): ReturnType<SessionLifecycle['resolve']> {
    const isHttps =
      (rc.req.socket as { encrypted?: boolean }).encrypted === true ||
      rc.req.headers['x-forwarded-proto'] === 'https';
    const resolved = lifecycle.resolve(rc.req.headers['cookie'], isHttps);
    if (resolved.minted && resolved.setCookie) {
      rc.res.setHeader('Set-Cookie', resolved.setCookie);
    }
    return resolved;
  }
  ```
- [ ] **Note (do NOT implement):** `_withSession` performs the same cookie-resolve on raw `req`/`res`. Reusing `resolveSessionCookie` there would require a `(req, res, lifecycle)` primitive signature; the approved scope keeps `_withSession` byte-stable, so we leave it as-is and record this as a future unification opportunity. Don't force it.
- [ ] **Create `http/sessions-route-handler.ts`.** Imports:
  ```ts
  import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
  import type { ISessionMetaStore } from '../session-meta-store.js';
  import {
    handleDeleteSession,
    handleListSessions,
    handleResumeSession,
    type SessionLifecycle,
  } from '../session-lifecycle/index.js';
  import { jsonError } from './response-helpers.js';
  import type { RouteContext } from './route-table.js';
  import { resolveSessionCookie } from './session-cookie.js';
  ```
  `handleSessionsList` — body lifted from ~2517–2540, `rc.server._lifecycle`→`lifecycle` param, `rc.server._sessionMetaStore`→`metaStore` param, cookie block → `resolveSessionCookie(rc, lifecycle)`:
  ```ts
  export async function handleSessionsList(rc, lifecycle, metaStore) {
    if (!lifecycle) {
      rc.res.writeHead(500, { 'Content-Type': 'application/json' });
      rc.res.end(jsonError('Session lifecycle not initialized', 'server_error'));
      return;
    }
    const resolved = resolveSessionCookie(rc, lifecycle);
    const identity = resolved.identity.sessionId;
    const body = await handleListSessions(metaStore, identity);
    rc.res.writeHead(200, { 'Content-Type': 'application/json' });
    rc.res.end(JSON.stringify(body));
  }
  ```
  `handleSessionResume` — body from ~2546–2575 (keep the `resumeMatch` regex on `rc.urlPath`, the `if (!resumeMatch) return;`, and the `body.ok ? 200 : 404` status), `metaStore`/`lifecycle` threaded, cookie block → helper.
  `handleSessionDelete` — body from ~2582–2620; the `evictFn` closure becomes:
  ```ts
  const evictFn = async (sid: string) => {
    await lifecycle.registry.evictOne(sid);
    await knowledgeBackend?.deleteSession(sid);
  };
  ```
  (`rc.server._stepperKnowledgeBackend`→`knowledgeBackend` param), keeping the `deleteMatch` regex, the `if (!deleteMatch) return;`, and `body.ok ? 200 : 404`.
- [ ] **Rewire `_buildRouteTable`** — replace the 3 sessions `handle:` bodies with one-line calls (registration arrow stays inside the class, so it may read the privates):
  ```ts
  // GET /v1/sessions
  handle: (rc) =>
    handleSessionsList(rc, rc.server._lifecycle, rc.server._sessionMetaStore),
  // POST /v1/sessions/:id/resume
  handle: (rc) =>
    handleSessionResume(rc, rc.server._lifecycle, rc.server._sessionMetaStore),
  // DELETE /v1/sessions/:id
  handle: (rc) =>
    handleSessionDelete(
      rc,
      rc.server._lifecycle,
      rc.server._sessionMetaStore,
      rc.server._stepperKnowledgeBackend,
    ),
  ```
  Add imports at the top of `smart-server.ts`:
  ```ts
  import {
    handleSessionDelete,
    handleSessionResume,
    handleSessionsList,
  } from './http/sessions-route-handler.js';
  ```
  Leave the existing `handleListSessions`/`handleResumeSession`/`handleDeleteSession` imports in place — they remain for the package barrel re-export (`export { ... }` block, ~480) and are now consumed inside `sessions-route-handler.ts`. Do NOT add the new functions to the barrel.
- [ ] **Verify** the 3 sessions `match` predicates, `method`, and registration order are unchanged.
- [ ] **Test + lint gate.** `npm test` (sessions-endpoints + usage-per-session green) → `npm run format` → `npx @biomejs/biome check --write http/session-cookie.ts http/sessions-route-handler.ts smart-server.ts` → `npm run lint:check` (exit 0).
- [ ] **Commit:** `refactor(server-libs): extract resolveSessionCookie helper and sessions route handlers`.

---

### Task 2 — remaining infra routes (models / embedding-models / usage / health)

**Files:** NEW `http/models-route-handler.ts`, NEW `http/usage-route-handler.ts`, NEW `http/health-route-handler.ts`; MODIFY `smart-server.ts`.

**Pins (must stay green):** `route-table.test.ts` (models, embedding-models, 404/OPTIONS), `usage-per-session.test.ts` (usage), `readiness-gate.test.ts` (health 200/503 + `ready` flag), `smart-server-api-adapters.test.ts` (messages route untouched).

**Interfaces / signatures:**

```ts
// http/models-route-handler.ts
export async function handleModelsList(rc: RouteContext): Promise<void>;
export async function handleEmbeddingModelsList(rc: RouteContext): Promise<void>;
// http/usage-route-handler.ts
export async function handleUsageRoute(
  rc: RouteContext,
  lifecycle: SessionLifecycle | undefined,
): Promise<void>;
// http/health-route-handler.ts
export async function handleHealthRoute(rc: RouteContext): Promise<void>;
```

Steps:

- [ ] **Baseline.** `npm test` green (note `route-table.test.ts`, `usage-per-session.test.ts`, `readiness-gate.test.ts` counts).
- [ ] **Create `http/models-route-handler.ts`.** Only `RouteContext` import (no `jsonError`). `handleModelsList` = body verbatim from ~2421–2453 (the `queryString`/`URLSearchParams`/`excludeEmbedding` parse, the `data = [{ id: 'smart-agent', ... }]` seed, the `rc.modelProvider.getModels({ excludeEmbedding })` map, `writeHead(200)` + `JSON.stringify({ object: 'list', data })`). `handleEmbeddingModelsList` = body verbatim from ~2458–2482 (`data: [] = []`, `rc.modelProvider?.getEmbeddingModels` map, same 200 envelope). No `this`/`rc.server` references exist in these bodies — they read only `rc.rawUrl`, `rc.modelProvider`, `rc.res`.
- [ ] **Create `http/usage-route-handler.ts`.** Imports `jsonError` from `./response-helpers.js`, `resolveSessionCookie` from `./session-cookie.js`, `SessionLifecycle` type, `RouteContext`. Body verbatim from ~2487–2511, `rc.server._lifecycle`→`lifecycle` param, cookie block → `resolveSessionCookie(rc, lifecycle)`, keeping the `if (!lifecycle)` 500 guard, the `acquire`/`try { writeHead(200); end(getSummary()) } finally { release }`:
  ```ts
  export async function handleUsageRoute(rc, lifecycle) {
    if (!lifecycle) {
      rc.res.writeHead(500, { 'Content-Type': 'application/json' });
      rc.res.end(jsonError('Session lifecycle not initialized', 'server_error'));
      return;
    }
    const resolved = resolveSessionCookie(rc, lifecycle);
    const sessionId = resolved.identity.sessionId;
    const graph = await lifecycle.acquire(sessionId);
    try {
      rc.res.writeHead(200, { 'Content-Type': 'application/json' });
      rc.res.end(JSON.stringify(graph.logger.getSummary()));
    } finally {
      lifecycle.release(sessionId, graph);
    }
  }
  ```
- [ ] **Create `http/health-route-handler.ts`.** Only `RouteContext` import. Body verbatim from ~2659–2666 (reads `rc.healthChecker`, `rc.ready`, `rc.res`):
  ```ts
  export async function handleHealthRoute(rc) {
    const status = await rc.healthChecker.check();
    const httpCode = status.status === 'unhealthy' || !rc.ready ? 503 : 200;
    rc.res.writeHead(httpCode, { 'Content-Type': 'application/json' });
    rc.res.end(JSON.stringify({ ...status, ready: rc.ready }));
  }
  ```
- [ ] **Rewire `_buildRouteTable`** — replace the 4 `handle:` bodies with one-liners (order/`method`/`match` unchanged):
  ```ts
  // GET /v1/models | /models
  handle: (rc) => handleModelsList(rc),
  // GET /v1/embedding-models | /embedding-models
  handle: (rc) => handleEmbeddingModelsList(rc),
  // GET /v1/usage
  handle: (rc) => handleUsageRoute(rc, rc.server._lifecycle),
  // GET /health | /v1/health
  handle: (rc) => handleHealthRoute(rc),
  ```
  Add imports:
  ```ts
  import {
    handleEmbeddingModelsList,
    handleModelsList,
  } from './http/models-route-handler.js';
  import { handleUsageRoute } from './http/usage-route-handler.js';
  import { handleHealthRoute } from './http/health-route-handler.js';
  ```
- [ ] **Verify the complete-concern requirement:** read every `table.add(...)` in `_buildRouteTable` and confirm ALL 10 `handle:` are now one-line calls — the 7 extracted (sessions ×3, models, embedding-models, usage, health) plus the 3 pre-existing delegations (config → `handleConfigUpdate` inside a GET/PUT/405 dispatch, messages → `_withSession`/`handleAdapterRequest`, chat → `_withSession`/`handleChat`). NO inline route logic remains. (The config route keeps its small inline GET/PUT/405 dispatch — it was already delegating `handleConfigUpdate` for PUT and is one of the 3 we do NOT touch.)
- [ ] **Test + lint gate.** `npm test` (route-table + usage-per-session + readiness-gate + api-adapters green) → `npm run format` → `npx @biomejs/biome check --write http/models-route-handler.ts http/usage-route-handler.ts http/health-route-handler.ts smart-server.ts` → `npm run lint:check` (exit 0).
- [ ] **Commit:** `refactor(server-libs): extract models/usage/health route handlers — no inline route bodies remain`.

---

### Task 3 — `makeToolsRagHandle` factory

**Files:** NEW `tools-rag-handle.ts`, NEW `__tests__/tools-rag-handle.test.ts`; MODIFY `smart-server.ts` (`buildToolsRagHandle` only).

**Pins (must stay green):** existing white-box coverage that exercises the tools-RAG path through the server, plus the NEW unit test below.

**Interface / signature:**

```ts
// tools-rag-handle.ts
import {
  type CallOptions,
  type IEmbedder,
  type IMcpClient,
  type IRag,
  type IToolsRagHandle,
  type LlmTool,
  QueryEmbedding,
} from '@mcp-abap-adt/llm-agent';

/**
 * Build a real IToolsRagHandle over the tools RAG store + MCP catalog,
 * dispatching over the ALREADY-RESOLVED `clients`. Eagerly populates the
 * catalog so the SYNC `lookup(name)` contract returns a schema before any
 * `query()` runs; a catalog-load failure is swallowed (logged) so startup
 * never crashes. Extracted verbatim from SmartServer.buildToolsRagHandle.
 */
export async function makeToolsRagHandle(
  clients: IMcpClient[],
  toolsRag: IRag | undefined,
  resolvedEmbedder: IEmbedder | undefined,
  log?: (event: Record<string, unknown>) => void,
): Promise<IToolsRagHandle>;
```

(Param set chosen from exactly what the current body closes over: `this._sharedMcpClients ?? []` → `clients`; `input.toolsRag` → `toolsRag`; `input.resolvedEmbedder` → `resolvedEmbedder`; `this.cfg.log` → `log`. The `catalogCache` Map + `ensureCatalog()` closure + the `query`/`lookup` impl + the eager `try { await ensureCatalog() } catch { log?.(...) }` all move inside.)

Steps:

- [ ] **Baseline.** `npm test` green.
- [ ] **Create `tools-rag-handle.ts`** by lifting the body of `buildToolsRagHandle` (~1856–1918) verbatim, returning the handle instead of assigning `this._toolsRagHandle`:
  ```ts
  export async function makeToolsRagHandle(clients, toolsRag, resolvedEmbedder, log) {
    const stepperMcpClients = clients ?? [];
    let catalogCache: Map<string, LlmTool> | undefined;
    const ensureCatalog = async (): Promise<Map<string, LlmTool>> => {
      if (catalogCache) return catalogCache;
      const catalog = new Map<string, LlmTool>();
      await Promise.allSettled(
        stepperMcpClients.map(async (client) => {
          const result = await client.listTools();
          if (result.ok) {
            for (const t of result.value) {
              if (!catalog.has(t.name)) catalog.set(t.name, t as LlmTool);
            }
          }
        }),
      );
      catalogCache = catalog;
      return catalog;
    };
    const handle: IToolsRagHandle = {
      async query(text: string, k?: number, options?: CallOptions) {
        const limit = k ?? 20;
        const catalog = await ensureCatalog();
        if (toolsRag && resolvedEmbedder) {
          const embedding = new QueryEmbedding(text, resolvedEmbedder, options);
          const ragResult = await toolsRag.query(embedding, limit);
          if (ragResult.ok) {
            const hits: LlmTool[] = [];
            for (const r of ragResult.value) {
              const id = r.metadata.id as string | undefined;
              if (id?.startsWith('tool:')) {
                const name = id.slice(5).replace(/:.*$/, '');
                const tool = catalog.get(name);
                if (tool) hits.push(tool);
              }
            }
            if (hits.length > 0) return hits;
          }
        }
        return [...catalog.values()].slice(0, limit);
      },
      lookup(name: string) {
        return catalogCache?.get(name);
      },
    };
    try {
      await ensureCatalog();
    } catch (err) {
      log?.({
        event: 'tools_catalog_eager_load_failed',
        message:
          'tools catalog eager-load failed; lookup() returns undefined until first query()',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return handle;
  }
  ```
- [ ] **Shrink `buildToolsRagHandle`** in `smart-server.ts` to delegate (keep its doc comment + the `{ toolsRag, resolvedEmbedder }` destructure):
  ```ts
  private async buildToolsRagHandle(input: {
    toolsRag: IRag | undefined;
    resolvedEmbedder: IEmbedder | undefined;
  }): Promise<void> {
    const { toolsRag, resolvedEmbedder } = input;
    this._toolsRagHandle = await makeToolsRagHandle(
      this._sharedMcpClients ?? [],
      toolsRag,
      resolvedEmbedder,
      this.cfg.log,
    );
  }
  ```
  Add import: `import { makeToolsRagHandle } from './tools-rag-handle.js';`. Do NOT export it from a barrel. After this, `LlmTool` / `QueryEmbedding` / `CallOptions` may become unused in `smart-server.ts` — if Biome flags them as unused, remove ONLY the now-dead imports (verify they have no other use first; `IRag`, `IEmbedder`, `IMcpClient`, `IToolsRagHandle` are still used by field/param types and stay).
- [ ] **Add `__tests__/tools-rag-handle.test.ts`** — characterize the documented `query`/`lookup` semantics with in-process fakes (no live MCP/embedder):
  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { makeToolsRagHandle } from '../tools-rag-handle.js';

  const ok = <T>(value: T) => ({ ok: true as const, value });
  function fakeClient(tools: { name: string }[]) {
    return { listTools: async () => ok(tools) } as never; // IMcpClient
  }
  const embedder = { /* minimal IEmbedder fake */ } as never;

  test('lookup() returns a catalog tool after eager load', async () => {
    const h = await makeToolsRagHandle([fakeClient([{ name: 'GetProgram' }])], undefined, undefined);
    assert.equal(h.lookup('GetProgram')?.name, 'GetProgram');
    assert.equal(h.lookup('Missing'), undefined);
  });

  test('query() with no RAG/embedder returns catalog slice (capped by k)', async () => {
    const h = await makeToolsRagHandle(
      [fakeClient([{ name: 'A' }, { name: 'B' }, { name: 'C' }])], undefined, undefined,
    );
    const r = await h.query('anything', 2);
    assert.deepEqual(r.map((t) => t.name), ['A', 'B']);
  });

  test('query() filters catalog by RAG hits (tool:Name:... ids)', async () => {
    const toolsRag = {
      query: async () => ok([{ metadata: { id: 'tool:B:hash' } }]),
    } as never; // IRag
    const h = await makeToolsRagHandle(
      [fakeClient([{ name: 'A' }, { name: 'B' }])], toolsRag, embedder,
    );
    const r = await h.query('find B', 10);
    assert.deepEqual(r.map((t) => t.name), ['B']);
  });

  test('query() falls back to catalog slice when RAG returns 0 hits', async () => {
    const toolsRag = { query: async () => ok([]) } as never; // IRag
    const h = await makeToolsRagHandle([fakeClient([{ name: 'A' }])], toolsRag, embedder);
    const r = await h.query('x', 10);
    assert.deepEqual(r.map((t) => t.name), ['A']);
  });

  test('eager catalog-load failure is swallowed; lookup() returns undefined', async () => {
    const throwing = { listTools: async () => { throw new Error('boom'); } } as never;
    const h = await makeToolsRagHandle([throwing], undefined, undefined);
    assert.equal(h.lookup('anything'), undefined);
  });
  ```
  (Refine the `IEmbedder`/`IRag`/`IMcpClient` fakes to the minimum the real interfaces require so `tsx` type-checks; `QueryEmbedding` only stores the embedder + text + options, so a no-op embedder fake is sufficient because `toolsRag.query` is itself faked.)
- [ ] **Run the new test in isolation first** to confirm it characterizes current behaviour, then the full suite:
  `npm test` → all green including `tools-rag-handle.test.ts`.
- [ ] **Lint gate.** `npm run format` → `npx @biomejs/biome check --write tools-rag-handle.ts __tests__/tools-rag-handle.test.ts smart-server.ts` → `npm run lint:check` (exit 0).
- [ ] **Commit:** `refactor(server-libs): extract makeToolsRagHandle factory with focused unit test`.

---

## Self-Review

- **3 tasks cover all 7 route bodies:** Task 1 → sessions-list, sessions-resume, sessions-delete (3). Task 2 → models, embedding-models, usage, health (4). Total 7. The 3 untouched delegating routes (config, messages, chat) are explicitly excluded. ✔
- **Cookie helper:** `resolveSessionCookie(rc, lifecycle)` defined once in `http/session-cookie.ts`; called in Task 1 (sessions-list, resume, delete) and Task 2 (usage) — 4 call sites, all `(rc, lifecycle)` after the in-handler `if (!lifecycle)` narrows. `_withSession` intentionally not migrated (noted, not forced). ✔
- **Factory:** `makeToolsRagHandle(clients, toolsRag, resolvedEmbedder, log?)` — definition signature matches the single call site in `buildToolsRagHandle` (`this._sharedMcpClients ?? []`, `toolsRag`, `resolvedEmbedder`, `this.cfg.log`). ✔
- **Signature consistency:** every extracted free function's parameter list equals what its lifted body reads; private server fields (`_lifecycle`, `_sessionMetaStore`, `_stepperKnowledgeBackend`) are threaded from the in-class registration arrow, never referenced inside the free functions (the TS-private gotcha). ✔
- **Placeholder scan:** no `TODO` / `FIXME` / `...` / "implement here" / unspecified names — all module paths, imports, signatures, and lifted bodies are concrete. ✔
- **Complete-concern check encoded:** Task 2 has an explicit step to read all 10 `table.add` and confirm zero inline bodies remain; Task 3 reduces `buildToolsRagHandle` to a one-line delegation. ✔
- **Barrel / public API:** no new symbol added to any `index.ts`; no `SmartServer` visibility change; the existing `handleListSessions`/`Resume`/`Delete` barrel re-exports are preserved. ✔
