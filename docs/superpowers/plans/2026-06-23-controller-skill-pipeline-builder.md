# Controller + Skills Pipeline Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fluent, embeddable builder that produces a partially-configured controller+skills pipeline agent, backed by a new no-listen `buildAgent` capability extracted from `SmartServer` (server = default impl over exported components).

**Architecture:** (1) Add a `BuildAgentDeps` DI seam and thread it through `SmartServer`'s LLM/embedder/skill-host/MCP construction. (2) Extract the build portion of `SmartServer._start()` (everything before `server.listen`) into a `buildAgent()` returning `{ agent, close }`; `_start()` becomes `buildAgent()` + listen. (3) Add `ControllerSkillPipelineBuilder`, a fluent façade that accumulates `.withX()` calls, translates them to a `SmartServerConfig`, and delegates to `buildAgent`.

**Tech Stack:** TypeScript (ESM, strict), `node:test` + `tsx`, Biome. Package: `@mcp-abap-adt/llm-agent-server-libs`.

**Spec:** `docs/superpowers/specs/2026-06-23-controller-skill-pipeline-builder-design.md`

---

## Prerequisites & sequencing (READ FIRST)

This plan has **Tasks 1, 2, 2b, 3, 4, 5** (terminal condition for subagent-driven
execution = Task 5 complete). Tasks 1, 2, 2b are committed/reworked on
`feat/controller-skill-builder` (Task 2b is the post-review correction).

- **Tasks 1, 2, 2b (the `buildAgent` capability) are independent of PR #195** (now merged) — they touch only `SmartServer`. (#195 is already in `main`; this branch is rebased onto it.)
- **Tasks 3–5 (the `ControllerSkillPipelineBuilder`) DEPEND on PR #195** (the `github` skill source: `makeGitHubTransport`, the `github` config variant). The builder bakes a `skillPlugins` source with a `github:` key; without #195 in `main`, config parsing rejects it. **Before executing Tasks 3–5, ensure #195 is merged to `main` and rebase this branch onto it.**
- This branch (`feat/controller-skill-builder`) is based on `main`. If executing all tasks in one pass, merge #195 first, then rebase.

## File Structure

- **Modify** `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — add `BuildAgentDeps`, thread it through construction, extract `buildAgent()`, add an exported free `buildAgent(cfg, deps?)`.
- **Create** `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts` — the fluent builder + its input types.
- **Create** `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts` — unit + integration tests.
- **Modify** `packages/llm-agent-server-libs/src/index.ts` — export the builder + `buildAgent` + `BuildAgentDeps` (the latter two flow via the existing `export * from './smart-agent/smart-server.js'`, so only the builder needs an explicit line).
- **Modify** `packages/llm-agent-server-libs/src/smart-agent/__tests__/` — add a regression test that `SmartServer.start()` still builds+listens with `deps` omitted.

### Conventions

- ESM `.js` import extensions; Biome (2 spaces, single quotes, semicolons; `npm run lint`).
- Tests: `node --import tsx/esm --test --test-reporter=spec <file>`; package suite `npm -w @mcp-abap-adt/llm-agent-server-libs run test`.

---

## Task 1: `BuildAgentDeps` seam threaded through SmartServer

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (constructor `:1028`, `_makeLlm` `:1917`, embedder use `:1251`, skill-host `:1245`, MCP connect via `connectMcpClientsFromConfig`)

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmartServer } from '../smart-server.js';

test('SmartServer accepts BuildAgentDeps and uses the injected makeLlm', async () => {
  let llmCalls = 0;
  const cannedLlm = {
    // minimal ILlm surface used by construction; extend as the build path needs.
    chat: async () => ({ content: '', toolCalls: [] }),
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const server = new SmartServer(
    {
      llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
      // flat pipeline: no MCP, no skills — exercises only the LLM seam.
    } as unknown as import('../smart-server.js').SmartServerConfig,
    { makeLlm: async () => { llmCalls++; return cannedLlm; } },
  );
  assert.ok(server);
  // The seam is exercised during build (Task 2); here we only assert the
  // constructor accepts deps without throwing and stores them.
  assert.equal(typeof (server as unknown as { _deps: unknown })._deps, 'object');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts
```
Expected: FAIL — `SmartServer` constructor takes only one arg; `_deps` undefined.

- [ ] **Step 3: Add `BuildAgentDeps` + accept/default it in the constructor**

Add the interface near the other exported config types in `smart-server.ts` (use the REAL imported types — `EmbedderResolutionConfig`/`EmbedderResolutionOptions` are already importable from `@mcp-abap-adt/llm-agent-rag`; `IMcpClient` from `@mcp-abap-adt/llm-agent`):

```ts
export interface BuildAgentDeps {
  makeLlm?: (cfg: SmartServerLlmConfig) => Promise<ILlm>;
  resolveEmbedder?: (
    cfg: EmbedderResolutionConfig,
    options?: EmbedderResolutionOptions,
  ) => IEmbedder;
  prefetchEmbedderFactories?: typeof prefetchEmbedderFactories;
  buildSkillHost?: (
    cfg: SkillPluginsConfig,
    deps: BuildSkillHostDeps,
  ) => Promise<ISkillPluginHost>;
  skillHost?: ISkillPluginHost;
  /** MCP connection STRATEGY (function). Default: `connectMcpClientsFromConfig`.
   *  A consumer's custom fn does any provisioning logic (e.g. dynamic/per-task). */
  connectMcp?: (
    mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
  ) => Promise<IMcpClient[]>;
  /** Escape hatch: READY `IMcpClient`s (in-process / many / test stubs). When
   *  present, used directly as the infra `mcpClients` — NO connect runs. Parallels
   *  `skillHost`. (NOT `IMcpConnectionStrategy` — that is the separate runtime
   *  reconnect/refresh lifecycle, out of scope here.) */
  mcpClients?: IMcpClient[];
  /** Injected embedder instance — short-circuits BOTH the agent-RAG embedder
   *  (`resolveAgentEmbedder`'s `diEmbedder` param) AND the skill-host embedder
   *  resolution. Simplest stub for I/O-free tests: one deterministic embedder
   *  covers every embedder path. Default: undefined (resolve from config). */
  embedder?: IEmbedder;
}
```

Change the constructor to capture defaulted deps:

```ts
private readonly _deps: Required<Pick<BuildAgentDeps,
  'makeLlm' | 'resolveEmbedder' | 'prefetchEmbedderFactories' | 'buildSkillHost' | 'connectMcp'>>
  & Pick<BuildAgentDeps, 'skillHost' | 'embedder'>;

constructor(config: SmartServerConfig, deps: BuildAgentDeps = {}) {
  this.cfg = config;
  this._deps = {
    makeLlm: deps.makeLlm ?? ((cfg) => this._makeLlmDefault(cfg)),
    resolveEmbedder: deps.resolveEmbedder ?? resolveEmbedder,
    prefetchEmbedderFactories:
      deps.prefetchEmbedderFactories ?? prefetchEmbedderFactories,
    buildSkillHost: deps.buildSkillHost ?? buildSkillHostFromConfig,
    connectMcp: deps.connectMcp ?? connectMcpClientsFromConfig,
    ...(deps.skillHost ? { skillHost: deps.skillHost } : {}),
    ...(deps.embedder ? { embedder: deps.embedder } : {}),
  };
  // ... existing constructor body unchanged
}
```

Rename the existing private `_makeLlm` body to `_makeLlmDefault` (the real `makeLlm` wrapper) and route ALL of `_makeLlm`'s call sites through `this._deps.makeLlm`:

```ts
private _makeLlm(lc: SmartServerLlmConfig): Promise<ILlm> {
  return this._deps.makeLlm(lc);
}
private _makeLlmDefault(lc: SmartServerLlmConfig): Promise<ILlm> {
  return makeLlm(
    { provider: lc.provider ?? 'deepseek', apiKey: lc.apiKey, baseURL: lc.url, model: lc.model },
    Number(lc.temperature ?? this._mainTemp ?? 0.7),
  );
}
```

Route the embedder, skill-host, and MCP construction through `this._deps`:
- **Agent embedder (P1b):** the agent RAG embedder is built via `resolveAgentEmbedder(rag, diEmbedder, extraFactories)` — a **3-arg** function whose **2nd** param IS the DI embedder slot (`resolve-agent-embedder.ts:24`). The current call (`:1216`) passes `this.cfg.embedder` as that 2nd arg. Prefer the injected one: change it to `resolveAgentEmbedder(this.cfg.rag, this._deps.embedder ?? this.cfg.embedder, mergedEmbedderFactories)`. (Do NOT add a 4th argument — the signature has three.) This is the ONLY way an injected embedder reaches the agent-RAG path — without it, a stubbed test still resolves `rag.embedder` (e.g. `sap-ai-core`) for real.
- replace direct `resolveEmbedder(...)` calls (e.g. `:1251` in the skill-host build) with `this._deps.resolveEmbedder(...)`, and when `this._deps.embedder` is set pass it via `options.injectedEmbedder` so the skill-host reuses the same injected instance;
- replace `prefetchEmbedderFactories()` calls with `this._deps.prefetchEmbedderFactories()`.
- **Skill-host embedder + prefetch (P1c — injected embedder must short-circuit ALL embedder I/O):** the current block (`:1230-1262`) computes `reuseAgentEmbedder = skillCfg.embedder === undefined && resolvedEmbedder !== undefined`, and when `!reuseAgentEmbedder` it calls `prefetchEmbedderFactories([skillCfg.embedder?.provider ?? 'ollama'])` (real network) BEFORE building. Because the builder ALWAYS sets `skillPlugins.embedder`, `reuseAgentEmbedder` would be `false` even with an injected embedder → real prefetch. Fix: an injected embedder forces reuse and skips prefetch. Replace the block's embedder logic with:
  ```ts
  const injectedEmbedder = this._deps.embedder;
  const reuseAgentEmbedder =
    injectedEmbedder !== undefined ||
    (skillCfg.embedder === undefined && resolvedEmbedder !== undefined);
  if (!reuseAgentEmbedder) {
    await this._deps.prefetchEmbedderFactories([skillCfg.embedder?.provider ?? 'ollama']);
  }
  // …in the buildHost thunk's resolveEmbedder:
  resolveEmbedder: (ec) =>
    reuseAgentEmbedder
      ? ((injectedEmbedder ?? resolvedEmbedder) as IEmbedder)
      : this._deps.resolveEmbedder(ec, { extraFactories: mergedEmbedderFactories }),
  ```
  So with `deps.embedder` set: NO prefetch, NO `resolveEmbedder` — the injected instance is used directly. (Note `resolvedEmbedder` itself already prefers `deps.embedder` via the agent-embedder fix above, so both paths use the same injected instance.)
- **Skill-host build→load→validate (P2 — preserve the invariant):** keep the existing `initSkillHost(buildHost, skillCfg, pools)` (`:1245`) — it runs `host.load()` + `validateServedGroups()` + the `controllerSkillGroup` eager-probe. Do NOT bypass it. Only swap the `buildHost` thunk and, within the build branch, swap ONLY the `resolveEmbedder` field — **keep every other key of the existing `buildSkillHostFromConfig` deps object unchanged, including BOTH `makePgPool` AND `makePgReadPool`** (the latter is required for the recall-only / qdrant+postgres path; dropping it breaks that config). I.e.:
  ```ts
  const buildHost = this._deps.skillHost
    ? async () => this._deps.skillHost!
    : () => this._deps.buildSkillHost(skillCfg, {
        resolveEmbedder: <the thunk above>,
        makePgPool: <unchanged>,
        makePgReadPool: <unchanged>,   // ← keep — recall-only/postgres path
        // …any other existing deps keys unchanged
      });
  ```
  A prebuilt injected `skillHost` therefore STILL goes through `load()`/validate — a typo'd group or unloaded host fails at startup as today. (Test stubs must implement `load()`, `groups()`, and `rag(group).activeManifest()`.)
- replace any `connectMcpClientsFromConfig(...)` call with `this._deps.connectMcp(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts
npm -w @mcp-abap-adt/llm-agent-server-libs run build
```
Expected: PASS; build clean (all `this._deps.*` calls type-check against the real signatures).

- [ ] **Step 5: Run the full package suite (no regressions)**

Run:
```bash
npm -w @mcp-abap-adt/llm-agent-server-libs run test 2>&1 | tail -8
```
Expected: same pass count as baseline + the 1 new test; 0 fail. If a pre-existing test broke, baseline-diff against `main` (`git stash` + re-run) before attributing — do NOT assume "pre-existing".

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts \
        packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts
git commit -m "feat(server): BuildAgentDeps DI seam threaded through SmartServer construction"
```

---

## Task 2: Extract `buildAgent()` (no-listen) from `_start()`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`_start()` `:1032`+, the `server.listen` boundary `:1677`)

- [ ] **Step 1: Write the failing test**

Append to `build-agent-deps.test.ts`:

```ts
import { buildAgent } from '../smart-server.js';

test('buildAgent builds a runnable agent with NO port bound, and close() disposes', async () => {
  const cannedLlm = {
    chat: async () => ({ content: 'ok', toolCalls: [] }),
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const { agent, close } = await buildAgent(
    {
      llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
    } as unknown as import('../smart-server.js').SmartServerConfig,
    { makeLlm: async () => cannedLlm },
  );
  assert.equal(typeof agent.process, 'function');
  await close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts
```
Expected: FAIL — `buildAgent` is not exported.

- [ ] **Step 3: Extract the build portion + add the public entry**

In `_start()`, everything from the start of the method up to (but NOT including) the `return new Promise((resolve, reject) => { ... server.listen ... })` block (`:1677`) is the BUILD portion. It already produces `smartAgent` (`:1428`) and accumulates `closeFns`. Refactor:

1. Add a private method that returns the built artifacts without listening:

```ts
private async _buildAgent(): Promise<{ agent: ISmartAgent; close: () => Promise<void> }> {
  // <-- MOVE the body of _start() here, from its top through the point just
  //     BEFORE `return new Promise(... server.listen ...)`. It already binds
  //     `smartAgent` and `closeFns`. End with:
  return {
    agent: smartAgent,
    close: async () => {
      for (const fn of closeFns) await fn();
    },
  };
}
```

2. `_start()` becomes: call `_buildAgent()`, then create the HTTP server and listen, composing the close:

```ts
private async _start(): Promise<SmartServerHandle> {
  const built = await this._buildAgent();
  // ... existing HTTP server creation (the `http.createServer(...)` block that
  //     references `chat`/`streamChat`/`requestLogger`) stays here. Those locals
  //     must be returned from _buildAgent too if still needed by the server —
  //     widen the _buildAgent return to include `{ chat, streamChat, requestLogger }`
  //     (they are produced in the moved block). Keep them internal (not in the
  //     public buildAgent return).
  return new Promise((resolve, reject) => {
    const port = this.cfg.port ?? 4004;
    const host = this.cfg.host ?? '0.0.0.0';
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      log({ event: 'server_started', port: actualPort, host });
      resolve({
        port: actualPort,
        close: async () => {
          await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
          await built.close();   // <-- compose: server shutdown THEN agent dispose
        },
        requestLogger,
      });
    });
  });
}
```

> Implementation note: `_buildAgent` returns the PUBLIC `{ agent, close }` plus the
> server-only locals (`chat`, `streamChat`, `requestLogger`) the HTTP handler needs.
> Define an internal return type `{ agent, close, chat, streamChat, requestLogger }`;
> the public `buildAgent` (below) returns only `{ agent, close }`. The pg-pool
> cleanup `finally` in `start()` is unchanged (it still wraps `_start()`).

3. Add the exported free function:

```ts
/** Build a runnable agent for any configured pipeline WITHOUT binding a port.
 *  `SmartServer.start()` is the default impl that adds HTTP `listen` on top. */
export async function buildAgent(
  cfg: SmartServerConfig,
  deps?: BuildAgentDeps,
): Promise<{ agent: ISmartAgent; close: () => Promise<void> }> {
  const server = new SmartServer(cfg, deps);
  const built = await (server as unknown as {
    _buildAgent(): Promise<{ agent: ISmartAgent; close: () => Promise<void> }>;
  })._buildAgent();
  return { agent: built.agent, close: built.close };
}
```

> Add an `import type { ISmartAgent } from '@mcp-abap-adt/llm-agent';` to
> `smart-server.ts` if not already present (the concrete `smartAgent` produced by
> `builder.build()` satisfies this public interface; we annotate the public
> `buildAgent`/`_buildAgent` returns with the interface, not the concrete class).

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts
npm -w @mcp-abap-adt/llm-agent-server-libs run build
```
Expected: PASS (both tests); build clean.

- [ ] **Step 5: Regression — `start()` still listens**

Find the existing server start/listen test (search `server.test.ts` / `__tests__` for `.start()` + a port assertion) and run the suite:
```bash
npm -w @mcp-abap-adt/llm-agent-server-libs run test 2>&1 | tail -8
```
Expected: existing `start()`/listen tests still pass (behaviour-preserving). 0 fail vs baseline.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts \
        packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts
git commit -m "feat(server): extract no-listen buildAgent() from start(); start = buildAgent + listen"
```

---

## Task 2b: Correct `buildAgent()` to return the PIPELINE-instance agent (review P1a) + MCP seam (P1b)

> **Why:** Task 2 (as first implemented) returned `smartAgent` — the INFRA/passthrough
> startup agent that has NO coordinator. The HTTP path never dispatches to it; it
> dispatches to the per-session `graph.agent` = `buildPipelineInstance(...).agent`.
> So `buildAgent` must build a pipeline instance and return ITS agent, else the
> embeddable agent does NOT run the controller pipeline. Also: MCP must come through
> the injected seam (`deps.mcpClients` / `deps.connectMcp`) so the embeddable path
> never forces a real connect from `cfg.mcp`.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`_buildAgent`, the MCP-resolution point, and the `BuildAgentDeps` defaulting)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts`

- [ ] **Step 1: Write the failing tests (replace the weak `typeof` test)**

Replace the Task-2 `buildAgent ... typeof agent.process` test with TWO honest tests.
First READ `buildSessionAgent` (`~:2633`) + `buildPipelineInstance` (`~:2239`) to see
how a session obtains `IPipelineInstance.agent`, and what `SessionAgentParts` the
instance needs.

```ts
import { buildAgent } from '../smart-server.js';

// (a) P1a — the COORDINATED controller agent runs, not the infra passthrough.
test('buildAgent returns the controller pipeline agent (coordinator is exercised)', async () => {
  let plannerSawPlanPrompt = false;
  const cannedLlm = {
    // Controller planner/executor go through chat(); record that the coordinator
    // actually invoked an LLM with a plan-shaped prompt.
    chat: async (msgs: unknown) => {
      const text = JSON.stringify(msgs);
      if (/plan|step|goal/i.test(text)) plannerSawPlanPrompt = true;
      return { ok: true, value: { content: '{"plan":[]}', toolCalls: [] } };
    },
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const stubEmbedder = { embed: async () => ({ vector: [0, 0, 0] }) }
    as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder;
  const { agent, close } = await buildAgent(
    {
      skipModelValidation: true,
      llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
      pipeline: { name: 'controller', config: { subagents: {
        evaluator: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' },
        planner:   { provider: 'openai', apiKey: 'x', model: 'gpt-4o' },
        executor:  { provider: 'openai', apiKey: 'x', model: 'gpt-4o' },
      } } },
    } as unknown as import('../smart-server.js').SmartServerConfig,
    { makeLlm: async () => cannedLlm, embedder: stubEmbedder },
  );
  assert.equal(typeof agent.process, 'function');
  await agent.process('do a task');
  assert.equal(plannerSawPlanPrompt, true, 'controller coordinator must invoke the planner LLM');
  await close();
});

// (b) P1b — with mcp in config AND a throwing connectMcp, build still succeeds:
//     proves the embeddable path performs NO real MCP connect.
test('buildAgent does NOT connect MCP when connectMcp is stubbed (no real connect)', async () => {
  const cannedLlm = {
    chat: async () => ({ ok: true, value: { content: 'ok', toolCalls: [] } }),
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const stubEmbedder = { embed: async () => ({ vector: [0] }) }
    as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder;
  const { agent, close } = await buildAgent(
    {
      skipModelValidation: true,
      llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
      mcp: { type: 'http', url: 'http://127.0.0.1:9/should-not-connect/mcp/stream/http' },
    } as unknown as import('../smart-server.js').SmartServerConfig,
    {
      makeLlm: async () => cannedLlm,
      embedder: stubEmbedder,
      connectMcp: async () => { throw new Error('connectMcp must not run when clients are injectable'); },
      mcpClients: [], // ready clients injected → connect never attempted
    },
  );
  assert.equal(typeof agent.process, 'function');
  await close();
});
```

- [ ] **Step 2: Run, verify the COORDINATOR test FAILS** (current `_buildAgent` returns the
infra `smartAgent`, whose `process` does not invoke the controller planner):
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts
```
Expected: the coordinator test FAILS (`plannerSawPlanPrompt` stays false); the MCP test may already pass.

- [ ] **Step 3: Make `buildAgent` build the pipeline instance + honour the MCP seam**

(a) **Pipeline instance.** Change `_buildAgent` so that, after assembling the infra
(its current body up to `smartAgent`/`closeFns`), it builds ONE pipeline instance via
the SAME path a session uses and returns ITS agent:

```ts
// after the infra is assembled (smartAgent/closeFns/etc. as today):
const parts = this._embeddedSessionParts({   // assemble SessionAgentParts from globals
  // mirror exactly what the session lifecycle passes to buildSessionAgent:
  // sessionId, mcpClients (globalMcpClients), toolsRag (this._toolsRag),
  // ragRegistry, fileLogger, plugins, workerRegistry, applyServerExtras:true, …
});
const inst = await this.buildPipelineInstance({ sessionId: 'embedded', parts });
return {
  agent: inst.agent,                          // the COORDINATED pipeline agent
  close: async () => {
    await inst.close();                        // dispose the pipeline instance first
    for (const fn of closeFns) await fn();     // then the infra
  },
  // server-only locals (chat/streamChat/requestLogger/…) still returned for _start()
};
```
Read `buildSessionAgent` (`~:2633`) to copy the EXACT `SessionAgentParts` shape it
builds (the same globals it reads); factor that assembly into a private
`_embeddedSessionParts(...)` (or inline it) so `_start()`'s per-session path and
`buildAgent`'s single embedded instance produce identical parts. `_start()` keeps
using its existing per-session `graph.agent` path (unchanged) — only `buildAgent`
adds the single embedded `buildPipelineInstance` call.

(b) **MCP seam.** At the infra MCP-resolution point, prefer injected clients and never
self-connect when they're supplied:
```ts
const mcpClients =
  this._deps.mcpClients ??
  (await this._deps.connectMcp(this.cfg.mcp));
```
and ensure these `mcpClients` are the ones threaded into `buildSharedPipelineInfra` /
the pipeline ctx / `SessionAgentParts` (the DI path), so the SmartAgentBuilder does
NOT self-connect from `cfg.mcp`. (Default `connectMcp` = `connectMcpClientsFromConfig`,
so production behaviour with no injected clients is unchanged.) Add
`mcpClients: deps.mcpClients` to the constructor's `_deps` capture (alongside the
existing fields).

- [ ] **Step 4: Run tests + build, verify PASS:**
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts
npm -w @mcp-abap-adt/llm-agent-server-libs run build
```
Both new tests pass; the coordinator test proves the planner LLM was invoked.

- [ ] **Step 5: Full suite (no regressions, `start()` still serves coordinated):**
```bash
npm -w @mcp-abap-adt/llm-agent-server-libs run test 2>&1 | tail -8
```
0 fail vs baseline; the existing `start()`/serving tests still pass (the per-session
path is unchanged; only `buildAgent` adds the embedded instance).

- [ ] **Step 6: Commit**
```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts \
        packages/llm-agent-server-libs/src/smart-agent/__tests__/build-agent-deps.test.ts
git commit -m "fix(server): buildAgent returns the pipeline-instance agent (P1a) + MCP via injected seam (P1b)"
```

---

## Task 3: `ControllerSkillPipelineBuilder` — fluent accumulation + config translation

> **Prerequisite:** PR #195 (github skill source) merged to `main`; this branch rebased onto it (the generated config uses a `github:` skill source).

**Files:**
- Create: `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts`
- Test: `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts`

- [ ] **Step 1: Write the failing test (config translation only)**

Create `controller-skill-pipeline-builder.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControllerSkillPipelineBuilder } from './controller-skill-pipeline-builder.js';

test('fluent calls translate to the expected SmartServerConfig', () => {
  const cfg = new ControllerSkillPipelineBuilder()
    .withLlm({ provider: 'sap-ai-sdk', model: 'anthropic--claude-4.6-sonnet' })
    .withRoleLlm('planner', { provider: 'openai', apiKey: 'k', model: 'gpt-4o' })
    .withMcp({ url: 'http://localhost:3001/mcp/stream/http' })
    .withSkillSource({
      github: 'https://github.com/secondsky/sap-skills.git',
      enabled: ['sap-abap', 'sap-btp-developer-guide'],
      collection: 'sap',
    })
    .withEmbedder({ provider: 'sap-ai-core', model: 'text-embedding-3-small' })
    .withBudgets({ maxToolCalls: 30 })
    .toConfig(); // test seam: expose the assembled SmartServerConfig

  assert.equal(cfg.pipeline?.name, 'controller');
  const sub = (cfg.pipeline?.config as any).subagents;
  assert.equal(sub.evaluator.provider, 'sap-ai-sdk');
  assert.equal(sub.executor.provider, 'sap-ai-sdk');
  assert.equal(sub.planner.provider, 'openai');           // per-role override
  assert.equal(sub.planner.apiKey, 'k');
  assert.equal((cfg.pipeline?.config as any).budgets.maxToolCalls, 30);
  assert.deepEqual(cfg.mcp, [{ type: 'http', url: 'http://localhost:3001/mcp/stream/http' }]);
  assert.equal((cfg as any).skillPlugins.controllerSkillGroup, 'sap');
  assert.equal((cfg as any).skillPlugins.sources[0].github,
    'https://github.com/secondsky/sap-skills.git');
  assert.equal((cfg as any).skillPlugins.sources[0].strategyConfig.collection, 'sap');
  assert.equal((cfg as any).rag.embedder, 'sap-ai-core');
});

test('withPlanner(weak-executor) selects the controller-weak pipeline', () => {
  const cfg = new ControllerSkillPipelineBuilder()
    .withLlm({ provider: 'sap-ai-sdk' })
    .withSkillSource({ github: 'a/b', enabled: ['x'] })
    .withEmbedder({ provider: 'sap-ai-core' })
    .withPlanner('weak-executor')
    .toConfig();
  assert.equal(cfg.pipeline?.name, 'controller-weak');
});

test('build() throws when no LLM was set', () => {
  assert.throws(
    () => new ControllerSkillPipelineBuilder()
      .withSkillSource({ github: 'a/b', enabled: ['x'] })
      .withEmbedder({ provider: 'sap-ai-core' })
      .toConfig(),
    /withLlm/,
  );
});

test('build() throws when no skill source was set', () => {
  assert.throws(
    () => new ControllerSkillPipelineBuilder()
      .withLlm({ provider: 'sap-ai-sdk' })
      .withEmbedder({ provider: 'sap-ai-core' })
      .toConfig(),
    /withSkillSource/,
  );
});

test('build() throws when no embedder was set (skills need one)', () => {
  assert.throws(
    () => new ControllerSkillPipelineBuilder()
      .withLlm({ provider: 'sap-ai-sdk' })
      .withSkillSource({ github: 'a/b', enabled: ['x'] })
      .toConfig(),
    /withEmbedder/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the builder (accumulation + `toConfig`)**

Create `controller-skill-pipeline-builder.ts`:

```ts
import type { SmartServerConfig, SmartServerLlmConfig, SmartServerMcpConfig } from '../smart-agent/smart-server.js';
import type { PlannerKind } from '../smart-agent/controller/types.js';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';

export interface BuilderLlmInput {
  provider: 'sap-ai-sdk' | 'openai' | 'anthropic' | 'deepseek' | 'ollama';
  model?: string;
  apiKey?: string;
  url?: string;
  temperature?: number;
  maxTokens?: number;
}
export interface BuilderSkillSourceInput {
  github: string;
  enabled: readonly string[];
  collection?: string;
  ref?: string;
  token?: string;
}
export interface BuilderEmbedderInput {
  provider: string;
  model?: string;
  scenario?: string;
  resourceGroup?: string;
}
type Role = 'evaluator' | 'planner' | 'executor';

const KEYLESS = new Set(['sap-ai-sdk', 'ollama']);
const ENV_KEY: Record<string, string> = {
  openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
};

/** Translate a BuilderLlmInput to a SmartServerLlmConfig, resolving apiKey per
 *  provider (keyless → '' placeholder; keyed → arg or conventional env var). */
function toLlmConfig(input: BuilderLlmInput): SmartServerLlmConfig {
  let apiKey = input.apiKey ?? '';
  if (!KEYLESS.has(input.provider) && apiKey === '') {
    apiKey = process.env[ENV_KEY[input.provider] ?? ''] ?? '';
    if (apiKey === '') {
      throw new Error(
        `ControllerSkillPipelineBuilder: provider '${input.provider}' needs an apiKey — ` +
        `pass it to .withLlm()/.withRoleLlm() or set ${ENV_KEY[input.provider]}`,
      );
    }
  }
  return {
    provider: input.provider,
    apiKey,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  } as SmartServerLlmConfig;
}

export class ControllerSkillPipelineBuilder {
  private _llm?: BuilderLlmInput;
  private _roleLlm: Partial<Record<Role, BuilderLlmInput>> = {};
  private _mcp: SmartServerMcpConfig[] = [];
  private _mcpClients?: IMcpClient[];
  private _skill?: BuilderSkillSourceInput;
  private _embedder?: BuilderEmbedderInput;
  private _budgets: Record<string, unknown> = {};
  private _targetState: Record<string, unknown> = {};
  private _plannerKind: PlannerKind = 'smart-executor';

  withLlm(cfg: BuilderLlmInput): this { this._llm = cfg; return this; }
  withRoleLlm(role: Role, cfg: BuilderLlmInput): this { this._roleLlm[role] = cfg; return this; }
  withMcp(cfg: { url: string; headers?: Record<string, string> }): this {
    this._mcp.push({ type: 'http', url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) } as SmartServerMcpConfig);
    return this;
  }
  /** Inject READY in-process / external / stub MCP clients (provisioning).
   *  Forwarded as `BuildAgentDeps.mcpClients` → no connect runs. For custom/dynamic
   *  provisioning, pass a `connectMcp` fn to `.build(deps)` instead. (NOT
   *  `IMcpConnectionStrategy` — that is the separate runtime reconnect lifecycle.) */
  withMcpClients(clients: IMcpClient[]): this { this._mcpClients = clients; return this; }
  withSkillSource(cfg: BuilderSkillSourceInput): this { this._skill = cfg; return this; }
  withEmbedder(cfg: BuilderEmbedderInput): this { this._embedder = cfg; return this; }
  withBudgets(b: Record<string, unknown>): this { this._budgets = { ...this._budgets, ...b }; return this; }
  withTargetState(t: Record<string, unknown>): this { this._targetState = { ...this._targetState, ...t }; return this; }
  withPlanner(kind: PlannerKind): this { this._plannerKind = kind; return this; }

  /** Assemble the RAW (yaml-shaped, PRE-normalization) config, fail-loud on
   *  missing required pieces. `.build()` runs this through
   *  `resolveSmartServerConfig` to fill all defaults before building. */
  toConfig(): SmartServerConfig {
    if (!this._llm && Object.keys(this._roleLlm).length === 0) {
      throw new Error('ControllerSkillPipelineBuilder: call .withLlm() (or .withRoleLlm() for all roles) before building');
    }
    if (!this._skill) {
      throw new Error('ControllerSkillPipelineBuilder: call .withSkillSource() before building');
    }
    if (!this._embedder) {
      throw new Error('ControllerSkillPipelineBuilder: call .withEmbedder() before building (skills need an embedder)');
    }
    const base = this._llm ? toLlmConfig(this._llm) : undefined;
    const roleCfg = (r: Role): SmartServerLlmConfig => {
      const ovr = this._roleLlm[r];
      if (ovr) return toLlmConfig(ovr);
      if (base) return base;
      throw new Error(`ControllerSkillPipelineBuilder: no LLM for role '${r}' (set .withLlm() or .withRoleLlm('${r}', …))`);
    };
    const collection = this._skill.collection ?? 'sap';
    return {
      llm: { main: base ?? roleCfg('executor') },
      pipeline: {
        name: this._plannerKind === 'weak-executor' ? 'controller-weak' : 'controller',
        config: {
          subagents: { evaluator: roleCfg('evaluator'), planner: roleCfg('planner'), executor: roleCfg('executor') },
          ...(Object.keys(this._targetState).length ? { targetState: this._targetState } : {}),
          ...(Object.keys(this._budgets).length ? { budgets: this._budgets } : {}),
        },
      },
      rag: {
        type: 'in-memory',
        embedder: this._embedder.provider,
        ...(this._embedder.model ? { model: this._embedder.model } : {}),
        ...(this._embedder.scenario ? { scenario: this._embedder.scenario } : {}),
        ...(this._embedder.resourceGroup ? { resourceGroup: this._embedder.resourceGroup } : {}),
      },
      ...(this._mcp.length ? { mcp: this._mcp } : {}),
      skillPlugins: {
        store: { type: 'in-memory' },
        embedder: { provider: this._embedder.provider, ...(this._embedder.model ? { model: this._embedder.model } : {}) },
        controllerSkillGroup: collection,
        sources: [{
          id: 'skills',
          github: this._skill.github,
          enabled: this._skill.enabled,
          ...(this._skill.ref ? { ref: this._skill.ref } : {}),
          ...(this._skill.token ? { token: this._skill.token } : {}),
          strategy: 'single-collection',
          strategyConfig: { collection },
        }],
      },
    } as unknown as SmartServerConfig;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts
npm -w @mcp-abap-adt/llm-agent-server-libs run build
```
Expected: PASS (5 tests); build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts \
        packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts
git commit -m "feat(builders): ControllerSkillPipelineBuilder fluent accumulation + config translation"
```

---

## Task 4: `build(deps?)` — delegate to `buildAgent`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts`
- Test: `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts`

- [ ] **Step 1: Write the failing integration test (deps-stubbed, no I/O)**

Append:

Two tests: (a) the agent builds with everything stubbed — and crucially via
`buildSkillHost` (NOT a direct `skillHost`), so we ALSO assert the skill config
reached it **normalized** (P1a); (b) an injected `embedder` covers the agent-RAG
path (P1b) AND, because `deps.embedder` is set, the skill-host prefetch is skipped
entirely (P1c) — no embedder factory is ever fetched, so the test is truly
I/O-free without needing a `prefetchEmbedderFactories` stub. The stub host
implements `load()`/`groups()`/`rag().activeManifest()` because `.build()` routes
it through `initSkillHost` (load+validate, P2).

```ts
import type { BuildAgentDeps } from '../smart-agent/smart-server.js';
import type { SkillPluginsConfig } from '../smart-agent/skill-plugins-config.js';

function stubHost() {
  return {
    rag: () => ({ query: async () => [], activeManifest: async () => ({}) }),
    groups: () => [{ group: 'sap' }],
    load: async () => {},
  } as unknown as import('@mcp-abap-adt/llm-agent').ISkillPluginHost;
}

test('build(deps): normalized skill config reaches buildSkillHost (P1a), injected embedder covers all paths (P1b), no I/O', async () => {
  const cannedLlm = { chat: async () => ({ content: 'review', toolCalls: [] }), model: 'stub' }
    as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const stubEmbedder = { embed: async () => ({ vector: [0, 0, 0] }) }
    as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder;
  let skillCfgSeen: SkillPluginsConfig | undefined;
  const deps: BuildAgentDeps = {
    makeLlm: async () => cannedLlm,
    embedder: stubEmbedder,                       // P1b: covers agent-RAG + skill-host
    buildSkillHost: async (cfg) => { skillCfgSeen = cfg; return stubHost(); }, // P1a: capture
    connectMcp: async () => [],
    // P1c: with deps.embedder set, prefetch MUST be skipped — throw if it runs so
    // the assertion is honest (test fails loudly instead of silently doing I/O).
    prefetchEmbedderFactories: async () => {
      throw new Error('prefetch must not run when deps.embedder is injected');
    },
  };
  const { agent, close } = await new ControllerSkillPipelineBuilder()
    .withLlm({ provider: 'sap-ai-sdk', model: 'anthropic--claude-4.6-sonnet' })
    .withSkillSource({ github: 'secondsky/sap-skills', enabled: ['sap-abap'], collection: 'sap' })
    .withEmbedder({ provider: 'sap-ai-core', model: 'text-embedding-3-small' })
    .build(deps);
  assert.equal(typeof agent.process, 'function');
  // P1a — normalization happened: defaults filled by resolveSmartServerConfig.
  assert.ok(skillCfgSeen, 'buildSkillHost was called');
  assert.equal(skillCfgSeen!.store.type, 'in-memory');
  assert.ok(skillCfgSeen!.catalog, 'catalog default present');     // normalized
  assert.notEqual(skillCfgSeen!.chunk, undefined);                 // chunk default present
  await close();
});

test('build(deps) with a prebuilt skillHost still routes through load/validate (P2)', async () => {
  const cannedLlm = { chat: async () => ({ content: '', toolCalls: [] }), model: 'stub' }
    as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  let loaded = false;
  const host = { ...stubHost(), load: async () => { loaded = true; } }
    as unknown as import('@mcp-abap-adt/llm-agent').ISkillPluginHost;
  const { close } = await new ControllerSkillPipelineBuilder()
    .withLlm({ provider: 'sap-ai-sdk' })
    .withSkillSource({ github: 'a/b', enabled: ['sap-abap'], collection: 'sap' })
    .withEmbedder({ provider: 'sap-ai-core' })
    .build({ makeLlm: async () => cannedLlm, embedder: { embed: async () => ({ vector: [0] }) } as any,
             skillHost: host, connectMcp: async () => [] });
  assert.equal(loaded, true, 'prebuilt host still went through initSkillHost.load()');
  await close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts
```
Expected: FAIL — `.build` is not a function.

- [ ] **Step 3: Add `build(deps?)`**

Add to the class (import `buildAgent` + the config resolver at the top). **`.build()`
MUST normalize the raw assembled config through `resolveSmartServerConfig` before
handing it to `buildAgent`** — `buildAgent`/`SmartServer` expect an already-normalized
`SmartServerConfig` (the `_start()` path reads `skillCfg.catalog.type` directly;
`store`/`catalog`/`k`/`threshold`/`loadOnStartup`/`chunk` defaults are added ONLY by
`resolveSmartServerConfig` → `parseSkillPluginsConfig`). `toConfig()` returns the RAW
(yaml-shaped, pre-normalization) object; normalization happens here:

```ts
import { buildAgent } from '../smart-agent/smart-server.js';
import { resolveSmartServerConfig } from '../smart-agent/config.js';
// ...
  /** Assemble + build a runnable agent (no port bound). `deps` forwards a
   *  BuildAgentDeps for embedding/testing; omit it for the real implementations. */
  async build(deps?: BuildAgentDeps): Promise<{ agent: ISmartAgent; close: () => Promise<void> }> {
    // toConfig() is the RAW yaml-shaped config; resolveSmartServerConfig fills
    // ALL defaults (incl. skillPlugins catalog/chunk/loadOnStartup) so the
    // SmartServer build path receives a fully-normalized config.
    const normalized = resolveSmartServerConfig({}, this.toConfig() as YamlConfig, process.env);
    // resolveSmartServerConfig returns Omit<SmartServerConfig,'log'>; buildAgent
    // does not listen/log to a file, so a no-op/absent log is fine.
    // Forward injected MCP clients (.withMcpClients) into BuildAgentDeps so the
    // embeddable path uses them directly (no real connect). A caller-supplied
    // deps.mcpClients/connectMcp (via the deps arg) takes precedence.
    const mergedDeps: BuildAgentDeps | undefined =
      this._mcpClients || deps
        ? { ...(this._mcpClients ? { mcpClients: this._mcpClients } : {}), ...deps }
        : undefined;
    return buildAgent(normalized as SmartServerConfig, mergedDeps);
  }
```

Add imports: `buildAgent`, `BuildAgentDeps`, `SmartServerConfig` from
`../smart-agent/smart-server.js`; `resolveSmartServerConfig`, `YamlConfig` from
`../smart-agent/config.js`; `ISmartAgent` from `@mcp-abap-adt/llm-agent` (the public contract; the concrete `SmartAgent` class lives in `llm-agent-libs`). If
`SmartServerConfig` requires a `log`, supply a no-op (`{ ...normalized, log: () => {} }`).

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts
npm -w @mcp-abap-adt/llm-agent-server-libs run build
```
Expected: PASS (6 tests); build clean.

> If the stub surfaces in Step 1 are insufficient for the controller build path
> (e.g. the handler needs more `ISkillPluginHost`/`ILlm` methods), extend the
> stubs minimally to satisfy the real call path — do NOT widen the production
> types. Report any stub gap as a DONE_WITH_CONCERNS note.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts \
        packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts
git commit -m "feat(builders): ControllerSkillPipelineBuilder.build(deps?) delegates to buildAgent"
```

---

## Task 5: Export + docs

**Files:**
- Modify: `packages/llm-agent-server-libs/src/index.ts`
- Modify: `docs/INTEGRATION.md` (add a builder snippet)

- [ ] **Step 1: Export the builder**

Add to `packages/llm-agent-server-libs/src/index.ts`:

```ts
export {
  ControllerSkillPipelineBuilder,
  type BuilderLlmInput,
  type BuilderSkillSourceInput,
  type BuilderEmbedderInput,
} from './builders/controller-skill-pipeline-builder.js';
```

(`buildAgent` + `BuildAgentDeps` already flow via `export * from './smart-agent/smart-server.js'` — verify with the reachability check below.)

- [ ] **Step 2: Verify exports reachable + add an INTEGRATION snippet**

Run:
```bash
npm -w @mcp-abap-adt/llm-agent-server-libs run build
node --import tsx/esm -e "import('@mcp-abap-adt/llm-agent-server-libs').then(m => { for (const n of ['ControllerSkillPipelineBuilder','buildAgent']) if (typeof m[n] !== 'function') throw new Error('missing '+n); console.log('exports OK'); })"
```
Expected: prints `exports OK`.

Add to `docs/INTEGRATION.md` a short "Embeddable controller+skills pipeline" section showing the fluent builder usage from the spec example (the `agent.process(...)` form).

- [ ] **Step 3: Full gate + commit**

```bash
npm test && npm run lint:check && npm run build
git add packages/llm-agent-server-libs/src/index.ts docs/INTEGRATION.md
git commit -m "feat(builders): export ControllerSkillPipelineBuilder + INTEGRATION snippet"
```
Expected: all green; commit succeeds.

---

## Self-Review

**1. Spec coverage:**
- Guiding principle (export components; server = default impl) → Task 2 (`buildAgent` exported, `start` = `buildAgent` + listen). ✓
- `BuildAgentDeps` (real types) → Task 1. ✓
- No-listen build → Task 2. ✓
- Fluent surface (`withLlm`/`withRoleLlm`/`withMcp`/`withSkillSource`/`withEmbedder`/`withBudgets`/`withTargetState`/`withPlanner`) → Task 3. ✓
- Baked controller + skill-host + defaults; `withPlanner` → controller/controller-weak → Task 3. ✓
- Optional apiKey + per-provider env semantics (`BuilderLlmInput`) → Task 3 `toLlmConfig`. ✓
- `build(deps?)` → `buildAgent`, returns `{ agent, close }`; `agent.process(...)` → Task 4. ✓
- Fail-loud guards (no LLM / no skill source / no embedder) → Task 3 tests. ✓
- Unit (config translation) + integration (deps-stubbed, no I/O) + regression (`start()` still listens) → Tasks 1,2,3,4. ✓
- Exports → Task 5. ✓
- **Config normalization (review P1a):** `.build()` runs the raw config through `resolveSmartServerConfig` so skill-host defaults (catalog/chunk/loadOnStartup) are filled before the build path reads `skillCfg.catalog.type` → Task 4 Step 3 + the P1a assertion test. ✓
- **Embedder seam covers ALL paths (review P1b):** `BuildAgentDeps.embedder` threaded as `resolveAgentEmbedder`'s `diEmbedder` (agent-RAG) AND skill-host `injectedEmbedder` → Task 1 Step 3 + the integration test injects `embedder`. ✓
- **Startup invariant preserved (earlier plan-review P2):** even a prebuilt `skillHost` goes through `initSkillHost` (load + validate + group probe) — only the `buildHost` thunk is swapped → Task 1 Step 3 + the P2 test asserts `load()` ran. ✓
- **#196 code-review P1a — buildAgent returns the COORDINATED pipeline agent:** `_buildAgent` builds a pipeline instance via `buildPipelineInstance({sessionId:'embedded', parts})` and returns `inst.agent`, not the infra `smartAgent` → Task 2b Step 3 + the coordinator test (planner LLM invoked). ✓
- **#196 code-review P1b — MCP via injected seam (no forced connect):** `BuildAgentDeps.mcpClients` (ready) / `connectMcp` (fn) resolved before the builder self-connects; `.withMcpClients` forwards into deps → Task 1 (`mcpClients` field), Task 2b Step 3 (resolution), Task 3 (`withMcpClients`), Task 4 (forward) + the no-connect test (throwing `connectMcp` + injected clients). ✓
- **MCP seam not conflated with `IMcpConnectionStrategy`:** provisioning = `withMcpClients`/`withMcp`/`connectMcp`; the runtime reconnect strategy is out of the builder's surface → Task 3 `withMcpClients` doc. ✓
- **Injected embedder short-circuits ALL embedder I/O incl. skill-host prefetch (review P1c):** an injected `deps.embedder` forces `reuseAgentEmbedder` and skips `prefetchEmbedderFactories` → Task 1 Step 3 embedder/prefetch block; the integration test injects `embedder` and asserts no factory fetch. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows code; commands have expected output. The one non-code instruction (the `_start()` body MOVE in Task 2 Step 3) is a bounded extract with explicit boundary lines + the new method signatures + the close composition shown. ✓

**3. Type consistency:** `BuildAgentDeps`, `buildAgent`, `ControllerSkillPipelineBuilder`, `BuilderLlmInput`/`BuilderSkillSourceInput`/`BuilderEmbedderInput`, `toLlmConfig`, `toConfig`, `build(deps?)`, and the `Role` type are used identically across Tasks 1–5. `withPlanner`→pipeline-name mapping (`controller`/`controller-weak`) matches the spec and the registered presets. ✓

**4. Sequencing:** Tasks 1–2 are #195-independent; Tasks 3–5 require #195 merged (noted in Prerequisites + Task 3 header). ✓
