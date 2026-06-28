# Smart-server.ts Decomposition (PR-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 3926-line god-object `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` into a thin composition root plus five small, interface-bounded, reusable library modules — behavior-preserving and public-API byte-stable — delivered as ONE PR of six ordered commits.

**Architecture:** Follow the already-approved blueprint in `docs/superpowers/specs/2026-06-26-monolith-audit.md → ## Blueprint: smart-server.ts`. Five responsibilities (R1 routing, R2 composition root, R3 sessions, R5 LLM role-resolution, R6 workers/knowledge) leave the class in slice order; **R4 (MCP) is intentionally NOT touched** (it rides into the later `llm-agent-mcp/client.ts` plan). Each extraction lands in the **library** as a focused module the residual `SmartServer` *consumes* (Architecture Principle 2: the app IS the example). Every relocated public function keeps a barrel re-export from `smart-server.ts` so import paths stay byte-stable.

**Tech Stack:** TypeScript (ESM, `.js` import extensions, strict mode, Node ≥ 22), `node:test` + `tsx` for tests, Biome for lint/format. No new runtime dependencies.

## Global Constraints

Copy these binding rules verbatim into every task's working context:

- **ONE PR / SIX COMMITS.** The six slices are six ordered commits on branch `refactor/smart-server-decompose`, NOT six PRs. Each task ends with exactly one conventional commit (`refactor:` or `test:`).
- **R4 / MCP is UNTOUCHED.** Do NOT change `connectMcpClientsFromConfig` (920), `buildMcpBridge` (947), `callMcp` (2236–2243), or any `makeConnectionStrategy` usage. Leave the fields `_sharedMcpClients` (1080), `_stepperMcpClients` (1064), `_mcpSeamInjected` (1073) exactly as-is; only relocate the NON-MCP cluster around them.
- **Behavior-preserving.** No route's method+path+status+JSON/SSE shape changes. No observable runtime behavior changes. Pinned by existing characterization tests + two new gap-tests.
- **Public API byte-stable via barrel re-exports.** The `SmartServer` class, `start()`/`SmartServerHandle`, exported config interfaces, and every module function other packages import (`connectMcpClientsFromConfig`, `buildMcpBridge`, `buildSessionLifecycle`, `buildAgent`, `writeNotReady`, `resolveWorkerLlmSet`, `drainWorkerCache`, `backfillWorkerCacheFromHandle`, `resolveSubAgentRagRegistry`, `seedSessionKnowledge`, `recordSessionStart`, `recordSessionEnd`, `handleListSessions`, `handleResumeSession`, `handleDeleteSession`, the `WorkerLlmSet`/`SessionLifecycleOptions`/`SessionLifecycle`/`SessionListBody`/`SessionResumeBody` types) must remain importable from `@mcp-abap-adt/llm-agent-server-libs`. When a function is relocated, add `export { … } from './<new-module>.js'` in `smart-server.ts` (the package barrel `src/index.ts` does `export * from './smart-agent/smart-server.js'`, so re-exporting through `smart-server.ts` keeps every path stable).
- **Components-first, interface-bounded extracts.** Each EXTRACT is a small reusable module with its own focused interface (`makeKnowledgeBackend`, `IRoleLlmResolver`/`RoleLlmResolver`, `session-lifecycle/`, `IWorkerRegistry`/`WorkerRegistry`, `IRoute`/`RouteHandler`/`HttpRouteTable`, `ConfigReloadWatcher`) — never an app-local fragment.
- **The 7 Architecture Principles govern.** See `docs/ARCHITECTURE.md → Architecture Principles` (mirrored in `CLAUDE.md`). State compliance at each commit.

---

## File Structure

### Modules to CREATE (path · responsibility · interface)

- `packages/llm-agent-server-libs/src/smart-agent/knowledge/make-knowledge-backend.ts`
  — pure factory selecting `JsonlKnowledgeBackend` vs `InMemoryKnowledgeBackend` and attaching the embedder semantic index.
  Interface: `makeKnowledgeBackend(input: { logDir?: string; embedder?: IEmbedder }): KnowledgeBackend`.
- `packages/llm-agent-server-libs/src/smart-agent/llm/role-llm-resolver.ts`
  — role→LLM resolution (`main`/`helper`/`planner`/`classifier`) over the normalized map + fallback chain, reading **live** server LLM fields via accessors so hot-swap is preserved.
  Interface: `IRoleLlmResolver { resolve(role: string): Promise<ILlm>; makeLlm(lc: SmartServerLlmConfig): Promise<ILlm>; }`, class `RoleLlmResolver`, free fn `makeDefaultRoleLlm(lc: SmartServerLlmConfig, mainTemp: number | undefined): Promise<ILlm>`.
- `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts`
  — relocation home for the 8 already-extracted session free functions + their response types (`SessionLifecycleOptions`, `SessionLifecycle`, `SessionListBody`, `SessionResumeBody`, `buildSessionLifecycle`, `seedSessionKnowledge`, `recordSessionStart`, `recordSessionEnd`, `handleListSessions`, `handleResumeSession`, `handleDeleteSession`, `resolveSubAgentRagRegistry`).
  Interface: same signatures as today (pure relocation).
- `packages/llm-agent-server-libs/src/smart-agent/workers/worker-registry.ts`
  — owns `_workerLlmCache` + the per-session worker-registry build loop + the 3 worker free functions; reload/config-update drain through it.
  Interface: `IWorkerRegistry { build(parts: SessionAgentParts): Promise<SubAgentRegistry>; drain(): Promise<void>; readonly cache: Map<string, WorkerLlmSet>; }`, class `WorkerRegistry`, plus relocated `WorkerLlmSet`, `resolveWorkerLlmSet`, `drainWorkerCache`, `backfillWorkerCacheFromHandle`.
- `packages/llm-agent-server-libs/src/smart-agent/http/route-table.ts`
  — interface-bounded HTTP dispatcher.
  Interface: `interface IRoute { method: string; match(urlPath: string): RegExpMatchArray | boolean; handle: RouteHandler }`, `type RouteHandler = (rc: RouteContext) => Promise<void>`, class `HttpRouteTable { add(route: IRoute): this; dispatch(rc: RouteContext): Promise<void> }`. (`RouteContext` is the existing 10-arg `_handle` dependency bundle expressed as one object.)
- **(OPTIONAL — only if byte-stability is preserved; see Task 5 Step 6)**
  `packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts`,
  `…/http/adapter-route-handler.ts`, `…/http/config-route-handler.ts`
  — the three large handler bodies carved from `_handleChat`/`_handleAdapterRequest`/`_handleConfigUpdate`.
  **The committed Task-5 design KEEPS these as private `SmartServer` methods** (they read many `this` fields); the route closures delegate to them. Carve them into their own `http/*.ts` files ONLY if it stays behavior-preserving — otherwise do NOT create these three files. The mandatory R1 win is `_handle`'s if/else chain → declarative `HttpRouteTable`, which does not require carving the handlers.
- `packages/llm-agent-server-libs/src/smart-agent/http/response-helpers.ts`
  — relocation home for the response-shaping helpers `mapStopReason`, `jsonError`, `jsonValidationError`, `readBody`, `writeNotReady`, `CORS_HEADERS`.
- `packages/llm-agent-server-libs/src/smart-agent/config-reload-watcher.ts`
  — start/stop strategy wrapping `ConfigWatcher` + the inline reload callback (1685–1796).
  Interface: `interface IConfigReloadWatcher { start(): void; stop(): void }`, class `ConfigReloadWatcher` with a `ConfigReloadDeps` constructor bundle.

### Barrels / files to MODIFY for re-exports

- `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — replace each moved declaration with an `export { … } from './<new-module>.js'` re-export line; keep `SmartServer`, `buildAgent`, and all R4 functions in place.
- `packages/llm-agent-server-libs/src/index.ts` — UNCHANGED (it already does `export * from './smart-agent/smart-server.js'`; the re-exports flow through automatically). Verify, do not edit.

> **Test commands used throughout.** Single test file (run from the package dir):
> `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/<file>.test.ts`
> Full package suite (gate before every commit): `npm test -w @mcp-abap-adt/llm-agent-server-libs`
> Type/compile gate before every commit: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
> (The package `test` script is `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`; the single-file form above runs one file directly.)

> **NOTE (blueprint staleness found vs real code):** §4 cites `public-api.test.ts` as the export-contract pin, but there is **no** `public-api.test.ts` in `src/smart-agent/__tests__/` (only `factories/__tests__/public-api.test.ts`, which covers factory exports, and `llm-agent-mcp`'s own). The export contract for the relocated functions is therefore pinned by (a) the full-suite green run (existing tests import these symbols from the package barrel), and (b) the `npm run build` compile gate. Treat the green build + full suite as the byte-stable-export gate in every task.

---

### Task 1: `makeKnowledgeBackend` factory (R6 knowledge sub-seam)

Rough Δ: −15 / +35. Risk: **very low** (pure, single field `_stepperKnowledgeBackend`, covered by existing knowledge tests). Sets the EXTRACT pattern.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/knowledge/make-knowledge-backend.ts`
- Create test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/make-knowledge-backend.test.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts:2298-2313` (`buildKnowledgeBackend` calls the new factory)

**Interfaces:**
- Consumes: existing `JsonlKnowledgeBackend` (from `./jsonl-knowledge-backend.js`), `InMemoryKnowledgeBackend` + `KnowledgeBackend` type (from `@mcp-abap-adt/llm-agent-libs`), `makeKnowledgeSemanticIndex` (from `./embedder-knowledge-index.js`), `IEmbedder` (from `@mcp-abap-adt/llm-agent`).
- Produces: `makeKnowledgeBackend(input: { logDir?: string; embedder?: IEmbedder }): KnowledgeBackend`.

Current code being factored out (`smart-server.ts:2298-2313`):

```ts
  private buildKnowledgeBackend(): void {
    if (this._stepperKnowledgeBackend) return;
    const logDir = this.cfg.logDir;
    const semantic = this._resolvedEmbedder
      ? makeKnowledgeSemanticIndex(this._resolvedEmbedder)
      : undefined;
    this._stepperKnowledgeBackend = logDir
      ? new JsonlKnowledgeBackend(logDir, semantic)
      : new InMemoryKnowledgeBackend(semantic);
  }
```

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-server-libs/src/smart-agent/__tests__/make-knowledge-backend.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryKnowledgeBackend,
} from '@mcp-abap-adt/llm-agent-libs';
import { JsonlKnowledgeBackend } from '../jsonl-knowledge-backend.js';
import { makeKnowledgeBackend } from '../knowledge/make-knowledge-backend.js';

test('no logDir → InMemoryKnowledgeBackend', () => {
  const backend = makeKnowledgeBackend({ logDir: undefined, embedder: undefined });
  assert.ok(backend instanceof InMemoryKnowledgeBackend);
});

test('logDir set → JsonlKnowledgeBackend', () => {
  const backend = makeKnowledgeBackend({ logDir: '/tmp/kb-test', embedder: undefined });
  assert.ok(backend instanceof JsonlKnowledgeBackend);
});

test('embedder present → semantic index attached (in-memory path stays in-memory)', () => {
  const fakeEmbedder = {
    embed: async () => ({ ok: true as const, value: [0] }),
    dimensions: 1,
  } as unknown as Parameters<typeof makeKnowledgeBackend>[0]['embedder'];
  const backend = makeKnowledgeBackend({ logDir: undefined, embedder: fakeEmbedder });
  assert.ok(backend instanceof InMemoryKnowledgeBackend);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/make-knowledge-backend.test.ts`
Expected: FAIL — `Cannot find module '../knowledge/make-knowledge-backend.js'`.

- [ ] **Step 3: Write the factory**

Create `packages/llm-agent-server-libs/src/smart-agent/knowledge/make-knowledge-backend.ts`:

```ts
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  InMemoryKnowledgeBackend,
  type KnowledgeBackend,
} from '@mcp-abap-adt/llm-agent-libs';
import { makeKnowledgeSemanticIndex } from '../embedder-knowledge-index.js';
import { JsonlKnowledgeBackend } from '../jsonl-knowledge-backend.js';

/**
 * Build the ONE knowledge backend shared across all requests (JSONL when a
 * logDir is set, else in-memory). When an embedder is provided, an
 * embedder-backed semantic index is attached so recall ranks by meaning.
 * Pure factory — no MCP dependency, safe to call before MCP resolves.
 */
export function makeKnowledgeBackend(input: {
  logDir?: string;
  embedder?: IEmbedder;
}): KnowledgeBackend {
  const semantic = input.embedder
    ? makeKnowledgeSemanticIndex(input.embedder)
    : undefined;
  return input.logDir
    ? new JsonlKnowledgeBackend(input.logDir, semantic)
    : new InMemoryKnowledgeBackend(semantic);
}
```

> Verify the exact import source of `KnowledgeBackend`/`InMemoryKnowledgeBackend` against the current `smart-server.ts` import block (they are imported there today — copy the same specifier). If `KnowledgeBackend` is not re-exported from `@mcp-abap-adt/llm-agent-libs`, import it from the same path `smart-server.ts` uses.

- [ ] **Step 4: Run the factory test — green**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/make-knowledge-backend.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewire `buildKnowledgeBackend` to call the factory**

In `smart-server.ts` replace the body at `2298-2313` with a delegation (keep the method + its idempotent guard + field write):

```ts
  private buildKnowledgeBackend(): void {
    if (this._stepperKnowledgeBackend) return;
    this._stepperKnowledgeBackend = makeKnowledgeBackend({
      logDir: this.cfg.logDir,
      embedder: this._resolvedEmbedder,
    });
  }
```

Add the import near the other `./` imports in `smart-server.ts`:

```ts
import { makeKnowledgeBackend } from './knowledge/make-knowledge-backend.js';
```

Remove the now-unused `makeKnowledgeSemanticIndex` / `JsonlKnowledgeBackend` / `InMemoryKnowledgeBackend` imports from `smart-server.ts` ONLY if no other code in the file still references them (grep first: `grep -n 'makeKnowledgeSemanticIndex\|JsonlKnowledgeBackend\|InMemoryKnowledgeBackend' smart-server.ts`). `InMemoryKnowledgeBackend` is still used by `knowledgeRagFor` (2218) — keep it. Leave imports that are still referenced.

- [ ] **Step 6: Compile + full suite gate**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Expected: no type errors.
Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs`
Expected: all pass, including `embedder-knowledge-index.test.ts`, `jsonl-knowledge-backend.test.ts`, and the new `make-knowledge-backend.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/knowledge/make-knowledge-backend.ts \
        packages/llm-agent-server-libs/src/smart-agent/__tests__/make-knowledge-backend.test.ts \
        packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "refactor: extract makeKnowledgeBackend factory from SmartServer (R6 knowledge sub-seam)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `RoleLlmResolver` value object (R5)

Rough Δ: −45 / +90. Risk: **low**. Closed resolution logic; new gap-test (§4) pins it; reused by R6.

> **CRITICAL design note (blueprint stale vs real code):** §2 claims the 6 LLM fields are "written only here + once in `_buildInfra`". In the REAL code the fields `_mainLlm`/`_helperLlm`/`_classifierLlm` and `_llmMap`/`_pipelineFallback`/`_mainTemp` are **read directly** by `partsToBaseInput` (2529–2531), `buildServerCtx` (2636–2640), `buildSessionAgent` guard (2814), AND hot-swapped by `_handleConfigUpdate` (3873–3876). The resolver must therefore NOT own the fields — it must read them through **live accessors** so (a) every direct reader keeps the field as source-of-truth and (b) the hot-swap at 3873–3876 is transparently observed. Extract only the *resolution algorithm*, leave the fields on the server.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/llm/role-llm-resolver.ts`
- Create test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/role-llm-resolver.test.ts`
- Modify: `smart-server.ts` — `_makeLlm` (2172), `_makeLlmDefault` (2177), `resolveRoleLlm` (2192–2213), construct the resolver in `_buildInfra` after 2237, delegate the call sites at 2200/2583/2635.

**Interfaces:**
- Consumes: `ILlm`, `SmartServerLlmConfig` (from current `smart-server.ts` imports), `NormalizedLlmMap` + `resolveLlmConfig` (from `./config.js`), `makeLlm` (from `@mcp-abap-adt/llm-agent-libs`).
- Produces:
  - `makeDefaultRoleLlm(lc: SmartServerLlmConfig, mainTemp: number | undefined): Promise<ILlm>`
  - `interface IRoleLlmResolver { resolve(role: string): Promise<ILlm>; makeLlm(lc: SmartServerLlmConfig): Promise<ILlm>; }`
  - `class RoleLlmResolver implements IRoleLlmResolver` constructed with:
    ```ts
    interface RoleLlmResolverDeps {
      getMain(): ILlm | undefined;
      getHelper(): ILlm | undefined;
      getClassifier(): ILlm | undefined;
      getLlmMap(): NormalizedLlmMap | undefined;
      getPipelineFallback(): SmartServerLlmConfig | undefined;
      makeLlm(lc: SmartServerLlmConfig): Promise<ILlm>;
    }
    ```

Current code being moved (`smart-server.ts:2172-2203`):

```ts
  private _makeLlm(lc: SmartServerLlmConfig): Promise<ILlm> {
    return this._deps.makeLlm(lc);
  }

  private _makeLlmDefault(lc: SmartServerLlmConfig): Promise<ILlm> {
    return makeLlm(
      {
        provider: lc.provider ?? 'deepseek',
        apiKey: lc.apiKey,
        baseURL: lc.url,
        model: lc.model,
      },
      Number(lc.temperature ?? this._mainTemp ?? 0.7),
    );
  }

  private async resolveRoleLlm(role: string): Promise<ILlm> {
    if (role === 'main' && this._mainLlm) return this._mainLlm;
    if ((role === 'helper' || role === 'planner') && this._helperLlm) {
      return this._helperLlm;
    }
    if (role === 'classifier' && this._classifierLlm)
      return this._classifierLlm;
    const cfg = resolveLlmConfig(this._llmMap, role, this._pipelineFallback);
    if (cfg) return this._makeLlm(cfg);
    if (this._mainLlm) return this._mainLlm;
    throw new Error(`cannot resolve LLM for role '${role}': no config`);
  }
```

- [ ] **Step 1: Write the failing gap-test (§4 #2)**

Create `packages/llm-agent-server-libs/src/smart-agent/__tests__/role-llm-resolver.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { RoleLlmResolver } from '../llm/role-llm-resolver.js';

const stub = (tag: string) => ({ tag }) as unknown as ILlm;

function makeFields() {
  return {
    main: stub('main') as ILlm | undefined,
    helper: stub('helper') as ILlm | undefined,
    classifier: stub('classifier') as ILlm | undefined,
  };
}

test('each role returns its cached instance', async () => {
  const f = makeFields();
  const r = new RoleLlmResolver({
    getMain: () => f.main,
    getHelper: () => f.helper,
    getClassifier: () => f.classifier,
    getLlmMap: () => undefined,
    getPipelineFallback: () => undefined,
    makeLlm: async () => stub('built'),
  });
  assert.equal(await r.resolve('main'), f.main);
  assert.equal(await r.resolve('helper'), f.helper);
  assert.equal(await r.resolve('planner'), f.helper); // planner shares helper
  assert.equal(await r.resolve('classifier'), f.classifier);
});

test('unknown role with no map/fallback falls back to main', async () => {
  const f = makeFields();
  const r = new RoleLlmResolver({
    getMain: () => f.main,
    getHelper: () => undefined,
    getClassifier: () => undefined,
    getLlmMap: () => undefined,
    getPipelineFallback: () => undefined,
    makeLlm: async () => stub('built'),
  });
  assert.equal(await r.resolve('reviewer'), f.main);
});

test('hot-swap of main is observed through the live accessor', async () => {
  const f = makeFields();
  const r = new RoleLlmResolver({
    getMain: () => f.main,
    getHelper: () => f.helper,
    getClassifier: () => f.classifier,
    getLlmMap: () => undefined,
    getPipelineFallback: () => undefined,
    makeLlm: async () => stub('built'),
  });
  const swapped = stub('main2');
  f.main = swapped; // simulate _handleConfigUpdate reassignment
  assert.equal(await r.resolve('main'), swapped);
});

test('no main and no config throws', async () => {
  const r = new RoleLlmResolver({
    getMain: () => undefined,
    getHelper: () => undefined,
    getClassifier: () => undefined,
    getLlmMap: () => undefined,
    getPipelineFallback: () => undefined,
    makeLlm: async () => stub('built'),
  });
  await assert.rejects(() => r.resolve('main'), /cannot resolve LLM for role 'main'/);
});
```

- [ ] **Step 2: Run it — fails**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/role-llm-resolver.test.ts`
Expected: FAIL — `Cannot find module '../llm/role-llm-resolver.js'`.

- [ ] **Step 3: Write the resolver module**

Create `packages/llm-agent-server-libs/src/smart-agent/llm/role-llm-resolver.ts`:

```ts
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { makeLlm } from '@mcp-abap-adt/llm-agent-libs';
import {
  type NormalizedLlmMap,
  resolveLlmConfig,
} from '../config.js';
import type { SmartServerLlmConfig } from '../config.js';

/** The real `makeLlm`-backed construction (the SmartServer seam's default). */
export function makeDefaultRoleLlm(
  lc: SmartServerLlmConfig,
  mainTemp: number | undefined,
): Promise<ILlm> {
  return makeLlm(
    {
      provider: lc.provider ?? 'deepseek',
      apiKey: lc.apiKey,
      baseURL: lc.url,
      model: lc.model,
    },
    Number(lc.temperature ?? mainTemp ?? 0.7),
  );
}

export interface IRoleLlmResolver {
  resolve(role: string): Promise<ILlm>;
  makeLlm(lc: SmartServerLlmConfig): Promise<ILlm>;
}

export interface RoleLlmResolverDeps {
  getMain(): ILlm | undefined;
  getHelper(): ILlm | undefined;
  getClassifier(): ILlm | undefined;
  getLlmMap(): NormalizedLlmMap | undefined;
  getPipelineFallback(): SmartServerLlmConfig | undefined;
  makeLlm(lc: SmartServerLlmConfig): Promise<ILlm>;
}

/**
 * Resolve a per-role LLM through the normalized map → pipelineFallback chain.
 * Reads the role LLM instances through LIVE accessors so a config-reload
 * hot-swap of `main`/`helper`/`classifier` is observed transparently (the
 * SmartServer keeps the fields as source-of-truth).
 */
export class RoleLlmResolver implements IRoleLlmResolver {
  constructor(private readonly deps: RoleLlmResolverDeps) {}

  makeLlm(lc: SmartServerLlmConfig): Promise<ILlm> {
    return this.deps.makeLlm(lc);
  }

  async resolve(role: string): Promise<ILlm> {
    const main = this.deps.getMain();
    const helper = this.deps.getHelper();
    const classifier = this.deps.getClassifier();
    if (role === 'main' && main) return main;
    if ((role === 'helper' || role === 'planner') && helper) return helper;
    if (role === 'classifier' && classifier) return classifier;
    const cfg = resolveLlmConfig(
      this.deps.getLlmMap(),
      role,
      this.deps.getPipelineFallback(),
    );
    if (cfg) return this.deps.makeLlm(cfg);
    if (main) return main;
    throw new Error(`cannot resolve LLM for role '${role}': no config`);
  }
}
```

> Verify the export of `SmartServerLlmConfig` from `./config.js`. If it is declared in `smart-server.ts` rather than `config.js`, import it from wherever it is declared today (grep `export.*SmartServerLlmConfig`). Do NOT change its declaration site.

- [ ] **Step 4: Run resolver test — green**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/role-llm-resolver.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the resolver into SmartServer (preserve every call site + hot-swap)**

In `smart-server.ts`:

1. Add a private field next to the LLM fields (after 1042):
```ts
  private _roleLlm?: IRoleLlmResolver;
```
2. Add the import:
```ts
import {
  type IRoleLlmResolver,
  makeDefaultRoleLlm,
  RoleLlmResolver,
} from './llm/role-llm-resolver.js';
```
3. Keep `_makeLlmDefault` as a thin wrapper (the constructor seam default at 1132 still calls `this._makeLlmDefault(cfg)`):
```ts
  private _makeLlmDefault(lc: SmartServerLlmConfig): Promise<ILlm> {
    return makeDefaultRoleLlm(lc, this._mainTemp);
  }
```
4. Replace `_makeLlm` (2172–2174) to delegate via the resolver when present, else the seam:
```ts
  private _makeLlm(lc: SmartServerLlmConfig): Promise<ILlm> {
    return this._roleLlm ? this._roleLlm.makeLlm(lc) : this._deps.makeLlm(lc);
  }
```
   (The resolver's `makeLlm` is wired in step 6 to `this._deps.makeLlm`, so this is byte-identical to today's `this._deps.makeLlm(lc)`.)
5. Replace `resolveRoleLlm` (2192–2203) to delegate:
```ts
  private async resolveRoleLlm(role: string): Promise<ILlm> {
    if (!this._roleLlm) {
      throw new Error('resolveRoleLlm invoked before _buildInfra built the resolver');
    }
    return this._roleLlm.resolve(role);
  }
```
   (The 2583 `resolveLlm: (role) => this.resolveRoleLlm(role)` and 2635 `makeLlm: (c) => this._makeLlm(c)` call sites stay untouched.)

- [ ] **Step 6: Construct the resolver in `_buildInfra` after the LLM fields are assigned**

In `_buildInfra`, immediately after line 1237 (`this._mainTemp = mainTemp;`), add:

```ts
    this._roleLlm = new RoleLlmResolver({
      getMain: () => this._mainLlm,
      getHelper: () => this._helperLlm,
      getClassifier: () => this._classifierLlm,
      getLlmMap: () => this._llmMap,
      getPipelineFallback: () => this._pipelineFallback,
      makeLlm: (lc) => this._deps.makeLlm(lc),
    });
```

> The hot-swap path at 3873–3876 (`this._mainLlm = …` etc.) needs NO change: the resolver reads the fields through `getMain`/`getHelper`/`getClassifier` at call time, so the swapped instances are observed automatically. Do not touch 3873–3876.

- [ ] **Step 7: Compile + full suite gate**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Expected: no type errors.
Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs`
Expected: all pass, especially `llm-map-normalize.test.ts`, `config-endpoints.test.ts` (PUT /v1/config hot-swap), `readiness-gate.test.ts`, and the new `role-llm-resolver.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/llm/role-llm-resolver.ts \
        packages/llm-agent-server-libs/src/smart-agent/__tests__/role-llm-resolver.test.ts \
        packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "refactor: extract RoleLlmResolver from SmartServer (R5 role-LLM resolution)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `session-lifecycle/` relocation (R3)

Rough Δ: −120 / +130 (mostly moves). Risk: **low** — almost a file-move; pinned by 4 existing session tests.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts`
- Modify: `smart-server.ts:670-890` (cut the 8 free functions + 4 types) and add re-exports; `_withSession` (2847–2902) stays a class method (it touches `this._lifecycle` / `this._sessionMetaStore`) and keeps consuming the relocated `recordSessionStart`/`recordSessionEnd` via the re-export.
- Test (existing, run to prove preserved): `smart-server-session-lifecycle.test.ts`, `sessions-endpoints.test.ts`, `session-identity-resolver.test.ts`, `session-meta-store.test.ts`.

**Interfaces:**
- Consumes (unchanged imports, moved with the code): `SessionGraphFactory`, `SessionRegistry`, `SessionGraph`, `resolveSessionIdentity`, `IRag`, `IRagRegistry`, `IMcpClient`, `ILogger`, `SmartAgent`, `SessionAgentParts`, `ISessionMetaStore`, `SessionMetaRow`, `IKnowledgeRagHandle`.
- Produces (relocated, re-exported from `smart-server.ts` unchanged): `SessionLifecycleOptions`, `buildSessionLifecycle`, `SessionLifecycle`, `SessionListBody`, `SessionResumeBody`, `seedSessionKnowledge`, `recordSessionStart`, `recordSessionEnd`, `handleListSessions`, `handleResumeSession`, `handleDeleteSession`, `resolveSubAgentRagRegistry`.

- [ ] **Step 1: Baseline the existing R3 tests (characterization — must already pass)**

Run each:
```bash
cd packages/llm-agent-server-libs
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/smart-server-session-lifecycle.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/sessions-endpoints.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/session-identity-resolver.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/session-meta-store.test.ts
```
Expected: all PASS (this is the green baseline the relocation must preserve).

- [ ] **Step 2: Create the relocation module (move bodies verbatim)**

Create `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts` and MOVE — byte-for-byte — the following from `smart-server.ts`:
- `resolveSubAgentRagRegistry` (670–674)
- `SessionLifecycleOptions` (680–696)
- `buildSessionLifecycle` (704–748) + `export type SessionLifecycle = ReturnType<typeof buildSessionLifecycle>;` (750)
- `SessionListBody` (757–759), `SessionResumeBody` (762–766)
- `seedSessionKnowledge` (775–799)
- `recordSessionStart` (809–827), `recordSessionEnd` (833–842)
- `handleListSessions` (848–854), `handleResumeSession` (860–872), `handleDeleteSession` (877–890)

Move each function's imports too. The module header imports (copy the exact specifiers currently used in `smart-server.ts`):

```ts
import type {
  IKnowledgeRagHandle,
  ILogger,
  IMcpClient,
  IRag,
  IRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import {
  type SessionAgentParts,
  SessionGraph,
  SessionGraphFactory,
  SessionRegistry,
  type SmartAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import { resolveSessionIdentity } from '../session-identity-resolver.js';
import type {
  ISessionMetaStore,
  SessionMetaRow,
} from '../session-meta-store.js';
```

> Verify each specifier against the live `smart-server.ts` import block before transcribing (e.g. `SessionGraph`/`SessionGraphFactory`/`SessionRegistry`/`SessionAgentParts` come from `@mcp-abap-adt/llm-agent-libs`; `resolveSessionIdentity` from `./session-identity-resolver.js`). Keep them identical — this is a relocation, not a rewrite.

- [ ] **Step 3: Replace the moved declarations in `smart-server.ts` with re-exports**

Delete the 12 moved declarations from `smart-server.ts` and add a single re-export block (placed where the old `// /v1/sessions extracted handlers` section header was, ~752):

```ts
export {
  buildSessionLifecycle,
  handleDeleteSession,
  handleListSessions,
  handleResumeSession,
  recordSessionEnd,
  recordSessionStart,
  resolveSubAgentRagRegistry,
  seedSessionKnowledge,
  type SessionLifecycle,
  type SessionLifecycleOptions,
  type SessionListBody,
  type SessionResumeBody,
} from './session-lifecycle/index.js';
```

Add an internal import for the symbols `smart-server.ts` still *calls* in `_withSession`, `knowledgeRagFor`, and `_handle` (`recordSessionStart`, `recordSessionEnd`, `seedSessionKnowledge`, `handleListSessions`, `handleResumeSession`, `handleDeleteSession`, `buildSessionLifecycle`, `resolveSubAgentRagRegistry`, and the types):

```ts
import {
  buildSessionLifecycle,
  handleDeleteSession,
  handleListSessions,
  handleResumeSession,
  recordSessionEnd,
  recordSessionStart,
  resolveSubAgentRagRegistry,
  seedSessionKnowledge,
  type SessionLifecycle,
  type SessionLifecycleOptions,
  type SessionListBody,
  type SessionResumeBody,
} from './session-lifecycle/index.js';
```

> A re-exported symbol can be both imported (for internal use) and re-exported. If Biome flags a redundant import+export, collapse to `export { … } from './session-lifecycle/index.js'` for the re-export and a separate `import { … }` for the internal callers — both are valid; keep whichever the linter accepts. Run `grep -n 'buildSessionLifecycle\|recordSessionStart\|recordSessionEnd\|seedSessionKnowledge\|handleListSessions\|handleResumeSession\|handleDeleteSession\|resolveSubAgentRagRegistry' smart-server.ts` and confirm every remaining USAGE resolves to the imported binding.

- [ ] **Step 4: Compile + run the 4 R3 tests + full suite — green**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Expected: no type errors.
Run the 4 commands from Step 1.
Expected: all PASS (behavior preserved).
Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts \
        packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "refactor: relocate session-lifecycle helpers into session-lifecycle/ (R3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `WorkerRegistry` module (R6 worker sub-seam)

Rough Δ: −210 / +230. Risk: **medium** — three writers of `_workerLlmCache` collapse to one owner. Do after Task 2 (it consumes the resolver materials).

> **Design (behavior-preserving, bounded):** Move the cache map + the per-session registry build loop (`buildWorkerRegistry` 2435–2506) + the 3 worker free functions into a `WorkerRegistry` the server constructs once. `buildSubAgent` (1973–2171, ~200 lines, deeply coupled to `this.cfg`/`this._fileLogger`/`this._mergedEmbedderFactories`/`this._deps`) STAYS a private `SmartServer` method; the registry calls it through an injected `buildSubAgent` callback. The cache lives on the registry; `buildSubAgent`'s internal `resolveWorkerLlmSet(this._workerLlmCache, …)` call reads `this._workers.cache`. The reload watcher (1761) and config-update (3900) call `this._workers.drain()` instead of `drainWorkerCache(this._workerLlmCache)`. This collapses the three writers (buildSubAgent via resolveWorkerLlmSet, buildWorkerRegistry's lazy build, the reload drain) to one owner without rewriting the 200-line builder.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/workers/worker-registry.ts`
- Modify: `smart-server.ts` — relocate `WorkerLlmSet` (495–520), `drainWorkerCache` (536–553), `resolveWorkerLlmSet` (567–602), `backfillWorkerCacheFromHandle` (622–659) into the module + re-export; replace the `_workerLlmCache` field (1008) with a `_workers: WorkerRegistry`; rewrite `buildWorkerRegistry` (2435) to delegate; repoint cache reads in `buildSubAgent` (find `this._workerLlmCache`), reload watcher (1761), config-update (3900).
- Test (existing, run to prove preserved): `worker-llm-cache.test.ts`, `subagent-shared-rag.test.ts`.

**Interfaces:**
- Consumes: `ILlm`, `IEmbedder`, `IRag`, `IMcpClient`, `IRagRegistry` (contracts), `SubAgentRegistry`, `SmartAgentSubAgent`, `SessionAgentParts` (from `@mcp-abap-adt/llm-agent-libs`), `ILogger`, plus a `buildSubAgent` callback (the server's method bound).
- Produces:
  - relocated `WorkerLlmSet` interface (unchanged shape), `resolveWorkerLlmSet`, `drainWorkerCache`, `backfillWorkerCacheFromHandle` (unchanged signatures).
  - `interface IWorkerRegistry { build(parts: SessionAgentParts): Promise<SubAgentRegistry>; drain(): Promise<void>; readonly cache: Map<string, WorkerLlmSet>; }`
  - `class WorkerRegistry implements IWorkerRegistry` constructed with:
    ```ts
    interface WorkerRegistryDeps {
      subAgentConfigs: Array<{ name: string; description?: string; config: Omit<SmartServerConfig, 'log'> }> | undefined;
      getFileLogger(): ILogger | undefined;
      getEmbedderFactories(): Record<string, EmbedderFactory>;
      buildSubAgent: (
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
      ) => Promise<SmartAgent>;
    }
    ```

- [ ] **Step 1: Baseline the existing R6 worker tests (must already pass)**

```bash
cd packages/llm-agent-server-libs
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/worker-llm-cache.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/subagent-shared-rag.test.ts
```
Expected: all PASS (green baseline). These two tests are the behavior pin for this relocation; do NOT add a new gap-test here (Task 4 is a relocation slice — the test step is the named existing suite, per blueprint §4).

- [ ] **Step 2: Create the module — move the 3 free functions verbatim + add the class**

Create `packages/llm-agent-server-libs/src/smart-agent/workers/worker-registry.ts`. MOVE `WorkerLlmSet` (495–520, with its doc comment), `drainWorkerCache` (536–553), `resolveWorkerLlmSet` (567–602), `backfillWorkerCacheFromHandle` (622–659) byte-for-byte. Then add the registry class wrapping the current `buildWorkerRegistry` loop. Header imports (verify against live `smart-server.ts`):

```ts
import type {
  IEmbedder,
  ILlm,
  IMcpClient,
  IRag,
  IRagRegistry,
  IRequestLogger,
  ILogger,
} from '@mcp-abap-adt/llm-agent';
import {
  type SessionAgentParts,
  type SmartAgent,
  SmartAgentSubAgent,
  type SubAgentRegistry,
} from '@mcp-abap-adt/llm-agent-libs';
import type { EmbedderFactory } from '@mcp-abap-adt/llm-agent-rag';
import type { SmartServerConfig } from '../smart-server.js'; // or wherever SmartServerConfig is declared — see note
```

> `SmartServerConfig` is declared in `smart-server.ts`. To avoid an import cycle, type `subAgentConfigs`/`subCfg` against `Omit<SmartServerConfig, 'log'>` only if it does not create a cycle that breaks the build; if it does, define a local `type SubAgentConfigEntry = { name: string; description?: string; config: unknown }` and have the server cast at the call boundary. Verify the `EmbedderFactory` import source against the live file (`grep -n EmbedderFactory smart-server.ts`).

The class body (transcribe the current `buildWorkerRegistry` 2435–2506, swapping `this.cfg.subAgentConfigs`→`this.deps.subAgentConfigs`, `this._fileLogger`→`this.deps.getFileLogger()`, `this._mergedEmbedderFactories ?? {}`→`this.deps.getEmbedderFactories()`, `this.buildSubAgent(...)`→`this.deps.buildSubAgent(...)`, `this._workerLlmCache`→`this.cache`):

```ts
export class WorkerRegistry implements IWorkerRegistry {
  readonly cache = new Map<string, WorkerLlmSet>();
  constructor(private readonly deps: WorkerRegistryDeps) {}

  async drain(): Promise<void> {
    await drainWorkerCache(this.cache);
  }

  async build(parts: SessionAgentParts): Promise<SubAgentRegistry> {
    const registry: SubAgentRegistry = new Map();
    const subAgentConfigs = this.deps.subAgentConfigs;
    if (!subAgentConfigs || subAgentConfigs.length === 0) {
      return registry;
    }
    const fileLogger = this.deps.getFileLogger();
    if (!fileLogger) {
      throw new Error(
        'buildWorkerRegistry invoked before primary build() captured globals',
      );
    }
    const embedderFactories = this.deps.getEmbedderFactories();
    for (const sub of subAgentConfigs) {
      if (!this.cache.has(sub.name)) {
        await this.deps.buildSubAgent(
          sub.name,
          sub.config,
          fileLogger,
          embedderFactories,
        );
      }
      const cached = this.cache.get(sub.name);
      if (!cached) {
        throw new Error(`worker LLM set not cached for '${sub.name}'`);
      }
      const injectedMcpClients =
        cached.mcpClients && cached.mcpClients.length > 0
          ? cached.mcpClients
          : parts.mcpClients;
      const injectedToolsRag = cached.toolsRag ?? parts.toolsRag;
      const subAgent = await this.deps.buildSubAgent(
        sub.name,
        sub.config,
        fileLogger,
        embedderFactories,
        {
          ragRegistry: parts.ragRegistry,
          toolsRag: injectedToolsRag,
          mcpClients: injectedMcpClients,
          requestLogger: parts.logger,
          mainLlm: cached.mainLlm,
          classifierLlm: cached.classifierLlm,
          helperLlm: cached.helperLlm,
          embedder: cached.embedder,
        },
      );
      registry.set(
        sub.name,
        new SmartAgentSubAgent(sub.name, subAgent, {
          description: sub.description,
        }),
      );
    }
    return registry;
  }
}
```

> Verify `parts.mcpClients`/`parts.toolsRag`/`parts.ragRegistry`/`parts.logger` field names against the real `SessionAgentParts` shape used at 2480–2491 — copy them exactly.

- [ ] **Step 3: Run the module in isolation (compile only — no new unit test)**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Expected: type-clean compile of the new module (the existing worker tests in Step 6 are the behavior gate).

- [ ] **Step 4: Wire `WorkerRegistry` into SmartServer**

In `smart-server.ts`:
1. Replace the field at 1008:
```ts
  // before: private readonly _workerLlmCache = new Map<string, WorkerLlmSet>();
  private _workers!: WorkerRegistry;
```
2. Re-export + import the relocated symbols (drop the in-file declarations of `WorkerLlmSet`/`drainWorkerCache`/`resolveWorkerLlmSet`/`backfillWorkerCacheFromHandle`):
```ts
export {
  backfillWorkerCacheFromHandle,
  drainWorkerCache,
  resolveWorkerLlmSet,
  type WorkerLlmSet,
} from './workers/worker-registry.js';
import {
  backfillWorkerCacheFromHandle,
  resolveWorkerLlmSet,
  WorkerRegistry,
  type WorkerLlmSet,
} from './workers/worker-registry.js';
```
   (Collapse import+export per the linter as in Task 3 Step 3.)
3. Construct the registry in `_buildInfra` after the embedder factories are captured (after 1325 `this._mergedEmbedderFactories = mergedEmbedderFactories;`):
```ts
    this._workers = new WorkerRegistry({
      subAgentConfigs: this.cfg.subAgentConfigs,
      getFileLogger: () => this._fileLogger,
      getEmbedderFactories: () => this._mergedEmbedderFactories ?? {},
      buildSubAgent: (name, subCfg, parentLogger, factories, injected) =>
        this.buildSubAgent(name, subCfg, parentLogger, factories, injected),
    });
```
   > If `_buildInfra` builds workers BEFORE 1325 anywhere, construct the registry at the earliest point where both `_fileLogger` (1195) and `_mergedEmbedderFactories` (1325) are set — both are read lazily via the accessors, so placement only needs to precede the first `this._workers` use. Grep `this._workers` after wiring to confirm no use precedes construction.
4. Rewrite `buildWorkerRegistry` (2435–2506) to delegate:
```ts
  private async buildWorkerRegistry(
    parts: SessionAgentParts,
  ): Promise<SubAgentRegistry> {
    return this._workers.build(parts);
  }
```
5. Repoint every `this._workerLlmCache` read in `buildSubAgent` to `this._workers.cache`. Grep `grep -n 'this._workerLlmCache' smart-server.ts` — each remaining occurrence (the `resolveWorkerLlmSet({ cache: this._workerLlmCache, … })` call inside `buildSubAgent`, and `backfillWorkerCacheFromHandle` usage) becomes `this._workers.cache`.
6. Repoint the drain call sites:
   - reload watcher 1761: `drainWorkerCache(this._workerLlmCache)` → `this._workers.drain()`
   - config-update 3900: `await drainWorkerCache(this._workerLlmCache);` → `await this._workers.drain();`
   - server `close()` drain (if any references `_workerLlmCache` — grep): → `this._workers.drain()`

- [ ] **Step 5: Compile**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Expected: no type errors. Resolve any residual `_workerLlmCache` reference the grep missed.

- [ ] **Step 6: Run the worker tests + full suite — green**

```bash
cd packages/llm-agent-server-libs
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/worker-llm-cache.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/subagent-shared-rag.test.ts
```
Expected: all PASS (behavior preserved — same lazy build-on-miss, same per-worker slot priority, same drain-on-reload).
Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/workers/worker-registry.ts \
        packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "refactor: extract WorkerRegistry owning the worker-LLM cache (R6 worker sub-seam)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `HttpRouteTable` + route handlers (R1)

Rough Δ: −900 / +620. Risk: **medium-high** — biggest line win, highest blast (every route). Gate behind the new route-table characterization test (§4 #1) + all endpoint tests. `_handle` already takes its deps as 10 args (no hidden `this` state besides `_withSession`/`_lifecycle`/`_sessionMetaStore`/`_stepperKnowledgeBackend`), so it is a pure dispatcher waiting to become a table.

> **Design:** Introduce `HttpRouteTable` + `IRoute`/`RouteHandler` over a `RouteContext` value object that bundles the 10 `_handle` args + `this` access the routes need. To bound risk and stay behavior-preserving, KEEP `_handleChat`/`_handleAdapterRequest`/`_handleConfigUpdate` as `SmartServer` private methods (they read many `this` fields); the carved `http/*.ts` handlers are thin `RouteHandler` closures that call back into those methods through the `RouteContext`. The win is `_handle`'s ~300-line if/else chain (2915–3205) becoming a `routeTable.dispatch(rc)` plus a declarative route list. Relocate the pure response helpers to `http/response-helpers.ts` and re-export.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/http/route-table.ts`
- Create: `packages/llm-agent-server-libs/src/smart-agent/http/response-helpers.ts`
- Create test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/route-table.test.ts`
- Modify: `smart-server.ts` — replace `_handle` body (2915–3205) with route-table construction + `dispatch`; relocate `mapStopReason` (358), `jsonError` (364), `jsonValidationError` (370), `readBody` (385), `CORS_HEADERS` (412), `writeNotReady` (985) to `http/response-helpers.ts` + re-export.
- Test (existing, run to prove preserved): `config-endpoints.test.ts`, `smart-server-api-adapters.test.ts`, `readiness-gate.test.ts`, `usage-per-session.test.ts`, `sessions-endpoints.test.ts`.

**Interfaces:**
- Consumes: `IncomingMessage`, `ServerResponse` (node `http`), the response helpers, and the existing handler methods.
- Produces:
  - `interface RouteContext { req: IncomingMessage; res: ServerResponse; rawUrl: string; urlPath: string; method: string; server: SmartServer; requestLogger: IRequestLogger; smartAgent: SmartAgent; chat: SmartAgentHandle['chat']; streamChat: SmartAgentHandle['streamChat']; log: (e: Record<string, unknown>) => void; healthChecker: HealthChecker; modelProvider?: IModelProvider; adapterMap?: Map<string, ILlmApiAdapter>; }`
  - `type RouteHandler = (rc: RouteContext) => Promise<void>`
  - `interface IRoute { method: string | string[]; match(urlPath: string): RegExpMatchArray | boolean; handle: RouteHandler }`
  - `class HttpRouteTable { add(route: IRoute): this; dispatch(rc: RouteContext): Promise<void> }` — iterates routes, first method+match wins, else 404.
- Relocated (re-exported byte-stable): `writeNotReady`, plus the internal helpers `mapStopReason`/`jsonError`/`jsonValidationError`/`readBody`/`CORS_HEADERS` (only `writeNotReady` is part of the documented public surface; re-export it; the others can be re-exported too for safety or kept internal — re-export `writeNotReady` at minimum).

- [ ] **Step 1: Write the failing route-table characterization gap-test (§4 #1)**

Create `packages/llm-agent-server-libs/src/smart-agent/__tests__/route-table.test.ts`. This test boots a real `SmartServer` with a minimal in-memory config (mirror the setup used by `readiness-gate.test.ts` / `sessions-endpoints.test.ts` — copy their fixture/config builder) and asserts the small infra routes' status + body:

```ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SmartServer } from '../smart-server.js';

// Reuse the same minimal config + injected makeLlm/embedder seam the existing
// readiness-gate.test.ts uses (copy its `makeTestServer` helper verbatim here,
// or import it if it is exported). The server must start WITHOUT real
// credentials via the injected deps seam.
let handle: { port: number; close: () => Promise<void> };
let base: string;

before(async () => {
  const server = new SmartServer(/* minimalConfig */ {} as never, /* deps seam */ {} as never);
  handle = await server.start();
  base = `http://127.0.0.1:${handle.port}`;
});
after(async () => { await handle.close(); });

test('GET /v1/models → 200 list with smart-agent entry', async () => {
  const r = await fetch(`${base}/v1/models`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m: { id: string }) => m.id === 'smart-agent'));
});

test('GET /v1/embedding-models → 200 list', async () => {
  const r = await fetch(`${base}/v1/embedding-models`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
});

test('GET /v1/models?exclude_embedding=true → 200 list', async () => {
  const r = await fetch(`${base}/v1/models?exclude_embedding=true`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
});

test('OPTIONS → 204 with CORS headers', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-methods') ?? '', /GET, POST, PUT, OPTIONS/);
});

test('unknown path → 404 with invalid_request_error', async () => {
  const r = await fetch(`${base}/no/such/route`);
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /Cannot GET \/no\/such\/route/);
});
```

> Before writing, READ `readiness-gate.test.ts` to copy its exact `SmartServer` construction (config shape + injected `makeLlm`/`embedder`/`mcpClients` seam) so the server starts without credentials. Pin this test GREEN against the CURRENT `_handle` first (it characterizes existing behavior).

- [ ] **Step 2: Run it against current code — PASS (characterization baseline)**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/route-table.test.ts`
Expected: PASS against the current `_handle`. (This is a characterization pin — it must pass BEFORE and AFTER the extraction. If it fails now, fix the test's fixture, not the server.)

- [ ] **Step 3: Relocate the response helpers**

Create `packages/llm-agent-server-libs/src/smart-agent/http/response-helpers.ts` and MOVE byte-for-byte from `smart-server.ts`: `mapStopReason` (358–362), `jsonError` (364–368), `jsonValidationError` (370–383), `readBody` (385–392), `CORS_HEADERS` (412–416), `writeNotReady` (985–998). Copy their imports (`IncomingMessage` from `node:http`, `StopReason`/`ExternalToolValidationCode` from `@mcp-abap-adt/llm-agent` — verify specifiers). In `smart-server.ts`, delete those declarations, add:

```ts
export { writeNotReady } from './http/response-helpers.js';
import {
  CORS_HEADERS,
  jsonError,
  jsonValidationError,
  mapStopReason,
  readBody,
  writeNotReady,
} from './http/response-helpers.js';
```

- [ ] **Step 4: Compile + re-run route-table test (helpers relocation green)**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/route-table.test.ts`
Expected: still PASS (pure relocation).

- [ ] **Step 5: Create `HttpRouteTable`**

Create `packages/llm-agent-server-libs/src/smart-agent/http/route-table.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  IRequestLogger,
  ILlmApiAdapter,
  IModelProvider,
} from '@mcp-abap-adt/llm-agent';
import type {
  HealthChecker,
  SmartAgent,
  SmartAgentHandle,
} from '@mcp-abap-adt/llm-agent-libs';
import { jsonError } from './response-helpers.js';
import type { SmartServer } from '../smart-server.js';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  rawUrl: string;
  urlPath: string;
  method: string;
  server: SmartServer;
  requestLogger: IRequestLogger;
  smartAgent: SmartAgent;
  chat: SmartAgentHandle['chat'];
  streamChat: SmartAgentHandle['streamChat'];
  log: (e: Record<string, unknown>) => void;
  healthChecker: HealthChecker;
  modelProvider?: IModelProvider;
  adapterMap?: Map<string, ILlmApiAdapter>;
}

export type RouteHandler = (rc: RouteContext) => Promise<void>;

export interface IRoute {
  method: string | string[];
  match(urlPath: string): RegExpMatchArray | boolean;
  handle: RouteHandler;
}

export class HttpRouteTable {
  private readonly routes: IRoute[] = [];
  add(route: IRoute): this {
    this.routes.push(route);
    return this;
  }
  async dispatch(rc: RouteContext): Promise<void> {
    for (const route of this.routes) {
      const methodOk = Array.isArray(route.method)
        ? route.method.includes(rc.method)
        : route.method === rc.method;
      if (!methodOk) continue;
      const m = route.match(rc.urlPath);
      if (m) {
        await route.handle(rc);
        return;
      }
    }
    rc.res.writeHead(404, { 'Content-Type': 'application/json' });
    rc.res.end(
      jsonError(
        `Cannot ${rc.method} ${rc.urlPath}`,
        'invalid_request_error',
      ),
    );
  }
}
```

> `import type { SmartServer }` is a TYPE-only import — it does not create a runtime cycle. If the build still warns of a cycle, type `server` as a narrow structural interface (`IRouteServer`) exposing only the methods routes invoke (`withSession`, `handleChat`, `handleAdapterRequest`, `handleConfigUpdate`, the lifecycle/meta-store/knowledge-backend accessors) and have `SmartServer` implement it.

- [ ] **Step 6: Build the table inside `_start` / `_handle` and convert the if/else chain to routes**

The route bodies stay where the behavior is testable. The lowest-risk byte-stable conversion: keep `_handle`'s exact ordered logic, but express it as routes whose `handle` closures invoke EXISTING `this.*` methods. Replace the `_handle` body (2915–3205) so it builds the table once and dispatches. Each route's body is the SAME code currently inline — moved verbatim into the closure, with `this`→`rc.server` and the 10 args read from `rc`. Preserve route ORDER exactly (models, embedding-models, usage, sessions GET, resume POST, delete DELETE, config GET/PUT/405, the `ready` computation, health, messages POST, chat POST, 404). The OPTIONS-204 and CORS header set + the `http_request` log stay at the TOP of `_handle` before `dispatch` (they run for every request today):

```ts
  private async _handle(
    req: IncomingMessage,
    res: ServerResponse,
    requestLogger: IRequestLogger,
    smartAgent: SmartAgent,
    chat: SmartAgentHandle['chat'],
    streamChat: SmartAgentHandle['streamChat'],
    log: (e: Record<string, unknown>) => void,
    healthChecker: HealthChecker,
    modelProvider?: IModelProvider,
    adapterMap?: Map<string, ILlmApiAdapter>,
  ): Promise<void> {
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0].replace(/\/$/, '') || '/';
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    log({
      event: 'http_request',
      method: req.method,
      url: rawUrl,
      normalizedPath: urlPath,
    });
    const rc: RouteContext = {
      req, res, rawUrl, urlPath, method: req.method ?? 'GET',
      server: this, requestLogger, smartAgent, chat, streamChat,
      log, healthChecker, modelProvider, adapterMap,
    };
    await this._routeTable.dispatch(rc);
  }
```

Add `private _routeTable = this._buildRouteTable();` (or build it once in `_start` and pass through). `_buildRouteTable()` returns an `HttpRouteTable` with one `route.add({ method, match, handle })` per current branch. Example for the `/v1/models` branch (body copied verbatim from 2930–2961, `modelProvider`→`rc.modelProvider`, `res`→`rc.res`, `rawUrl`→`rc.rawUrl`):

```ts
  private _buildRouteTable(): HttpRouteTable {
    const table = new HttpRouteTable();
    table.add({
      method: 'GET',
      match: (p) => p === '/v1/models' || p === '/models',
      handle: async (rc) => {
        const queryString = rc.rawUrl.includes('?') ? rc.rawUrl.split('?')[1] : '';
        const queryParams = new URLSearchParams(queryString);
        const excludeEmbedding = queryParams.get('exclude_embedding') === 'true';
        let data: Array<Record<string, unknown>> = [
          { id: 'smart-agent', object: 'model', owned_by: 'smart-agent' },
        ];
        if (rc.modelProvider) {
          const result = await rc.modelProvider.getModels({ excludeEmbedding });
          if (result.ok) {
            data = result.value.map((m) => ({
              id: m.id,
              object: 'model',
              owned_by: m.owned_by ?? 'unknown',
              ...(m.displayName ? { display_name: m.displayName } : {}),
              ...(m.provider ? { provider: m.provider } : {}),
              ...(m.capabilities ? { capabilities: m.capabilities } : {}),
              ...(m.contextLength ? { context_length: m.contextLength } : {}),
              ...(m.streamingSupported !== undefined
                ? { streaming_supported: m.streamingSupported }
                : {}),
              ...(m.deprecated !== undefined ? { deprecated: m.deprecated } : {}),
            }));
          }
        }
        rc.res.writeHead(200, { 'Content-Type': 'application/json' });
        rc.res.end(JSON.stringify({ object: 'list', data }));
      },
    });
    // ... one .add({...}) per remaining branch, IN THE SAME ORDER ...
    return table;
  }
```

For the `ready`/health/messages/chat trio, compute `ready` INSIDE each of those route handlers exactly as today (`isReadinessReporter(rc.smartAgent) ? rc.smartAgent.isReady() : true`), since the original computed it once just before health (3137) and reused it for messages+chat. To stay byte-stable, either (a) compute `ready` once at the top of `_handle` after the log and pass it on `rc`, OR (b) compute it identically in each of the three handlers. Option (a) is cleaner — add `ready: boolean` to `RouteContext` and set it in `_handle`. The messages/chat handlers delegate to the kept private methods:

```ts
    table.add({
      method: 'POST',
      match: (p) => p === '/v1/chat/completions' || p === '/chat/completions',
      handle: async (rc) => {
        if (!rc.ready) { writeNotReady(rc.res); return; }
        await rc.server._withSession(rc.req, rc.res, async (graph, sessionId, traceId) => {
          await rc.server._handleChat(
            rc.req, rc.res, rc.requestLogger, graph.agent ?? rc.smartAgent,
            rc.chat, rc.streamChat, rc.log, rc.modelProvider,
            { sessionId, traceId, graph },
          );
        });
      },
    });
```

> `_withSession`, `_handleChat`, `_handleAdapterRequest`, `_handleConfigUpdate`, `_stepperKnowledgeBackend`, `_sessionMetaStore`, `_lifecycle` are referenced through `rc.server`. They are currently `private`. To let the route closures (same module) reach them, they can stay `private` because the closures are defined as methods OF `SmartServer` (`_buildRouteTable` is a SmartServer method, so its closures capture `this`-typed `rc.server` of the same class — TypeScript allows private access within the class). Keep all four handler methods private and unchanged in body.

> Carve the three large handlers into `http/chat-route-handler.ts` etc. ONLY if it stays behavior-preserving and the `this`-coupling can be expressed as `RouteContext` accessors. If that threatens byte-stability under time pressure, leave them as private `SmartServer` methods (the headline Principle-6 win is `_handle`'s chain → declarative table, already achieved). Document the residual in the commit body.

- [ ] **Step 7: Compile + run route-table test + all endpoint tests + full suite**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Run the route-table test + the endpoint suites:
```bash
cd packages/llm-agent-server-libs
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/route-table.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/config-endpoints.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/smart-server-api-adapters.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/readiness-gate.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/usage-per-session.test.ts
node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/sessions-endpoints.test.ts
```
Expected: all PASS — identical status codes + bodies + SSE shapes.
Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/http/ \
        packages/llm-agent-server-libs/src/smart-agent/__tests__/route-table.test.ts \
        packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "refactor: replace SmartServer _handle chain with HttpRouteTable (R1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `ConfigReloadWatcher` + slim composition root (R2)

Rough Δ: −500 / +250. Risk: **medium**. Last — depends on every prior extraction so `_buildInfra` has collaborators to instantiate. `smart-server-config-reload.test.ts` pins the watcher.

> **Design:** Extract the inline file-watch reload block (1685–1790) into a `ConfigReloadWatcher` with `start()/stop()` over `ConfigWatcher`. It already has a clean seam: it reads `update`, applies `smartAgent.applyConfigUpdate`, mirrors onto `this.cfg.agent`/`this.cfg.prompts`, drains the worker cache (now `this._workers.drain()` from Task 4), invalidates the lifecycle, and updates RAG weights. Inject those as a `ConfigReloadDeps` bundle so the watcher owns the wiring; `_buildInfra` shrinks to instantiating + `start()`ing it and pushing `stop` into `closeFns`.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/config-reload-watcher.ts`
- Modify: `smart-server.ts:1685-1790` (replace inline watcher with `new ConfigReloadWatcher(...).start()`)
- Test (existing, run to prove preserved): `smart-server-config-reload.test.ts`.

**Interfaces:**
- Consumes: `ConfigWatcher`, `HotReloadableConfig` (current import in `smart-server.ts` — verify specifier), `SmartAgent` (for `applyConfigUpdate`), the worker drain (`() => Promise<void>`), the lifecycle invalidate (`() => Promise<void>`), the `ragStores` record, the `log` fn, and a `mutateCfg` callback for the `this.cfg.agent`/`this.cfg.prompts` mirroring.
- Produces:
  - `interface IConfigReloadWatcher { start(): void; stop(): void }`
  - `interface ConfigReloadDeps { configFile: string; log: (e: Record<string, unknown>) => void; applyAgentUpdate(update: Record<string, unknown>): void; mirrorCfg(agentPatch: Record<string, unknown>, prompts: { ragTranslate?: string; historySummary?: string }): void; drainWorkers(): Promise<void>; invalidateSessions(): Promise<void>; ragStores: Record<string, unknown>; }`
  - `class ConfigReloadWatcher implements IConfigReloadWatcher`

- [ ] **Step 1: Baseline the existing reload test (must already pass)**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/smart-server-config-reload.test.ts`
Expected: PASS (green baseline — this is the behavior pin for the watcher relocation).

- [ ] **Step 2: Create the watcher module (move the reload callback body)**

Create `packages/llm-agent-server-libs/src/smart-agent/config-reload-watcher.ts`. MOVE the 1687–1784 reload-callback logic into the class, parameterized by `ConfigReloadDeps`. Transcribe verbatim, swapping: `smartAgent.applyConfigUpdate(agentUpdate)`→`this.deps.applyAgentUpdate(agentUpdate)`; the `this.cfg.agent`/`this.cfg.prompts` mirroring (1718–1749)→`this.deps.mirrorCfg(agentPatch, { ragTranslate, historySummary })`; `drainWorkerCache(this._workerLlmCache)`→`this.deps.drainWorkers()`; `this._lifecycle?.invalidateAll()`→`this.deps.invalidateSessions()`; the `ragStores` weight loop (1768–1783)→`this.deps.ragStores`. Header imports (verify specifiers against live file):

```ts
import {
  ConfigWatcher,
  type HotReloadableConfig,
} from '@mcp-abap-adt/llm-agent-libs'; // verify: ConfigWatcher's real import path in smart-server.ts
import type { VectorRag } from '@mcp-abap-adt/llm-agent'; // for updateWeights — verify source
```

Class skeleton (fill each branch with the verbatim moved code):

```ts
export interface IConfigReloadWatcher {
  start(): void;
  stop(): void;
}

export interface ConfigReloadDeps {
  configFile: string;
  log: (e: Record<string, unknown>) => void;
  applyAgentUpdate(update: Record<string, unknown>): void;
  mirrorCfg(
    agentPatch: Record<string, unknown>,
    prompts: { ragTranslate?: string; historySummary?: string },
  ): void;
  drainWorkers(): Promise<void>;
  invalidateSessions(): Promise<void>;
  ragStores: Record<string, unknown>;
}

export class ConfigReloadWatcher implements IConfigReloadWatcher {
  private readonly watcher: ConfigWatcher;
  constructor(private readonly deps: ConfigReloadDeps) {
    this.watcher = new ConfigWatcher(deps.configFile);
  }
  start(): void {
    this.watcher.on('reload', (update: HotReloadableConfig) => this._onReload(update));
    this.watcher.on('error', (err: unknown) => {
      this.deps.log({ event: 'config_reload_error', error: String(err) });
    });
    this.watcher.start();
  }
  stop(): void {
    this.watcher.stop();
  }
  private _onReload(update: HotReloadableConfig): void {
    this.deps.log({ event: 'config_reload', update });
    // ... verbatim 1690–1783 body, deps-routed as described above ...
  }
}
```

> Reproduce the 1690–1750 `agentUpdate`/`agentPatch`/`prompts` assembly EXACTLY (same field whitelist, same deep-merge intent), then call `this.deps.applyAgentUpdate` / `this.deps.mirrorCfg`. Reproduce the `drainWorkers().catch(...)` + `invalidateSessions().catch(...)` fire-and-forget with the SAME log events (`config_reload_drain_error`, `config_reload_invalidate_error`). Reproduce the RAG weight loop with the SAME `(store as VectorRag).updateWeights({...})` guard.

- [ ] **Step 3: Replace the inline watcher in `_buildInfra`**

Replace `smart-server.ts:1685-1790` with:

```ts
    if (this.cfg.configFile) {
      const reloadWatcher = new ConfigReloadWatcher({
        configFile: this.cfg.configFile,
        log,
        applyAgentUpdate: (u) => smartAgent.applyConfigUpdate(u),
        mirrorCfg: (agentPatch, prompts) => {
          if (Object.keys(agentPatch).length > 0) {
            (this.cfg as { agent?: Record<string, unknown> }).agent = {
              ...((this.cfg as { agent?: Record<string, unknown> }).agent ?? {}),
              ...agentPatch,
            };
          }
          if (prompts.ragTranslate !== undefined || prompts.historySummary !== undefined) {
            const merged: Record<string, unknown> = {
              ...((this.cfg as { prompts?: Record<string, unknown> }).prompts ?? {}),
            };
            if (prompts.ragTranslate !== undefined) merged.ragTranslate = prompts.ragTranslate;
            if (prompts.historySummary !== undefined) merged.historySummary = prompts.historySummary;
            (this.cfg as { prompts?: Record<string, unknown> }).prompts = merged;
          }
        },
        drainWorkers: () => this._workers.drain(),
        invalidateSessions: () => this._lifecycle?.invalidateAll() ?? Promise.resolve(),
        ragStores,
      });
      reloadWatcher.start();
      closeFns.push(() => reloadWatcher.stop());
    }
```

Add the import:
```ts
import { ConfigReloadWatcher } from './config-reload-watcher.js';
```

> Verify `ragStores` is in scope at 1685 (it is referenced at 1772 today). Verify `closeFns` is the same array used at 1789. Confirm `this._workers` exists (Task 4) — this slice depends on Task 4 being committed. The `invalidateSessions` `?? Promise.resolve()` preserves today's optional-chaining no-op when `_lifecycle` is unset.

> The `applyConfigUpdate` mirroring split (agentUpdate vs ragTranslatePrompt/historySummaryPrompt routing at 1718–1723) must be preserved: `applyAgentUpdate` receives the FULL `agentUpdate` (including the two `*Prompt` keys) exactly as `smartAgent.applyConfigUpdate(agentUpdate)` does today, while `mirrorCfg` receives only the non-prompt `agentPatch` + the raw prompt strings. Keep the assembly inside `_onReload` identical to 1690–1750.

- [ ] **Step 4: Compile + run the reload test — green**

Run: `npm run build -w @mcp-abap-adt/llm-agent-server-libs`
Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec src/smart-agent/__tests__/smart-server-config-reload.test.ts`
Expected: PASS (behavior preserved — same applied fields, same cfg mirroring, same drain+invalidate, same weight updates).

- [ ] **Step 5: Full suite + final size check**

Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs`
Expected: all pass.
Run: `wc -l packages/llm-agent-server-libs/src/smart-agent/smart-server.ts`
Expected: substantially reduced from 3926 (blueprint target ~1.4k; the residual route-handler bodies + composition root remain above the 500-line goal — that is acknowledged in blueprint §6 as out-of-scope for this pass).

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/config-reload-watcher.ts \
        packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "refactor: extract ConfigReloadWatcher; slim SmartServer composition root (R2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Principle compliance (state at PR close)

1. **Build ON components** — every slice REUSEs catalog components (`SmartAgentBuilder`/`buildAgent`/pipeline factories/`ISessionManager`/`makeLlm`/`KnowledgeBackend` impls); the 4 EXTRACTs + 1 factory land in the LIBRARY, not app-local glue.
2. **The app IS the example** — residual `SmartServer` is a thin composition root consuming the extracted collaborators.
3. **Interfaces** — `IRoleLlmResolver`, `IWorkerRegistry`, `IRoute`/`RouteHandler`, `IConfigReloadWatcher` are the new seams; the server depends on them.
4. **Many small interfaces (ISP)** — each EXTRACT gets its own focused interface; none widens an existing one. R4's `IReadinessReporter` is untouched.
5. **Consumer-owned variation = strategies** — route handlers, role resolver, worker registry, and reload watcher are all injectable.
6. **Control file size** — primary objective; 3926 → ~1.4k residual + 5 small modules.
7. **Don't break components** — additive barrel re-exports keep every public import path stable; routes' method+path+status+shape unchanged; R4/MCP untouched.

---

## Self-Review (run by author; issues fixed inline above)

**1. Spec coverage (all 6 slices + 2 gap-tests):**
- Slice 1 `makeKnowledgeBackend` → Task 1 ✅ (R6 knowledge sub-seam).
- Slice 2 `RoleLlmResolver` → Task 2 ✅; gap-test §4 #2 (RoleLlmResolver role/cache/fallback parity) folded as Task 2 Steps 1–4 ✅.
- Slice 3 `session-lifecycle/` relocation → Task 3 ✅ (named existing tests are the gate).
- Slice 4 `WorkerRegistry` → Task 4 ✅.
- Slice 5 `HttpRouteTable` + handlers → Task 5 ✅; gap-test §4 #1 (route-table characterization: /v1/models, /v1/embedding-models incl. `?exclude_embedding=true`, OPTIONS 204+CORS, unknown-path 404) folded as Task 5 Steps 1–2 ✅.
- Slice 6 `ConfigReloadWatcher` + slim root → Task 6 ✅.
- R4/MCP untouched: stated in Global Constraints + reaffirmed in Tasks 2/4/6 (callMcp/connectMcpClientsFromConfig/buildMcpBridge/`_sharedMcpClients`/`_stepperMcpClients` left in place) ✅.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". The few intentional "verify the specifier against the live file" notes are grounding instructions (line numbers shift by a few), not behavioral placeholders. The route-table test's `minimalConfig`/deps seam is explicitly delegated to "copy `readiness-gate.test.ts`'s `makeTestServer`" rather than invented — the correct, non-placeholder instruction given that fixture already exists.

**3. Type/name consistency across tasks:**
- `RoleLlmResolver` / `IRoleLlmResolver` (Task 2) is referenced nowhere in Task 4 by name — Task 4's `WorkerRegistry` consumes per-worker LLMs through the `WorkerLlmSet` cache + `buildSubAgent` callback, NOT through the role resolver (verified against real code: `buildSubAgent` builds worker LLMs from `subCfg`, and `resolveRoleLlm` is consumed only by `buildServerCtx`/`partsToBaseInput` which stay on the server). The blueprint's "reused by R6 worker build" refers to the server-side ctx wiring that keeps using `this.resolveRoleLlm` — unchanged. No cross-task name mismatch.
- `WorkerLlmSet` shape is identical (relocated verbatim) and re-exported; `WorkerRegistry.cache: Map<string, WorkerLlmSet>` matches the old `_workerLlmCache` type.
- `drainWorkerCache` relocated in Task 4 and consumed by `ConfigReloadWatcher` via `deps.drainWorkers()` → `this._workers.drain()` in Task 6 — consistent.
- `writeNotReady`/`CORS_HEADERS`/`jsonError` relocated in Task 5, consumed by the route table + chat route — consistent.
- `SmartServerLlmConfig` / `NormalizedLlmMap` / `resolveLlmConfig` sourced from `./config.js` in Task 2 — same source as the original `resolveRoleLlm`.

**Stale-vs-real-code notes surfaced inline:** (a) no `public-api.test.ts` exists under `smart-agent/__tests__` — the export contract is pinned by the green full-suite + compile gate; (b) §2's "6 LLM fields written only here + `_buildInfra`" is inaccurate — they are read by `buildServerCtx`/`partsToBaseInput`/`buildSessionAgent` and hot-swapped at 3873–3876, so Task 2 uses live accessors instead of moving the fields.
