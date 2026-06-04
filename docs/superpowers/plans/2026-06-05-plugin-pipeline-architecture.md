# Plugin-Pipeline Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace YAML-mode-driven coordinator selection with a plugin model where each agent variant is an `IPipelinePlugin` the server resolves by name, builds once into an `IPipelineInstance`, and streams per request.

**Architecture:** Core contracts in `@mcp-abap-adt/llm-agent`; the existing plugin loader carries pipeline plugins through `LoadedPlugins`; built-in pipelines in `llm-agent-server-libs` wrap the existing `IPipelineFactory` factories; the binary `llm-agent-server` hosts the registry + dynamic loader. Clean break — old behavior stays on npm ≤ 18; old components retreat to `legacy/*` subpath exports.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 22, `node:test` + `node:assert/strict` (run via `node --import tsx/esm --test`), Biome lint/format.

**Spec:** `docs/superpowers/specs/2026-06-05-plugin-pipeline-architecture-design.md`

**Test command (per package):**
```
node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'
```
Run from inside the package dir (e.g. `packages/llm-agent` or `packages/llm-agent-libs`).

---

## File Structure

This plan is organized in phases. **Phases 1–2 (Tasks 1–4)** are fully specified
with complete TDD code — they form a self-contained, compilable, testable
foundation (the contract layer + loader support that everything else depends on).
**Phases 3–6 (Tasks 5–16)** build on that foundation; their entry points are
identified concretely from the codebase, with file:line anchors.

| File | Responsibility | Phase |
|------|----------------|-------|
| `packages/llm-agent/src/interfaces/pipeline-plugin.ts` (create) | `MaybePromise`, `IPipelineInstance`, `IReconfigurableSmartAgent`, `IPipelineContext`, `IPipelinePlugin` | 1 |
| `packages/llm-agent/src/interfaces/index.ts` (modify) | re-export the new contract symbols | 1 |
| `packages/llm-agent/src/interfaces/plugin.ts` (modify) | add `pipelinePlugins` to `PluginExports`; add `pipelinePlugins` + `pipelinePluginSources` to `LoadedPlugins` | 1 |
| `packages/llm-agent-libs/src/plugins/types.ts` (modify) | init new maps in `emptyLoadedPlugins`; reject-duplicate merge + source tracking in `mergePluginExports` | 2 |
| `packages/llm-agent-libs/src/plugins/__tests__/plugin-types.test.ts` (modify) | tests for the merge behavior | 2 |
| `packages/llm-agent-server-libs/src/pipelines/server-context.ts` (create) | `IServerPipelineContext` | 3 |
| `packages/llm-agent-server-libs/src/pipelines/{flat,linear,dag,stepper}.ts` (create) | built-in `IPipelinePlugin` wrappers over the existing factories | 3 |
| `packages/llm-agent-server-libs/src/legacy/{flat,linear,dag,stepper}.ts` (create) | curated re-export bundles of the old components | 4 |
| `packages/llm-agent-server-libs/package.json` (modify) | subpath `exports` for `./<flow>` and `./legacy/<flow>` | 4 |
| `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (modify) | replace the coordinator gate with registry resolve + `build()`; `plugins:` loader; close/recreate | 5 |
| `packages/llm-agent-server-libs/src/smart-agent/config.ts` (modify) | remove `coordinator:` parsing; add `pipeline:` + `plugins:` parsing | 5 |
| `packages/llm-agent-server-libs/src/pipelines/__tests__/conformance.test.ts` (create) | registry conformance + duplicate fail-fast | 6 |

---

## Phase 1 — Core contracts (`@mcp-abap-adt/llm-agent`)

### Task 1: Runnable + reconfigurable contracts

**Files:**
- Create: `packages/llm-agent/src/interfaces/pipeline-plugin.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/pipeline-plugin.test.ts`

These are pure interfaces; the test proves a conforming object compiles and is
shaped as expected at runtime (method presence), which catches signature drift.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent/src/interfaces/__tests__/pipeline-plugin.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IPipelineInstance,
  IReconfigurableSmartAgent,
  MaybePromise,
} from '../pipeline-plugin.js';

describe('pipeline-plugin runnable contracts', () => {
  it('IPipelineInstance exposes agent + close()', async () => {
    const instance: IPipelineInstance = {
      agent: {
        process: async () => ({ ok: true, value: {} }) as never,
        streamProcess: async function* () {},
      },
      close: async () => {},
    };
    assert.equal(typeof instance.agent.streamProcess, 'function');
    assert.equal(typeof instance.close, 'function');
    await instance.close();
  });

  it('IReconfigurableSmartAgent adds reconfigure() and is detectable', () => {
    const agent: IReconfigurableSmartAgent = {
      process: async () => ({ ok: true, value: {} }) as never,
      streamProcess: async function* () {},
      reconfigure: () => {},
    };
    assert.equal('reconfigure' in agent, true);
    assert.equal(typeof agent.reconfigure, 'function');
  });

  it('MaybePromise<T> accepts both sync and async', async () => {
    const sync: MaybePromise<number> = 1;
    const async: MaybePromise<number> = Promise.resolve(2);
    assert.equal(await sync, 1);
    assert.equal(await async, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/llm-agent && node --import tsx/esm --test --test-reporter=spec 'src/interfaces/__tests__/pipeline-plugin.test.ts'`
Expected: FAIL — `Cannot find module '../pipeline-plugin.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/llm-agent/src/interfaces/pipeline-plugin.ts`:

```ts
/**
 * Plugin-pipeline contracts. A pipeline plugin is the implementation of an agent
 * variant; it builds an IPipelineInstance (the runnable agent + a disposal hook).
 * Core-only types — see the design spec, §5. The server hides its config behind
 * the opaque resolveLlm(role) so these contracts never import server/libs types.
 */
import type { ISmartAgent } from './builder.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { ILlm } from './llm.js';
import type { ILogger } from '../logger/types.js';
import type { IMcpClient } from './mcp-client.js';
import type { IRagRegistry } from './rag.js';
import type { LlmCallEntry } from './request-logger.js';

/** A value that may already be resolved or arrive as a promise. */
export type MaybePromise<T> = T | Promise<T>;

/** A SmartAgent that supports runtime LLM hot-swap. Feature-detected by the host. */
export interface IReconfigurableSmartAgent extends ISmartAgent {
  reconfigure(update: { mainLlm?: ILlm; helperLlm?: ILlm; classifierLlm?: ILlm }): void;
}

/** What IPipelinePlugin.build() returns: the runnable agent + a disposal contract
 *  so the host can free MCP / RAG / session resources on recreate or shutdown. */
export interface IPipelineInstance {
  readonly agent: ISmartAgent;
  /** May be a no-op; required so recreate/shutdown never leaks resources. */
  close(): Promise<void>;
}

/** Infra handles the host provides to a pipeline. NOT the flow — the pipeline owns
 *  its flow. Core-only; the server closes over its own config behind resolveLlm. */
export interface IPipelineContext {
  /** Opaque per-role LLM. The server closes over SmartServerLlmConfig/llmMap. */
  resolveLlm(role: string): Promise<ILlm>;
  /** Session-scoped knowledge RAG handle. MaybePromise: may need async init. */
  knowledgeRagFor(sessionId: string): MaybePromise<IKnowledgeRagHandle>;
  /** Tools RAG handle. Always present: the host supplies an EMPTY handle when no
   *  tools RAG is configured, so the contract stays stable for no-RAG deployments. */
  toolsRag: IToolsRagHandle;
  ragRegistry?: IRagRegistry;
  callMcp(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  mcpClients?: IMcpClient[];
  subagents?: ReadonlyArray<{ name: string; description?: string }>;
  mintStepperId(): string;
  logger?: ILogger;
  logLlmCall?(entry: LlmCallEntry): void;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/llm-agent && node --import tsx/esm --test --test-reporter=spec 'src/interfaces/__tests__/pipeline-plugin.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/pipeline-plugin.ts packages/llm-agent/src/interfaces/__tests__/pipeline-plugin.test.ts
git commit -m "feat(contracts): add pipeline-plugin runnable + context contracts"
```

### Task 2: The plugin contract + index re-exports

**Files:**
- Modify: `packages/llm-agent/src/interfaces/pipeline-plugin.ts` (append `IPipelinePlugin`)
- Modify: `packages/llm-agent/src/interfaces/index.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/pipeline-plugin.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/llm-agent/src/interfaces/__tests__/pipeline-plugin.test.ts`:

```ts
import type { IPipelineContext, IPipelinePlugin } from '../pipeline-plugin.js';

describe('IPipelinePlugin', () => {
  it('names itself, parses config, and builds an instance', async () => {
    const plugin: IPipelinePlugin<{ depth: number }> = {
      name: 'demo',
      parseConfig: (raw) => ({ depth: (raw as { depth?: number }).depth ?? 1 }),
      build: async (config, _ctx: IPipelineContext) => ({
        agent: { process: async () => ({ ok: true, value: config }) as never, streamProcess: async function* () {} },
        close: async () => {},
      }),
    };
    assert.equal(plugin.name, 'demo');
    assert.deepEqual(plugin.parseConfig({ depth: 3 }), { depth: 3 });
    const inst = await plugin.build({ depth: 3 }, {} as IPipelineContext);
    assert.equal(typeof inst.close, 'function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/llm-agent && node --import tsx/esm --test --test-reporter=spec 'src/interfaces/__tests__/pipeline-plugin.test.ts'`
Expected: FAIL — `IPipelinePlugin` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/llm-agent/src/interfaces/pipeline-plugin.ts`:

```ts
/** A pipeline plugin = the implementation of an agent variant. It names itself,
 *  validates its own config dialect, and builds the agent. */
export interface IPipelinePlugin<Config = unknown> {
  readonly name: string;
  parseConfig(raw: unknown): Config;
  build(config: Config, ctx: IPipelineContext): Promise<IPipelineInstance>;
}
```

Add to `packages/llm-agent/src/interfaces/index.ts` (follow the existing
`export type { ... } from './<file>.js';` pattern used in that file):

```ts
export type {
  IPipelineContext,
  IPipelineInstance,
  IPipelinePlugin,
  IReconfigurableSmartAgent,
  MaybePromise,
} from './pipeline-plugin.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/llm-agent && node --import tsx/esm --test --test-reporter=spec 'src/interfaces/__tests__/pipeline-plugin.test.ts'`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify the package barrel re-exports compile**

Run: `cd packages/llm-agent && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent/src/interfaces/pipeline-plugin.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/interfaces/__tests__/pipeline-plugin.test.ts
git commit -m "feat(contracts): export IPipelinePlugin and pipeline-plugin types"
```

### Task 3: Wire pipeline plugins into PluginExports + LoadedPlugins

**Files:**
- Modify: `packages/llm-agent/src/interfaces/plugin.ts:99-146`
- Test: `packages/llm-agent/src/interfaces/__tests__/pipeline-plugin.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/llm-agent/src/interfaces/__tests__/pipeline-plugin.test.ts`:

```ts
import type { LoadedPlugins, PluginExports } from '../plugin.js';
import type { IPipelinePlugin } from '../pipeline-plugin.js';

describe('PluginExports / LoadedPlugins carry pipeline plugins', () => {
  it('PluginExports.pipelinePlugins is an optional record', () => {
    const p: IPipelinePlugin = {
      name: 'x',
      parseConfig: (r) => r,
      build: async () => ({ agent: {} as never, close: async () => {} }),
    };
    const exports: PluginExports = { pipelinePlugins: { x: p } };
    assert.equal(exports.pipelinePlugins?.x.name, 'x');
  });

  it('LoadedPlugins has pipelinePlugins + pipelinePluginSources maps', () => {
    const loaded: Pick<LoadedPlugins, 'pipelinePlugins' | 'pipelinePluginSources'> = {
      pipelinePlugins: new Map(),
      pipelinePluginSources: new Map(),
    };
    assert.ok(loaded.pipelinePlugins instanceof Map);
    assert.ok(loaded.pipelinePluginSources instanceof Map);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/llm-agent && node --import tsx/esm --test --test-reporter=spec 'src/interfaces/__tests__/pipeline-plugin.test.ts'`
Expected: FAIL — `pipelinePlugins` / `pipelinePluginSources` not on the types.

- [ ] **Step 3: Write the minimal implementation**

In `packages/llm-agent/src/interfaces/plugin.ts`, add the import near the top
(after the existing imports):

```ts
import type { IPipelinePlugin } from './pipeline-plugin.js';
```

Add to the `PluginExports` interface (after `apiAdapters?` at line ~125):

```ts
  /** Agent-variant pipelines contributed by a dynamically-loaded plugin. */
  pipelinePlugins?: Record<string, IPipelinePlugin>;
```

Add to the `LoadedPlugins` interface (after `apiAdapters` at line ~141):

```ts
  /** Resolved pipeline plugins, keyed by pipeline name. */
  pipelinePlugins: Map<string, IPipelinePlugin>;
  /** name → first-seen source, so duplicate-name errors can name both sources. */
  pipelinePluginSources: Map<string, string>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/llm-agent && node --import tsx/esm --test --test-reporter=spec 'src/interfaces/__tests__/pipeline-plugin.test.ts'`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/plugin.ts packages/llm-agent/src/interfaces/__tests__/pipeline-plugin.test.ts
git commit -m "feat(contracts): carry pipeline plugins in PluginExports and LoadedPlugins"
```

---

## Phase 2 — Loader plumbing (`@mcp-abap-adt/llm-agent-libs`)

### Task 4: emptyLoadedPlugins init + reject-duplicate merge with source tracking

**Files:**
- Modify: `packages/llm-agent-libs/src/plugins/types.ts:22-32` (emptyLoadedPlugins) and `:43-112` (mergePluginExports)
- Test: `packages/llm-agent-libs/src/plugins/__tests__/plugin-types.test.ts` (append)

This is real behavior — full TDD. Note the **different rule** from `stageHandlers`:
`stageHandlers` is last-wins (`.set()` overwrites); pipeline names must **reject
duplicates** (record an error naming both sources, keep the first).

- [ ] **Step 1: Write the failing tests**

Append to `packages/llm-agent-libs/src/plugins/__tests__/plugin-types.test.ts`
(it already imports `emptyLoadedPlugins`, `mergePluginExports`):

```ts
import type { IPipelinePlugin } from '@mcp-abap-adt/llm-agent';

function stubPipeline(name: string): IPipelinePlugin {
  return {
    name,
    parseConfig: (r) => r,
    build: async () => ({ agent: {} as never, close: async () => {} }),
  };
}

describe('pipelinePlugins merge', () => {
  it('emptyLoadedPlugins initialises both pipeline maps', () => {
    const r = emptyLoadedPlugins();
    assert.ok(r.pipelinePlugins instanceof Map);
    assert.ok(r.pipelinePluginSources instanceof Map);
    assert.equal(r.pipelinePlugins.size, 0);
  });

  it('registers a pipeline plugin and records its source', () => {
    const r = emptyLoadedPlugins();
    const registered = mergePluginExports(r, { pipelinePlugins: { dag: stubPipeline('dag') } }, 'pkg-a');
    assert.equal(registered, true);
    assert.equal(r.pipelinePlugins.get('dag')?.name, 'dag');
    assert.equal(r.pipelinePluginSources.get('dag'), 'pkg-a');
  });

  it('rejects a duplicate name: keeps the first, records an error naming both sources', () => {
    const r = emptyLoadedPlugins();
    mergePluginExports(r, { pipelinePlugins: { dag: stubPipeline('dag') } }, 'pkg-a');
    mergePluginExports(r, { pipelinePlugins: { dag: stubPipeline('dag-2') } }, 'pkg-b');
    // first wins
    assert.equal(r.pipelinePlugins.get('dag')?.name, 'dag');
    // duplicate recorded with BOTH sources
    const dupe = r.errors.find((e) => e.error.includes('duplicate pipeline'));
    assert.ok(dupe, 'expected a duplicate-pipeline error');
    assert.ok(dupe?.error.includes('pkg-a'));
    assert.ok(dupe?.error.includes('pkg-b'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/llm-agent-libs && node --import tsx/esm --test --test-reporter=spec 'src/plugins/__tests__/plugin-types.test.ts'`
Expected: FAIL — `r.pipelinePlugins` is undefined / not initialised.

- [ ] **Step 3: Write the implementation**

In `packages/llm-agent-libs/src/plugins/types.ts`, update `emptyLoadedPlugins()`
to add the two maps:

```ts
export function emptyLoadedPlugins(): LoadedPlugins {
  return {
    stageHandlers: new Map(),
    embedderFactories: {},
    mcpClients: [],
    clientAdapters: [],
    apiAdapters: new Map(),
    pipelinePlugins: new Map(),
    pipelinePluginSources: new Map(),
    loadedFiles: [],
    errors: [],
  };
}
```

In `mergePluginExports()`, add this block immediately before the
`if (registered) { result.loadedFiles.push(source); }` tail:

```ts
  if (mod.pipelinePlugins && typeof mod.pipelinePlugins === 'object') {
    for (const [name, plugin] of Object.entries(mod.pipelinePlugins)) {
      if (!plugin || typeof (plugin as IPipelinePlugin).build !== 'function') continue;
      if (result.pipelinePlugins.has(name)) {
        const prior = result.pipelinePluginSources.get(name) ?? 'unknown';
        result.errors.push({
          file: source,
          error: `duplicate pipeline name '${name}' from '${source}'; already registered by '${prior}' (keeping the first)`,
        });
        continue; // keep the first
      }
      result.pipelinePlugins.set(name, plugin as IPipelinePlugin);
      result.pipelinePluginSources.set(name, source);
      registered = true;
    }
  }
```

Add the type import at the top of `types.ts` (extend the existing import from
`@mcp-abap-adt/llm-agent`):

```ts
import type {
  ILlmApiAdapter,
  IPipelinePlugin,
  IPluginLoader,
  IStageHandler,
  LoadedPlugins,
  PluginExports,
} from '@mcp-abap-adt/llm-agent';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/llm-agent-libs && node --import tsx/esm --test --test-reporter=spec 'src/plugins/__tests__/plugin-types.test.ts'`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Build the dependency chain to confirm no type breakage**

Run: `cd /home/okyslytsia/prj/llm-agent && npm run build`
Expected: clean compile (the new `LoadedPlugins` required fields are satisfied by
`emptyLoadedPlugins`; check no other `LoadedPlugins` literal exists that now lacks
the fields — if the compiler flags one, add `pipelinePlugins: new Map(), pipelinePluginSources: new Map()` there).

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/plugins/types.ts packages/llm-agent-libs/src/plugins/__tests__/plugin-types.test.ts
git commit -m "feat(plugins): merge pipeline plugins with reject-duplicate + source tracking"
```

---

## Phases 3–6 — Built-ins, legacy, host, conformance

> These phases build on the Phase 1–2 foundation. Their entry points are identified
> below from the codebase; each must be written into full bite-sized tasks **after
> Phase 1–2 lands**, when the implementer reads the referenced wiring in detail. The
> design spec sections in parentheses are the source of truth.

### Task 5: `IServerPipelineContext` (spec §5)

- Create `packages/llm-agent-server-libs/src/pipelines/server-context.ts` exporting
  `IServerPipelineContext extends IPipelineContext` adding the libs/server services
  (`sessionManager?`, `tracer?`, `metrics?`, `toolCache?`, `toolPolicy?`,
  `outputValidator?`) imported from `@mcp-abap-adt/llm-agent-libs`.
- Test: a shape test mirroring Task 1.

### Tasks 6–9: Built-in pipeline plugins (spec §6)

One task per variant — `flat`, `linear`, `dag`, `stepper` — under
`packages/llm-agent-server-libs/src/pipelines/<flow>.ts`. Each `IPipelinePlugin`:
- `parseConfig` delegates to the existing config parser for that variant
  (`parseStepperCoordinatorConfig` at `config.ts:1586` for `stepper`;
  `buildDagCoordinatorDeps` inputs at `build-dag-coordinator-deps.ts` for `dag`;
  the linear `YamlCoordinator` fields at `config.ts:159-167` for `linear`).
- `build` wraps the corresponding existing factory in
  `packages/llm-agent-server-libs/src/factories/` (`DagFactory`, `LinearFactory`,
  `CyclicFactory`/`PlannedFactory`/`DeepStepperFactory` for the three stepper modes,
  and the no-coordinator path for `flat`) — each factory `.build(config, deps)`
  returns a `SmartAgentHandle`; wrap it as `{ agent: handle.agent, close: handle.close }`.
- Each task: a unit test driving `parseConfig` → `build(stubServerCtx)` →
  `inst.agent.streamProcess` with fake LLM/MCP → `inst.close()`.

### Tasks 10–11: legacy/* relocation + subpath exports (spec §8)

- **Task 10:** create `packages/llm-agent-server-libs/src/legacy/{flat,linear,dag,stepper}.ts`,
  each re-exporting the low-level classes for that flow (`DagCoordinatorHandler`,
  `StepperCoordinatorHandler`, `Stepper`, `CoordinatorHandler`, `CyclicReActExecutor`,
  `buildStepperRoot`, `buildDagCoordinatorDeps`, the factories) needed to rebuild it
  by hand. No logic — re-exports only.
- **Task 11:** replace the single `.` export in
  `packages/llm-agent-server-libs/package.json` with subpath `exports` for `.`,
  `./flat`, `./linear`, `./dag`, `./stepper`, `./legacy/flat`, `./legacy/linear`,
  `./legacy/dag`, `./legacy/stepper` (see spec §8 for the exact map). Verify
  `npm run build` then `node -e "import('@mcp-abap-adt/llm-agent-server-libs/legacy/dag')"`.

### Tasks 12–15: Host integration (spec §7, §7.1, §9, §11)

In `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` and
`config.ts`. The current coordinator gate is `smart-server.ts:1267-1628`; plugins
load at `:1058` (before RAG at `:1084`); `builder.build()` is `:1631`.

- **Task 12 (registry + build):** build a `Map<string, IPipelinePlugin>` from the 4
  built-ins (static) + `LoadedPlugins.pipelinePlugins`; resolve `pipeline.name`;
  `parseConfig` then `build(serverCtx)`; **replace** the 3-way coordinator gate
  (`:1267-1628`) with `const inst = await plugin.build(cfg, ctx)`. Unknown name →
  fail-fast listing available names.
- **Task 13 (`plugins:` loader + order):** add `plugins: string[]` to the config;
  resolve each specifier with `createRequire(process.cwd())` / `import.meta.resolve`
  (cwd base) + absolute-path support; `await import()` and route the full module
  through `mergePluginExports()` **alongside** `pluginDir`, **before** RAG/embedder
  build (keep the `:1058`-before-`:1084` ordering). Duplicate names fail-fast via the
  Task-4 merge.
- **Task 14 (lifecycle):** hold `inst`; per request `inst.agent.streamProcess`; on
  shutdown / before recreate call `inst.close()`; on LLM hot-swap feature-detect
  `IReconfigurableSmartAgent` on `inst.agent`, else `close()`-then-recreate.
- **Task 15 (config clean break):** in `config.ts`, **remove** `coordinator:` parsing
  (`parseStepperCoordinatorConfig` `:1586-1750`, `MODE_FLOW_PRESET` `:1440-1447`,
  `assertCoordinatorConfigShape` `:231-278`, `YamlCoordinator` `:131-176`) and the
  structured-pipeline `StageDefinition` DSL; add `pipeline: { name, config }` +
  `plugins: string[]` parsing. Update example YAMLs under `examples/`.

### Task 16: Conformance + generic-host test (spec §10)

- Create `packages/llm-agent-server-libs/src/pipelines/__tests__/conformance.test.ts`:
  iterate the built-in registry — each must `parseConfig` a minimal config, `build`
  an `IPipelineInstance`, `streamProcess` a trivial request (stub LLM/MCP), and
  `close()` cleanly. Add a negative case asserting duplicate pipeline names across
  two sources produce a fail-fast error (reuse the Task-4 merge).

---

## Self-Review

**1. Spec coverage:**
- §1 core idea / §5 contract → Tasks 1–3 (IPipelinePlugin, IPipelineInstance, IPipelineContext, IReconfigurableSmartAgent, MaybePromise). ✓
- §5 server context → Task 5 (IServerPipelineContext). ✓
- §6 built-ins as factory wrappers → Tasks 6–9. ✓
- §7 loader plumbing (LoadedPlugins, merge reject-duplicate, source tracking) → Tasks 3–4. ✓
- §7/§7.1 host registry + `plugins:` loader + cwd resolution + startup order → Tasks 12–13. ✓
- §7 lifecycle (build once, close, recreate, reconfigure feature-detect) → Tasks 1, 14. ✓
- §8 legacy/* + subpath exports → Tasks 10–11. ✓
- §9 YAML `pipeline:`/`plugins:` parsing + responsibility split → Tasks 13, 15. ✓
- §10 testing → Tasks 4, 6–9, 16. ✓
- §11 migration / clean break (remove coordinator: + StageDefinition DSL) → Task 15. ✓

**2. Placeholder scan:** Phases 1–2 (Tasks 1–4) contain complete code and exact
commands. Tasks 5–16 are intentionally specified at entry-point granularity (with
file:line anchors and the exact factories/parsers to wrap), to be expanded into
bite-sized steps when implemented — this is the planned phase boundary, not a
content gap.

**3. Type consistency:** Symbols are consistent across tasks — `IPipelineInstance`
(`{ agent, close() }`), `IPipelinePlugin` (`name` / `parseConfig` / `build`),
`IPipelineContext` (`resolveLlm`, `knowledgeRagFor: MaybePromise`, `toolsRag`),
`LoadedPlugins.pipelinePlugins` + `pipelinePluginSources`. The merge error string
(`'duplicate pipeline …'`) used in Task 4 is the same one Task 16 asserts.

> **Note on scope:** Phases 1–2 are a complete, shippable, tested foundation. Phases
> 3–6 should be split into their own detailed plan(s) before implementation, since
> the host integration (Tasks 12–15) rewrites sections of the ~3000-line
> `smart-server.ts` and warrants its own task-by-task expansion grounded in a close
> read of that file. The anchors above make that expansion mechanical.
