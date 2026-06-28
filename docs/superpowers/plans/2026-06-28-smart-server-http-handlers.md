# Smart-server HTTP-Handler Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the three large private HTTP handler bodies (`_handleAdapterRequest`, `_handleChat`, `_handleConfigUpdate`) out of `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (currently 3453 lines) into focused `http/` modules, landing the file-size reduction PR-1 deferred — behavior byte-for-byte preserved.

**Architecture:** Each handler becomes a free function in its own `http/*-route-handler.ts` module. `_buildRouteTable` stays a `SmartServer` method; its route closures call the new free functions instead of `rc.server._handle*`. The pure adapter handler moves with the same signature; the chat handler gains a trailing `cfg: SmartServerConfig` param (replacing 3 `this.cfg` reads); the coupled config handler takes a small `IConfigUpdateTarget` that `SmartServer` implements — exposing exactly the hot-swap setters, the agent-cfg mirror, worker drain, and session invalidation the body touches. The setters ARE the hot-swap that `RoleLlmResolver`'s live accessors already observe, so behavior is preserved.

**Tech Stack:** TypeScript (ESM, strict, `.js` import extensions), Node ≥ 22, `node:http`, `node --test` + `tsx`, Biome lint/format.

## Global Constraints

- **Behavior-preserving refactor.** Move each handler body BYTE-FOR-BYTE. The ONLY edits permitted: in chat, `this.cfg.*` → `cfg.*` (3 reads); in config, `this.cfg.modelResolver` → `target.modelResolver`, `this._mainLlm =`/`_classifierLlm =`/`_helperLlm =` → `target.setMainLlm()`/`setClassifierLlm()`/`setHelperLlm()`, the `this.cfg.agent` mirror → `target.mirrorAgentCfg(patch)`, `this._workers.drain()` → `target.drainWorkers()`, `this._lifecycle?.invalidateAll() ?? Promise.resolve()` → `target.invalidateSessions()`. **No route status code, JSON body, header, or SSE frame shape may change.**
- **Public API byte-stable.** These three handlers are PRIVATE (not exported, not on the barrel). Extracting them changes NO public surface. Do NOT add `handleAdapterRequest`/`handleChat`/`handleConfigUpdate` or `IConfigUpdateTarget` to any package barrel (`index.ts`). Verified: `_handleChat`/`_handleAdapterRequest`/`_handleConfigUpdate` are referenced outside `smart-server.ts` only in comments and the stale compiled `dist/*.d.ts` — no real importer.
- **R4 / MCP untouched.** Do not touch MCP connection, readiness, or reconnect code.
- **ONE PR, 3 commits = 3 tasks**, lowest-coupling first: Task 1 = adapter (pure), Task 2 = chat (cfg param), Task 3 = config (`IConfigUpdateTarget`). Each task ends with exactly one `refactor:` commit.
- **Lint gate per task (PR-1 lesson — `format` alone misses import-sort):** before committing run `npm run format`, then `npx @biomejs/biome check --write <changed files>`, then run `npm run lint:check` and require **exit code 0** (Biome exits non-zero only on errors; warnings/infos are fine). Do NOT grep for `"Found 0 errors."` — Biome prints no such line when clean, so a grep gate is a false red.
- **TDD:** baseline the pinning test(s) GREEN before extraction, GREEN after. Add a new characterization test ONLY where a handler has no existing body-level coverage (chat — see Task 2).
- **ESM only:** `.js` extensions on all relative imports; 2-space indent, single quotes, always semicolons (Biome).

### Test commands (use throughout)

- Single test file: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/<file>`
- Compile package: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
- Full package suite: `npm test -w @mcp-abap-adt/llm-agent-server-libs`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/llm-agent-server-libs/src/smart-agent/http/adapter-route-handler.ts` | **NEW.** `handleAdapterRequest(...)` free function — verbatim `_handleAdapterRequest` body (zero `this.`). |
| `packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts` | **NEW.** `handleChat(...)` free function — verbatim `_handleChat` body, `this.cfg.*` → `cfg.*` param. |
| `packages/llm-agent-server-libs/src/smart-agent/http/config-route-handler.ts` | **NEW.** `IConfigUpdateTarget` interface + `AGENT_CONFIG_FIELDS` const + `handleConfigUpdate(req, res, smartAgent, target)` free function — verbatim `_handleConfigUpdate` body, coupling routed through `target`. |
| `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` | **MODIFY.** Import the 3 free functions; rewire the 3 route closures in `_buildRouteTable`; add ONE private `_configUpdateTarget(): IConfigUpdateTarget` helper (object literal — class shape unchanged, NO `implements`, NO new public methods); delete the 3 `_handle*` methods and the `AGENT_CONFIG_FIELDS` static. |
| `packages/llm-agent-server-libs/src/smart-agent/__tests__/chat-endpoint.test.ts` | **NEW (Task 2 only).** Characterization for the chat handler body — no prior body-level test exists. |

### Helpers / sources to import (verified)

- From `./http/response-helpers.js`: `readBody`, `jsonError`, `jsonValidationError`, `mapStopReason`, `writeNotReady` (already the source smart-server.ts uses, line 90-97).
- From `node:http`: `type IncomingMessage`, `type ServerResponse`. From `node:crypto`: `randomUUID`.
- From `@mcp-abap-adt/llm-agent` (types): `ILlm`, `ILlmApiAdapter`, `IModelResolver`, `IModelProvider`, `IRequestLogger`, `Message`, `NormalizedRequest`, `StreamToolCall`. Values: `AdapterValidationError`, `buildExternalResults`, `normalizeAndValidateExternalTools`, `toToolCallDelta`.
- From `@mcp-abap-adt/llm-agent-libs`: `type SessionGraph`, `type SmartAgent`, `type SmartAgentHandle`, `type SmartAgentReconfigureOptions`, `type StopReason`, value `SessionLogger`.
- `type SmartServerConfig` is `export`ed from `smart-server.ts:215` — chat-route-handler imports it type-only (type-only import erases at runtime → no require cycle).

### Current code anchors (read before editing — line numbers as of this writing)

- `_buildRouteTable`: 2423-2732. Route closures to rewire:
  - config: `await rc.server._handleConfigUpdate(rc.req, rc.res, rc.smartAgent);` at **2644**.
  - adapter: `await rc.server._handleAdapterRequest(rc.req, rc.res, graph.agent ?? rc.smartAgent, anthropicAdapter, { sessionId, traceId, graph });` inside `_withSession` at **2692-2698**.
  - chat: `await rc.server._handleChat(rc.req, rc.res, rc.requestLogger, graph.agent ?? rc.smartAgent, rc.chat, rc.streamChat, rc.log, rc.modelProvider, { sessionId, traceId, graph });` inside `_withSession` at **2716-2726**.
- `_handleAdapterRequest`: **2734-2822** (zero `this.`).
- `_handleChat`: **2824-3252**. `this.cfg` reads: `this.cfg.logDir` (**2913**), `this.cfg.agent?.externalToolsValidationMode` (**2918**), `this.cfg.reportUsage` (**3179**). No other `this.`.
- `AGENT_CONFIG_FIELDS` static set: **3254-3263** (only consumer is `_handleConfigUpdate`; `config-reload-watcher.ts:80` only mentions it in a comment).
- `_handleConfigUpdate`: **3265-3441**. Couplings: `this.cfg.modelResolver` (**3340**, **3367**), `this._mainLlm =`/`_classifierLlm =`/`_helperLlm =` (**3400-3403**), `this.cfg.agent` mirror (**3405-3417**), `this._workers.drain()` (**3427**), `this._lifecycle?.invalidateAll()` (**3429**, inside try/catch).
- Private fields: `cfg` (589, `private readonly cfg: SmartServerConfig`), `_workers` (597, `IWorkerRegistry` — `.drain(): Promise<void>`), `_lifecycle` (604, `SessionLifecycle?` — `.invalidateAll(): Promise<void>`), `_mainLlm`/`_classifierLlm`/`_helperLlm` (606-608, `ILlm?`). `cfg.modelResolver` type is `IModelResolver` (decl at 288).
- Precedent for the target shape: `ConfigReloadWatcher` is already constructed with `drainWorkers: () => this._workers.drain()` and `invalidateSessions: () => this._lifecycle?.invalidateAll() ?? Promise.resolve()` (smart-server.ts:1335-1337).

---

## Task 1: Extract the adapter handler (pure)

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/http/adapter-route-handler.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (rewire route closure at 2692-2698; delete method 2734-2822; remove now-unused imports if any become unused)
- Test (pins this handler): `packages/llm-agent-server-libs/src/smart-agent/__tests__/smart-server-api-adapters.test.ts`

**Interfaces:**
- Produces: `export async function handleAdapterRequest(req: IncomingMessage, res: ServerResponse, agent: SmartAgent, adapter: ILlmApiAdapter, session?: { sessionId: string; traceId: string; graph: SessionGraph }): Promise<void>` — SAME params as the current private method (verbatim signature from line 2734-2740).

- [ ] **Step 1: Baseline the pinning test GREEN**

`smart-server-api-adapters.test.ts` exercises POST `/v1/messages` and `/messages` (404 no-adapter, 400 invalid-JSON, happy route) — it drives `_handleAdapterRequest` end-to-end.

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/smart-server-api-adapters.test.ts`
Expected: PASS (all `SmartServer — Anthropic /v1/messages route` tests green). This is the pre-extraction baseline — no new test needed (handler already characterized).

- [ ] **Step 2: Create `http/adapter-route-handler.ts` with the body moved verbatim**

Move the body of `_handleAdapterRequest` (smart-server.ts:2741-2821) BYTE-FOR-BYTE into the new free function. It has ZERO `this.` references, so no edits to the body. Create:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AdapterValidationError,
  buildExternalResults,
  type ILlmApiAdapter,
  type NormalizedRequest,
} from '@mcp-abap-adt/llm-agent';
import type { SessionGraph, SmartAgent } from '@mcp-abap-adt/llm-agent-libs';
import { jsonError, readBody } from './response-helpers.js';

/**
 * POST /v1/messages handler (Anthropic adapter route), extracted verbatim from
 * SmartServer._handleAdapterRequest. Pure — no SmartServer state is touched.
 */
export async function handleAdapterRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agent: SmartAgent,
  adapter: ILlmApiAdapter,
  session?: { sessionId: string; traceId: string; graph: SessionGraph },
): Promise<void> {
  // ── body moved byte-for-byte from smart-server.ts:2741-2821 ──
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonError('Invalid JSON', 'invalid_request_error'));
    return;
  }

  let normalized: NormalizedRequest;
  try {
    normalized = adapter.normalizeRequest(body);
  } catch (err) {
    if (err instanceof AdapterValidationError) {
      res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
      res.end(jsonError(err.message, 'invalid_request_error'));
      return;
    }
    throw err;
  }

  const { results: externalResults, sanitizedMessages } =
    buildExternalResults(normalized.messages);

  const augmentedOptions = session
    ? {
        ...normalized.options,
        sessionId: session.sessionId,
        trace: { traceId: session.traceId },
        toolAvailability: session.graph.toolAvailability,
        pendingToolResults: session.graph.pendingToolResults,
        externalResults,
      }
    : { ...normalized.options, externalResults };

  if (normalized.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    for await (const event of adapter.transformStream(
      agent.streamProcess(sanitizedMessages, augmentedOptions),
      normalized.context,
    )) {
      const eventLine = event.event ? `event: ${event.event}\n` : '';
      res.write(`${eventLine}data: ${event.data}\n\n`);
    }
    res.end();
    return;
  }

  // Non-streaming
  const result = await agent.process(sanitizedMessages, augmentedOptions);
  res.setHeader('Content-Type', 'application/json');
  if (!result.ok) {
    res.writeHead(500);
    res.end(
      JSON.stringify(
        adapter.formatError?.(result.error, normalized.context) ?? {
          error: {
            message: result.error.message,
            type: result.error.code,
          },
        },
      ),
    );
    return;
  }
  res.writeHead(200);
  res.end(
    JSON.stringify(adapter.formatResult(result.value, normalized.context)),
  );
}
```

(Keep the `#171 review#8` comment block from the original 2763-2768 above the `buildExternalResults` call — reproduce it verbatim; omitted here only for brevity.)

- [ ] **Step 3: Import the free function in smart-server.ts**

Add to the existing import group near the other `./http/*` imports (after the `route-table.js` import at line 98):

```ts
import { handleAdapterRequest } from './http/adapter-route-handler.js';
```

- [ ] **Step 4: Rewire the adapter route closure (smart-server.ts:2692-2698)**

Replace:

```ts
            await rc.server._handleAdapterRequest(
              rc.req,
              rc.res,
              graph.agent ?? rc.smartAgent,
              anthropicAdapter,
              { sessionId, traceId, graph },
            );
```

with:

```ts
            await handleAdapterRequest(
              rc.req,
              rc.res,
              graph.agent ?? rc.smartAgent,
              anthropicAdapter,
              { sessionId, traceId, graph },
            );
```

- [ ] **Step 5: Delete the `_handleAdapterRequest` method**

Delete smart-server.ts:2734-2822 (the whole `private async _handleAdapterRequest(...) { ... }`). After deletion, check whether `AdapterValidationError` / `NormalizedRequest` are still referenced elsewhere in smart-server.ts; if not, remove them from the imports (lines 34 and 40) to keep lint clean. (`buildExternalResults` IS still used by `_handleChat` — keep it.)

Run: `grep -nE "AdapterValidationError|NormalizedRequest" packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — if zero hits, drop each from its import line.

- [ ] **Step 6: Compile**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Expected: clean compile, no TS errors.

- [ ] **Step 7: Re-run the pinning test (post-extraction GREEN)**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/smart-server-api-adapters.test.ts`
Expected: PASS — identical to Step 1 baseline.

- [ ] **Step 8: Lint gate**

```bash
npm run format
npx @biomejs/biome check --write packages/llm-agent-server-libs/src/smart-agent/http/adapter-route-handler.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
npm run lint:check
```
Expected: **exit code 0**. Biome's `check` exits non-zero ONLY when there are errors; warnings/infos are fine and do NOT fail the gate. (Do NOT grep for `"Found 0 errors."` — Biome prints no such line when clean, so a grep gate is a false red.)

- [ ] **Step 9: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/http/adapter-route-handler.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "refactor: extract adapter route handler from smart-server"
```

---

## Task 2: Extract the chat handler (cfg param)

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts`
- Create (new characterization — no body-level test exists): `packages/llm-agent-server-libs/src/smart-agent/__tests__/chat-endpoint.test.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (rewire route closure at 2716-2726; delete method 2824-3252)

**Interfaces:**
- Consumes: `type SmartServerConfig` from `../smart-server.js` (exported at smart-server.ts:215).
- Produces: `export async function handleChat(req: IncomingMessage, res: ServerResponse, _requestLogger: IRequestLogger, smartAgent: SmartAgent, _chat: SmartAgentHandle['chat'], _streamChat: SmartAgentHandle['streamChat'], log: (e: Record<string, unknown>) => void, modelProvider: IModelProvider | undefined, session: { sessionId: string; traceId: string; graph: SessionGraph } | undefined, cfg: SmartServerConfig): Promise<void>` — SAME params as `_handleChat` (2824-2833) PLUS a trailing `cfg: SmartServerConfig`.

> **Why a NEW test:** The chat handler body has NO end-to-end characterization today. `route-table.test.ts` only sends OPTIONS (CORS) to `/v1/chat/completions`; `readiness-gate.test.ts` only asserts the 503 pre-dispatch gate (the handler never runs). The early validation 400s return BEFORE any `this.cfg` read, so they would not catch a `this.cfg`→`cfg` regression. We add a happy-path test that reaches all three cfg reads.

- [ ] **Step 1: Write the failing characterization test**

Create `packages/llm-agent-server-libs/src/smart-agent/__tests__/chat-endpoint.test.ts`. It injects a canned LLM via `BuildAgentDeps.makeLlm` (using `makeLlm` from `@mcp-abap-adt/llm-agent-libs/testing`, the same pattern as `smart-server-config-reload.test.ts`) so a real chat completion runs with no network. It asserts the OpenAI-shaped response and exercises the `cfg.logDir` + `cfg.agent.externalToolsValidationMode` reads (non-streaming) and the `cfg.reportUsage` read (streaming), plus one validation 400.

```ts
// src/smart-agent/__tests__/chat-endpoint.test.ts
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import { makeLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import { SmartServer } from '../smart-server.js';

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr !== undefined
            ? { 'Content-Length': Buffer.byteLength(bodyStr) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

function makeServer() {
  return new SmartServer(
    {
      port: 0,
      llm: { provider: 'deepseek', apiKey: 'test-key', model: 'test-model' },
      skipModelValidation: true,
    },
    { makeLlm: async () => makeLlm([{ content: 'hello there' }]) },
  );
}

describe('SmartServer — POST /v1/chat/completions (handler body)', () => {
  it('returns an OpenAI chat.completion for a non-streaming request', async () => {
    const handle = await makeServer().start();
    try {
      const res = await httpRequest(handle.port, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.raw) as {
        object: string;
        choices: Array<{ message: { role: string; content: string } }>;
      };
      assert.equal(body.object, 'chat.completion');
      assert.equal(body.choices[0].message.role, 'assistant');
      assert.equal(body.choices[0].message.content, 'hello there');
    } finally {
      await handle.close();
    }
  });

  it('streams SSE chunks ending with [DONE] for a streaming request', async () => {
    const handle = await makeServer().start();
    try {
      const res = await httpRequest(handle.port, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      assert.equal(res.status, 200);
      assert.ok(res.raw.includes('"object":"chat.completion.chunk"'));
      assert.ok(res.raw.trimEnd().endsWith('data: [DONE]'));
    } finally {
      await handle.close();
    }
  });

  it('returns 400 when no message has role "user"', async () => {
    const handle = await makeServer().start();
    try {
      const res = await httpRequest(handle.port, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'assistant', content: 'hi' }],
      });
      assert.equal(res.status, 400);
      assert.ok(res.raw.includes('role "user" is required'));
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 2: Run the new test against the CURRENT code to verify it passes (baseline)**

The handler still exists as `_handleChat`, so this test must already be GREEN — it characterizes existing behavior before the move.

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/chat-endpoint.test.ts`
Expected: PASS (3 tests). If the streaming/non-streaming assertions don't match the real output, adjust the assertions to the ACTUAL current bytes (this is characterization — capture what the code does today, do not "fix" it).

- [ ] **Step 3: Create `http/chat-route-handler.ts` with the body moved verbatim + `this.cfg`→`cfg`**

Move `_handleChat` (smart-server.ts:2835-3251) BYTE-FOR-BYTE. The ONLY edits to the body are the three `this.cfg` reads:
- `new SessionLogger(this.cfg.logDir || null, ...)` (2913) → `new SessionLogger(cfg.logDir || null, ...)`
- `this.cfg.agent?.externalToolsValidationMode ?? 'permissive'` (2918) → `cfg.agent?.externalToolsValidationMode ?? 'permissive'`
- `this.cfg.reportUsage !== false` (3179) → `cfg.reportUsage !== false`

Module skeleton (imports + signature; the body is the verbatim 2835-3251 with the 3 substitutions above):

```ts
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildExternalResults,
  type IModelProvider,
  type IRequestLogger,
  type Message,
  normalizeAndValidateExternalTools,
  type StreamToolCall,
  toToolCallDelta,
} from '@mcp-abap-adt/llm-agent';
import {
  SessionLogger,
  type SessionGraph,
  type SmartAgent,
  type SmartAgentHandle,
  type StopReason,
} from '@mcp-abap-adt/llm-agent-libs';
import type { SmartServerConfig } from '../smart-server.js';
import {
  jsonError,
  jsonValidationError,
  mapStopReason,
  readBody,
} from './response-helpers.js';

/**
 * POST /v1/chat/completions handler (OpenAI-compatible), extracted verbatim
 * from SmartServer._handleChat. The only change vs. the original is that the
 * three `this.cfg` reads are now the trailing `cfg` parameter.
 */
export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  _requestLogger: IRequestLogger,
  smartAgent: SmartAgent,
  _chat: SmartAgentHandle['chat'],
  _streamChat: SmartAgentHandle['streamChat'],
  log: (e: Record<string, unknown>) => void,
  modelProvider: IModelProvider | undefined,
  session: { sessionId: string; traceId: string; graph: SessionGraph } | undefined,
  cfg: SmartServerConfig,
): Promise<void> {
  // ── body moved byte-for-byte from smart-server.ts:2835-3251 ──
  // (with this.cfg.logDir → cfg.logDir at the SessionLogger ctor,
  //  this.cfg.agent?.externalToolsValidationMode → cfg.agent?.externalToolsValidationMode,
  //  this.cfg.reportUsage → cfg.reportUsage in the streaming usage block)
  // ...
}
```

> Note: keep `modelProvider?`/`session?` as optional positionally — written as `modelProvider: IModelProvider | undefined` / `session: {...} | undefined` because a required `cfg` param follows them. The call site always passes all 10 args, so behavior is identical.

- [ ] **Step 4: Import the free function in smart-server.ts**

Add next to the Task 1 import:

```ts
import { handleChat } from './http/chat-route-handler.js';
```

- [ ] **Step 5: Rewire the chat route closure (smart-server.ts:2716-2726)**

Replace:

```ts
            await rc.server._handleChat(
              rc.req,
              rc.res,
              rc.requestLogger,
              graph.agent ?? rc.smartAgent,
              rc.chat,
              rc.streamChat,
              rc.log,
              rc.modelProvider,
              { sessionId, traceId, graph },
            );
```

with (append `this.cfg` as the 10th arg — `_buildRouteTable` is a `SmartServer` method, so the closure captures `this`; `cfg` is `private readonly` and reachable on `this`):

```ts
            await handleChat(
              rc.req,
              rc.res,
              rc.requestLogger,
              graph.agent ?? rc.smartAgent,
              rc.chat,
              rc.streamChat,
              rc.log,
              rc.modelProvider,
              { sessionId, traceId, graph },
              this.cfg,
            );
```

- [ ] **Step 6: Delete the `_handleChat` method**

Delete smart-server.ts:2824-3252 (the whole `private async _handleChat(...) { ... }`). Then check imports: `SessionLogger`, `normalizeAndValidateExternalTools`, `toToolCallDelta`, `StreamToolCall`, `Message`, `mapStopReason`, `jsonValidationError`, `SmartAgentHandle`, `StopReason`, `IRequestLogger`, `IModelProvider` may now be unused in smart-server.ts. Run `grep -nE "<symbol>" packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` for each and remove any with zero remaining hits from the import groups. (Biome import-sort in Step 8 will not remove unused imports — TS `noUnusedLocals`/build will flag them; remove by hand.)

- [ ] **Step 7: Compile**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Expected: clean compile.

- [ ] **Step 8: Re-run the new test + readiness gate (post-extraction GREEN)**

```bash
cd packages/llm-agent-server-libs
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/chat-endpoint.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/readiness-gate.test.ts
```
Expected: both PASS (chat body unchanged; 503 pre-dispatch gate unchanged).

- [ ] **Step 9: Lint gate**

```bash
npm run format
npx @biomejs/biome check --write packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/chat-endpoint.test.ts
npm run lint:check
```
Expected: **exit code 0**. Biome's `check` exits non-zero ONLY when there are errors; warnings/infos are fine and do NOT fail the gate. (Do NOT grep for `"Found 0 errors."` — Biome prints no such line when clean, so a grep gate is a false red.)

- [ ] **Step 10: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/chat-endpoint.test.ts
git commit -m "refactor: extract chat route handler from smart-server"
```

---

## Task 3: Extract the config handler (`IConfigUpdateTarget`)

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/http/config-route-handler.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (add private `_configUpdateTarget()` returning the target object literal — NO `implements`, NO new public methods; rewire route closure at 2644; delete method 3265-3441 and the `AGENT_CONFIG_FIELDS` static 3254-3263)
- Test (pins this handler): `packages/llm-agent-server-libs/src/smart-agent/__tests__/config-endpoints.test.ts` and `packages/llm-agent-server-libs/src/smart-agent/__tests__/smart-server-config-reload.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface IConfigUpdateTarget {
    readonly modelResolver?: IModelResolver;
    setMainLlm(llm: ILlm): void;
    setClassifierLlm(llm: ILlm): void;
    setHelperLlm(llm: ILlm): void;
    mirrorAgentCfg(patch: Record<string, unknown>): void;
    drainWorkers(): Promise<void>;
    invalidateSessions(): Promise<void>;
  }
  export async function handleConfigUpdate(req: IncomingMessage, res: ServerResponse, smartAgent: SmartAgent, target: IConfigUpdateTarget): Promise<void>;
  ```
- Consumed by: `SmartServer` (builds the target via a PRIVATE `_configUpdateTarget()` object literal closing over its private fields; passes `this._configUpdateTarget()` as `target`). The class does NOT `implements` the interface — the public class shape is unchanged.

> **Pinning coverage (no new test needed):** `config-endpoints.test.ts` characterizes the full PUT `/v1/config` surface — agent-field update + whitelist 400, invalid-JSON 400, 405, model resolve+reconfigure happy path, "no resolver" 400, resolve-failure 500, unknown-model 500, atomicity. `smart-server-config-reload.test.ts` additionally asserts the `_mainLlm` hot-swap AND that `_workers.cache` is cleared + the session registry is drained after PUT — i.e. it pins `setMainLlm` + `drainWorkers` + `invalidateSessions`. Together they cover every `IConfigUpdateTarget` member.

- [ ] **Step 1: Baseline the pinning tests GREEN**

```bash
cd packages/llm-agent-server-libs
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/config-endpoints.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/smart-server-config-reload.test.ts
```
Expected: both PASS. Pre-extraction baseline.

- [ ] **Step 2: Create `http/config-route-handler.ts` — interface + `AGENT_CONFIG_FIELDS` + body moved verbatim with coupling via `target`**

Move `AGENT_CONFIG_FIELDS` (smart-server.ts:3254-3263) here as a module const, and move `_handleConfigUpdate` (3270-3441) BYTE-FOR-BYTE. The ONLY body edits:
- `SmartServer.AGENT_CONFIG_FIELDS.has(k)` (3312) → `AGENT_CONFIG_FIELDS.has(k)`
- `!this.cfg.modelResolver` (3340) → `!target.modelResolver`
- `const resolver = this.cfg.modelResolver;` (3367) → `const resolver = target.modelResolver;`
- `if (resolvedModels.mainLlm) this._mainLlm = resolvedModels.mainLlm;` (3400) → `if (resolvedModels.mainLlm) target.setMainLlm(resolvedModels.mainLlm);`
- `if (resolvedModels.classifierLlm) this._classifierLlm = resolvedModels.classifierLlm;` (3401-3402) → `if (resolvedModels.classifierLlm) target.setClassifierLlm(resolvedModels.classifierLlm);`
- `if (resolvedModels.helperLlm) this._helperLlm = resolvedModels.helperLlm;` (3403) → `if (resolvedModels.helperLlm) target.setHelperLlm(resolvedModels.helperLlm);`
- the `this.cfg.agent` mirror block (3412-3416 — the `const merged = {...}; (this.cfg...).agent = merged;`) → `target.mirrorAgentCfg(patch);` (the `smartAgent.applyConfigUpdate(patch)` line at 3407 STAYS unchanged; `target.mirrorAgentCfg` performs the merge that was inline)
- `await this._workers.drain();` (3427) → `await target.drainWorkers();`
- the try/catch around `await this._lifecycle?.invalidateAll();` (3428-3434) → `await target.invalidateSessions();` keeping the SAME surrounding `try { ... } catch { /* swallow */ }`

Module:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ILlm,
  IModelResolver,
} from '@mcp-abap-adt/llm-agent';
import type {
  SmartAgent,
  SmartAgentReconfigureOptions,
} from '@mcp-abap-adt/llm-agent-libs';
import { jsonError, readBody } from './response-helpers.js';

/** Exactly the SmartServer state PUT /v1/config touches — the hot-swap seam. */
export interface IConfigUpdateTarget {
  readonly modelResolver?: IModelResolver;
  setMainLlm(llm: ILlm): void;
  setClassifierLlm(llm: ILlm): void;
  setHelperLlm(llm: ILlm): void;
  /** Deep-merge `patch` into the mirrored `cfg.agent` (preserve untouched startup fields). */
  mirrorAgentCfg(patch: Record<string, unknown>): void;
  drainWorkers(): Promise<void>;
  invalidateSessions(): Promise<void>;
}

/** Whitelisted agent config fields allowed via PUT /v1/config. */
const AGENT_CONFIG_FIELDS = new Set([
  'maxIterations',
  'maxToolCalls',
  'ragQueryK',
  'toolUnavailableTtlMs',
  'showReasoning',
  'historyAutoSummarizeLimit',
  'classificationEnabled',
]);

/**
 * PUT /v1/config handler, extracted verbatim from SmartServer._handleConfigUpdate.
 * SmartServer state is reached through `target` (IConfigUpdateTarget): the LLM
 * setters ARE the hot-swap that RoleLlmResolver's live accessors observe.
 */
export async function handleConfigUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  smartAgent: SmartAgent,
  target: IConfigUpdateTarget,
): Promise<void> {
  // ── body moved byte-for-byte from smart-server.ts:3270-3441 with the
  //    substitutions listed in the plan (SmartServer.AGENT_CONFIG_FIELDS →
  //    AGENT_CONFIG_FIELDS, this.cfg.modelResolver → target.modelResolver,
  //    this._mainLlm = → target.setMainLlm(), the agent mirror →
  //    target.mirrorAgentCfg(patch), this._workers.drain() →
  //    target.drainWorkers(), this._lifecycle?.invalidateAll() ?? ... →
  //    target.invalidateSessions()) ──
  // ...
}
```

Concretely the mutation block (originally 3394-3435) becomes:

```ts
  // --- All validation passed — apply mutations ---
  if (resolvedModels) {
    smartAgent.reconfigure(resolvedModels);
    if (resolvedModels.mainLlm) target.setMainLlm(resolvedModels.mainLlm);
    if (resolvedModels.classifierLlm)
      target.setClassifierLlm(resolvedModels.classifierLlm);
    if (resolvedModels.helperLlm)
      target.setHelperLlm(resolvedModels.helperLlm);
  }
  if (body.agent) {
    const patch = body.agent as Record<string, unknown>;
    smartAgent.applyConfigUpdate(patch);
    target.mirrorAgentCfg(patch);
  }
  if (resolvedModels || body.agent) {
    await target.drainWorkers();
    try {
      await target.invalidateSessions();
    } catch {
      // Swallow: cleanup errors must not turn a successful config update
      // into a 500. The next request will still get a fresh build.
    }
  }
```

(Preserve the original explanatory comments above each block verbatim.)

- [ ] **Step 3: Add a PRIVATE `_configUpdateTarget()` helper (do NOT change the class shape)**

In smart-server.ts, import the handler + interface:

```ts
import {
  handleConfigUpdate,
  type IConfigUpdateTarget,
} from './http/config-route-handler.js';
```

**Do NOT make `SmartServer implements IConfigUpdateTarget`, and do NOT add public methods.** `SmartServer` is an exported class — adding `setMainLlm`/`setClassifierLlm`/`setHelperLlm`/`mirrorAgentCfg`/`drainWorkers`/`invalidateSessions` to it (even with the interface unexported) is a NEW PUBLIC surface and violates the byte-stable-public-API constraint. The class declaration `export class SmartServer {` stays UNCHANGED.

Instead add ONE PRIVATE method that returns the target as an object literal closing over the private fields — the same object-literal-deps pattern `ConfigReloadWatcher` is already wired with at smart-server.ts:1335-1337. Place it near the other private helpers (it reads/writes `_mainLlm`/`_classifierLlm`/`_helperLlm` at 606-608, `_workers` at 597, `_lifecycle` at 604, `cfg` at 589):

```ts
  /**
   * Build the PUT /v1/config hot-swap seam over this server's private state.
   * The setters write the SAME `_mainLlm`/`_classifierLlm`/`_helperLlm` fields
   * RoleLlmResolver's live accessors read, so the hot-swap stays observable.
   * A private object literal — NOT `implements` — so the public class shape is
   * unchanged (byte-stable public API).
   */
  private _configUpdateTarget(): IConfigUpdateTarget {
    return {
      modelResolver: this.cfg.modelResolver,
      setMainLlm: (llm) => {
        this._mainLlm = llm;
      },
      setClassifierLlm: (llm) => {
        this._classifierLlm = llm;
      },
      setHelperLlm: (llm) => {
        this._helperLlm = llm;
      },
      mirrorAgentCfg: (patch) => {
        const merged: Record<string, unknown> = {
          ...((this.cfg as { agent?: Record<string, unknown> }).agent ?? {}),
          ...patch,
        };
        (this.cfg as { agent?: Record<string, unknown> }).agent = merged;
      },
      drainWorkers: () => this._workers.drain(),
      invalidateSessions: () =>
        this._lifecycle?.invalidateAll() ?? Promise.resolve(),
    };
  }
```

(`IModelResolver` and `ILlm` are already imported in smart-server.ts — lines 22 and 17 — but are only needed by the interface in config-route-handler.ts now; keep them in smart-server.ts only if still otherwise referenced. The `mirrorAgentCfg` closure reproduces the existing merge at 3412-3416; `drainWorkers`/`invalidateSessions` mirror the `ConfigReloadWatcher` wiring at 1335-1337.)

- [ ] **Step 4: Rewire the config route closure (smart-server.ts:2644)**

Replace:

```ts
          await rc.server._handleConfigUpdate(rc.req, rc.res, rc.smartAgent);
```

with (pass the private object-literal target — `_buildRouteTable` is a `SmartServer` method, so the closure captures `this` lexically, exactly like the chat route passes `this.cfg`):

```ts
          await handleConfigUpdate(
            rc.req,
            rc.res,
            rc.smartAgent,
            this._configUpdateTarget(),
          );
```

- [ ] **Step 5: Delete the old method + static**

Delete smart-server.ts:3265-3441 (`private async _handleConfigUpdate(...) { ... }`) and the `private static readonly AGENT_CONFIG_FIELDS = new Set([...]);` at 3254-3263 (now a module const in config-route-handler.ts). Then check `SmartAgentReconfigureOptions` is still referenced in smart-server.ts (`grep -n SmartAgentReconfigureOptions ...`); it likely still is (reconfigure path elsewhere) — if zero hits, remove from the import at line 72.

- [ ] **Step 6: Compile**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Expected: clean compile (the `implements IConfigUpdateTarget` clause type-checks the 6 methods against the interface — a name/signature mismatch fails here).

- [ ] **Step 7: Re-run the pinning tests (post-extraction GREEN)**

```bash
cd packages/llm-agent-server-libs
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/config-endpoints.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/smart-server-config-reload.test.ts
```
Expected: both PASS — identical to Step 1 baseline (the `_mainLlm` hot-swap + worker drain + session invalidate behave the same through `target`).

- [ ] **Step 8: Full package suite (regression sweep)**

Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs`
Expected: full suite GREEN (no route/SSE/JSON regressions across adapter, chat, config, sessions, readiness).

- [ ] **Step 9: Lint gate**

```bash
npm run format
npx @biomejs/biome check --write packages/llm-agent-server-libs/src/smart-agent/http/config-route-handler.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
npm run lint:check
```
Expected: **exit code 0**. Biome's `check` exits non-zero ONLY when there are errors; warnings/infos are fine and do NOT fail the gate. (Do NOT grep for `"Found 0 errors."` — Biome prints no such line when clean, so a grep gate is a false red.)

- [ ] **Step 10: Confirm public API unchanged + file shrank**

```bash
# No new public exports — the handlers/interface must NOT be on any barrel:
grep -rn "handleConfigUpdate\|handleChat\|handleAdapterRequest\|IConfigUpdateTarget" packages/llm-agent-server-libs/src/index.ts || echo "OK: not exported"
# smart-server.ts is materially smaller (~3453 → well under 3000):
wc -l packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
```
Expected: `OK: not exported`, and a line count several hundred lines below 3453.

- [ ] **Step 11: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/http/config-route-handler.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "refactor: extract config-update route handler from smart-server"
```

---

## Self-Review (completed by plan author)

**1. Coverage:** All 3 handlers have a task — Task 1 adapter, Task 2 chat, Task 3 config. Each ends in exactly one `refactor:` commit. Rewire of all 3 `_buildRouteTable` call sites (2644 config, 2692 adapter, 2716 chat) and deletion of all 3 methods + the `AGENT_CONFIG_FIELDS` static are covered.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". Body-move steps cite exact source line ranges and enumerate every permitted edit; the adapter body is shown in full, the chat/config bodies are byte-moved with the substitution list spelled out (full re-transcription of 400 lines would itself risk drift — the move + explicit edit list is the precise instruction).

**3. Type consistency:** `IConfigUpdateTarget` and its members (`modelResolver`, `setMainLlm`/`setClassifierLlm`/`setHelperLlm`, `mirrorAgentCfg`, `drainWorkers`, `invalidateSessions`) are named identically in the Task 3 module interface AND the `SmartServer._configUpdateTarget()` object literal. `handleConfigUpdate(req, res, smartAgent, target)`, `handleChat(..., cfg)`, `handleAdapterRequest(...)` signatures match their call-site rewrites. `modelResolver` typed `IModelResolver` (matches `cfg.modelResolver` decl at smart-server.ts:288).

**4. Public API byte-stable (the P1 review fix):** the config handler is reached through a PRIVATE `_configUpdateTarget()` returning an object literal — `SmartServer` does NOT `implements IConfigUpdateTarget`, so no public method is added and the exported class shape is unchanged.
