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

This plan is organized in phases, all expanded to executable detail. **Phase 1–2
(Tasks 0–4)** and **Phase 3–4/6 (Tasks 5, 7–12, 17)** are complete TDD with full
code. The keystone **Task 6** and **Phase 5 (Tasks 13–16)** are in-place refactors
of the live `smart-server.ts`/`config.ts`, specified by target signature + test +
exact source anchors + the precise fields to thread/remove (verbatim shapes were
captured from the codebase). Build after each task so `tsc` validates wiring.

| File | Responsibility | Phase |
|------|----------------|-------|
| `packages/llm-agent/tsconfig.test.json` (create) | test-inclusive config for the type-only red/green gate | 1 |
| `packages/llm-agent/src/interfaces/pipeline-plugin.ts` (create) | `MaybePromise`, `IPipelineInstance`, `IReconfigurableSmartAgent`, `IPipelineContext`, `IPipelinePlugin` | 1 |
| `packages/llm-agent/src/interfaces/index.ts` (modify) | re-export the new contract symbols | 1 |
| `packages/llm-agent/src/interfaces/plugin.ts` (modify) | add `pipelinePlugins` to `PluginExports`; add `pipelinePlugins` + `pipelinePluginSources` to `LoadedPlugins` | 1 |
| `packages/llm-agent-libs/src/plugins/types.ts` (modify) | init new maps in `emptyLoadedPlugins`; reject-duplicate merge + source tracking in `mergePluginExports` | 2 |
| `packages/llm-agent-libs/src/plugins/__tests__/plugin-types.test.ts` (modify) | tests for the merge behavior | 2 |
| `packages/llm-agent-server-libs/src/pipelines/server-context.ts` (create) | `IServerPipelineContext` (adds `createAgentBuilder()` + libs services) | 3 |
| `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (modify) | extract `buildBaseBuilder` (keystone) feeding `createAgentBuilder` | 3 |
| `packages/llm-agent-server-libs/src/pipelines/{flat,linear,dag,stepper}.ts` (create) | built-in `IPipelinePlugin` wrappers: factory→`BuiltCoordinator`→`builder.withStepperCoordinator` | 3 |
| `packages/llm-agent-server-libs/src/legacy/{flat,linear,dag,stepper}.ts` (create) | curated re-export bundles of the old components | 4 |
| `packages/llm-agent-server-libs/package.json` (modify) | subpath `exports` for `./<flow>` and `./legacy/<flow>` | 4 |
| `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (modify) | replace the coordinator gate with registry resolve + `build()`; `plugins:` loader; close/recreate | 5 |
| `packages/llm-agent-server-libs/src/pipelines/parsers.ts` (create) | relocated variant parsers (stepper/dag/linear) the plugins call | 5 |
| `packages/llm-agent-server-libs/src/smart-agent/config.ts` (modify) | remove top-level `coordinator:` dispatch (parsers relocated, not deleted); add `pipeline:` + `plugins:` parsing | 5 |
| `packages/llm-agent-server-libs/src/pipelines/__tests__/conformance.test.ts` (create) | registry conformance + duplicate fail-fast | 6 |

---

## Phase 1 — Core contracts (`@mcp-abap-adt/llm-agent`)

> **Type-only red/green gate (plan-review F1).** Tasks 1–3 add **types**, and the
> test runner (`node --import tsx/esm --test`) **strips types without checking them**
> — `import type` from a missing module is erased, so a node:test run can falsely
> PASS before the type exists. The build `tsconfig.json` is **also** no help: it
> **excludes** `**/__tests__/**` and `**/*.test.ts`, so a plain
> `tsc -p tsconfig.json --noEmit` never sees the test file and passes regardless.
>
> **Therefore Task 0 first creates a test-inclusive config**, and the authoritative
> red/green gate for Tasks 1–3 is `npx tsc -p tsconfig.test.json --noEmit` (from
> `packages/llm-agent`): it type-checks the test file, so it FAILS when a referenced
> type is missing/wrong and PASSES once correct. The node:test runs stay as a
> supplementary runtime smoke; **the `tsconfig.test.json` step flips red→green**.

### Task 0: Test-inclusive tsconfig for the type gate

**Files:**
- Create: `packages/llm-agent/tsconfig.test.json`

- [ ] **Step 1: Create the config**

```jsonc
// packages/llm-agent/tsconfig.test.json — type-checks ONLY the new contract test
// (and, transitively, everything it imports). NOT a blanket src/**/* — the package
// already has many src/interfaces/__tests__/*.contract.test.ts that the build
// excludes and that were never type-checked; a wide include would fail the gate on
// unrelated old tests. tsc follows the test file's imports, so the contract types
// still get checked. Build still uses tsconfig.json; this is gate-only.
//
// IMPORTANT: use "files", NOT "include". The base tsconfig.json has
// `exclude: ["**/__tests__/**", "**/*.test.ts", "dist"]`, which is INHERITED and
// would strip an `include`d test file → `TS18003: No inputs were found`. A "files"
// entry is always included regardless of `exclude`, so it is the robust gate input.
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "files": ["src/interfaces/__tests__/pipeline-plugin.test.ts"]
}
```

- [ ] **Step 2: Note — no baseline run yet**

The included file does not exist until Task 1 Step 1, so
`tsc -p tsconfig.test.json` would report `TS18003: No inputs were found`. That is
expected; the gate is first exercised (RED) in Task 1 Step 2 once the test file
exists. Do not run it here.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent/tsconfig.test.json
git commit -m "chore(llm-agent): test-inclusive tsconfig for type-only gates"
```

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

- [ ] **Step 2: Run the type gate to verify it fails**

Run: `cd packages/llm-agent && npx tsc -p tsconfig.test.json --noEmit`
Expected: FAIL — `error TS2307: Cannot find module '../pipeline-plugin.js'` (and
`TS2305` for each missing exported type). This is the authoritative gate; a bare
`node --import tsx/esm --test ...` run would falsely pass because types are erased.

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
  mintTurnId(): string;
  logger?: ILogger;
  logLlmCall?(entry: LlmCallEntry): void;
}
```

- [ ] **Step 4: Run the type gate + runtime smoke to verify they pass**

Run: `cd packages/llm-agent && npx tsc -p tsconfig.test.json --noEmit`
Expected: PASS (no errors — types now resolve).
Then: `node --import tsx/esm --test --test-reporter=spec 'src/interfaces/__tests__/pipeline-plugin.test.ts'`
Expected: PASS (3 tests — runtime smoke).

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

- [ ] **Step 2: Run the type gate to verify it fails**

Run: `cd packages/llm-agent && npx tsc -p tsconfig.test.json --noEmit`
Expected: FAIL — `TS2305: Module '"../pipeline-plugin.js"' has no exported member 'IPipelinePlugin'`. (A `node --import tsx/esm --test` run would falsely pass — types erased.)

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

- [ ] **Step 4: Run the type gate + runtime smoke to verify they pass**

Run: `cd packages/llm-agent && npx tsc -p tsconfig.test.json --noEmit`
Expected: PASS (no errors).
Then: `node --import tsx/esm --test --test-reporter=spec 'src/interfaces/__tests__/pipeline-plugin.test.ts'`
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

- [ ] **Step 2: Run the type gate to verify it fails**

Run: `cd packages/llm-agent && npx tsc -p tsconfig.test.json --noEmit`
Expected: FAIL — `TS2339`/`TS2305` for `pipelinePlugins` / `pipelinePluginSources` not on the types. (A `node --import tsx/esm --test` run would falsely pass — types erased.)

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

- [ ] **Step 4: Run the type gate + runtime smoke to verify they pass**

Run: `cd packages/llm-agent && npx tsc -p tsconfig.test.json --noEmit`
Expected: PASS (no errors).
Then: `node --import tsx/esm --test --test-reporter=spec 'src/interfaces/__tests__/pipeline-plugin.test.ts'`
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
    // A duplicate error is recorded that names the pipeline AND both sources.
    // Assert on the stable contract (name + both sources), NOT a brittle phrase.
    const dupe = r.errors.find(
      (e) =>
        e.error.includes("'dag'") &&
        e.error.includes('pkg-a') &&
        e.error.includes('pkg-b'),
    );
    assert.ok(dupe, 'expected a duplicate error naming the pipeline and both sources');
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

## Phase 3 — Built-in pipelines (`@mcp-abap-adt/llm-agent-server-libs`)

> All built-ins live under `packages/llm-agent-server-libs/src/pipelines/`. Tests
> run with `cd packages/llm-agent-server-libs && node --import tsx/esm --test
> --test-reporter=spec 'src/pipelines/__tests__/<file>.test.ts'`. The package has a
> real test runner already; no extra tsconfig is needed here (these tasks add
> runtime values, so `node:test` gates them correctly — unlike the type-only
> Phase 1).

### Task 5: `IServerPipelineContext`

**Files:**
- Create: `packages/llm-agent-server-libs/src/pipelines/server-context.ts`

> Type-only interface — no runtime export. A `node:test` would falsely pass (tsx
> erases types), so the gate here is `npm run build` (server-context.ts is a real
> src file `tsc` compiles) PLUS its real behavioral validation downstream: Task 7's
> `fakeServerCtx(): IServerPipelineContext` and the built-in plugins' `build(_, ctx)`
> signatures force a full structural check when those tasks compile. No standalone
> type-only test (avoids the Phase-1 F1 trap at the server-libs layer).

- [ ] **Step 1: Write the implementation**

```ts
// packages/llm-agent-server-libs/src/pipelines/server-context.ts
import type { ILlm, IPipelineContext, ISubAgent } from '@mcp-abap-adt/llm-agent';
import type { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import type { NormalizedLlmMap } from '../smart-agent/config.js';
import type { SmartServerLlmConfig } from '../smart-agent/smart-server.js';

/**
 * Server-side pipeline context. Extends the portable core IPipelineContext with
 * the SmartAgentBuilder factory (host owns agent assembly) and the raw materials
 * the DAG/linear coordinator builders need. Built-ins downcast IPipelineContext
 * to this; the stepper variant uses only the core surface.
 */
export interface IServerPipelineContext extends IPipelineContext {
  /** Builder pre-wired with all shared infra EXCEPT the coordinator. */
  createAgentBuilder(): Promise<SmartAgentBuilder>;
  // Raw materials for buildDagCoordinatorDeps / linear strategy resolution.
  makeLlm(cfg: SmartServerLlmConfig): Promise<ILlm>;
  llmMap?: NormalizedLlmMap;
  pipelineFallback?: SmartServerLlmConfig;
  mainLlm: ILlm;
  helperLlm?: ILlm;
  mainTemp: number;
  /** Session-scoped worker registry (DAG workers / linear subagents). */
  workerRegistry: ReadonlyMap<string, ISubAgent>;
  warn(msg: string): void;
}
```

> NOTE on imports (verified): `SmartAgentBuilder` ← `@mcp-abap-adt/llm-agent-libs`
> (`builder.ts`); `ISubAgent` ← core `@mcp-abap-adt/llm-agent`; `NormalizedLlmMap`
> ← `../smart-agent/config.js` (declared there, `config.ts:38`); **`SmartServerLlmConfig`
> ← `../smart-agent/smart-server.js`** (declared/exported at `smart-server.ts:88`;
> `config.ts` only imports it as a type and does NOT re-export it). All are
> `import type`, so there is no runtime import cycle with `smart-server.ts`.

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/okyslytsia/prj/llm-agent && npm run build`
Expected: clean compile (the interface is a valid src file). Its structural
correctness is enforced downstream when Task 7's `fakeServerCtx` and the plugins'
`build(_, ctx)` compile against it.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-server-libs/src/pipelines/server-context.ts
git commit -m "feat(pipelines): IServerPipelineContext (createAgentBuilder + dag/linear materials)"
```

### Task 6 (keystone): extract `buildBaseBuilder` + `createServerPipelineContext`

This is a **refactor of the live `smart-server.ts`** (~3000 lines). It edits in
place; the "code" is the target signatures + the test, with exact source anchors.
Do it before the host integration (Tasks 13–16) and before wiring built-ins.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/build-base-builder.test.ts` (env-gated integration, like `dag-coordinator-mcp.integration.test.ts`)

- [ ] **Step 1: Write the failing test (gated)**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const RUN = process.env.RUN_LIVE_INTEGRATION === '1';
describe('buildBaseBuilder', { skip: !RUN }, () => {
  it('builds a working agent for a no-coordinator config', async () => {
    // Start a SmartServer from a minimal flat config; assert it serves a request
    // WITHOUT any coordinator wired (base builder + .build()).
    // (Reuse the harness from dag-coordinator-mcp.integration.test.ts.)
    assert.ok(true); // placeholder asserted by the harness wiring
  });
});
```

- [ ] **Step 2: Extract `buildBaseBuilder`**

In `smart-server.ts`, the builder assembly is **lines ~1091–1259** (from
`new SmartAgentBuilder({...})` through the final `.withSubAgents(registry)` —
the last `.withXxx()` BEFORE the coordinator gate at ~1267). Extract it into a
private method that BOTH the startup path and `buildSessionAgent` (~2098–2122)
call, so the `withXxx` set is wired once (DRY). Target signature:

```ts
// Inputs are the per-(session-)scope locals the chain reads. Make them a params
// object so startup and buildSessionAgent can both supply their scope's values.
private buildBaseBuilder(parts: {
  mainLlm: ILlm;
  classifierLlm: ILlm;
  helperLlm?: ILlm;
  fileLogger: ILogger;
  toolsRag?: IRag;
  historyRag?: IRag;
  ragRegistry?: IRagRegistry;
  mcpClients?: IMcpClient[];
  requestLogger?: IRequestLogger;
  plugins: LoadedPlugins;
  mergedEmbedderFactories: Record<string, EmbedderFactory>;
  workerRegistry: SubAgentRegistry; // built subagents (SmartAgentSubAgent map)
}): SmartAgentBuilder {
  // body = the relocated lines 1091–1259, reading from `parts.*` instead of the
  // surrounding start() locals. Returns the builder WITHOUT any with*Coordinator.
}
```

Replace the inline chain at ~1091–1259 (startup) and the chain at ~2108–2122
(`buildSessionAgent`) with calls to `this.buildBaseBuilder(parts)`. The startup
path then continues to the (soon-removed) coordinator gate; `buildSessionAgent`
continues to its (soon-removed) coordinator re-wire. Those gates are removed in
Task 14 — for now keep them, calling `buildBaseBuilder` first.

- [ ] **Step 3: Add `createServerPipelineContext`**

Add a private method that assembles an `IServerPipelineContext` for a given
session scope, sourcing each field from the existing wiring (anchors verified):

```ts
private createServerPipelineContext(scope: {
  sessionId: string;
  parts: SessionAgentParts; // mcpClients, ragRegistry, requestLogger, toolsRag
}): IServerPipelineContext {
  return {
    // core surface
    resolveLlm: (role) => this.resolveRoleLlm(role),          // llmMap → fallback → mainLlm
    knowledgeRagFor: (sid) => this.knowledgeRagFor(sid),      // smart-server.ts:1288
    toolsRag: this.toolsRagHandle ?? EMPTY_TOOLS_RAG,         // :1343 ; empty handle = Task 13
    ragRegistry: scope.parts.ragRegistry,
    callMcp: (n, a, s) => this.callMcp(n, a, s),              // buildMcpBridge :1393
    mcpClients: scope.parts.mcpClients,
    subagents: (this.cfg.subAgentConfigs ?? []).map((s) => ({ name: s.name, description: s.description })), // :1405
    mintStepperId: () => this._mintStepperId(),               // :1377 randomUUID
    mintTurnId: () => this._mintTurnId(),                     // :1378 randomUUID
    logger: this._fileLogger,
    logLlmCall: (e) => this._requestLogger?.logLlmCall?.(e),
    // server surface
    createAgentBuilder: async () => this.buildBaseBuilder(this.partsToBaseInput(scope.parts)),
    makeLlm: (c) => this._makeLlm(c),
    llmMap: this._llmMap,
    pipelineFallback: this._pipelineFallback,
    mainLlm: this._mainLlm,
    helperLlm: this._helperLlm,
    mainTemp: this._mainTemp,
    workerRegistry: this.buildWorkerRegistry(scope.parts), // fresh ISubAgent map per session
    warn: (m) => this._fileLogger?.({ level: 'warn', msg: m } as never),
  };
}
```

(The helper names `resolveRoleLlm`, `knowledgeRagFor`, `callMcp`, `_mintStepperId`,
`_makeLlm`, `buildWorkerRegistry`, `partsToBaseInput` correspond to existing
inline logic at the cited anchors — promote the inline closures to methods as you
extract. `EMPTY_TOOLS_RAG` is defined in Task 13.)

- [ ] **Step 4: Build + gated test**

Run: `cd /home/okyslytsia/prj/llm-agent && npm run build` → clean.
Run (if a live MCP is available): `RUN_LIVE_INTEGRATION=1 cd packages/llm-agent-server-libs && node --import tsx/esm --test 'src/smart-agent/__tests__/build-base-builder.test.ts'` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/build-base-builder.test.ts
git commit -m "refactor(server): extract buildBaseBuilder + createServerPipelineContext"
```

### Task 7: Stepper pipeline plugin (exemplar — full code)

**Files:**
- Create: `packages/llm-agent-server-libs/src/pipelines/parsers.ts` (**re-export facade now**, physically filled in Task 16)
- Create: `packages/llm-agent-server-libs/src/pipelines/stepper.ts`
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/stepper.test.ts`

> **Parser facade (fixes the Task-7↔Task-16 ordering, F2/F3).** All plugins and the
> legacy bundles import parsers from `./parsers.js` (or `../pipelines/parsers.js`)
> from the start. `parsers.ts` begins as a **thin re-export facade** over the
> still-in-place `config.ts` definitions, so every task builds green; Task 16 later
> physically MOVES the bodies into `parsers.ts` and removes the `config.ts`
> originals together with the coordinator gate — importers never change.

- [ ] **Step 0: Create the parser facade**

```ts
// packages/llm-agent-server-libs/src/pipelines/parsers.ts
// Facade now; Task 16 moves the real bodies here and drops the config.ts copies.
export {
  parseStepperCoordinatorConfig,
  type StepperCoordinatorConfig,
} from '../smart-agent/config.js';
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StepperPipelinePlugin } from '../stepper.js';
import { fakeServerCtx } from './fixtures.js'; // see Step 3

describe('StepperPipelinePlugin', () => {
  it('parses config, builds an instance, streams, and closes', async () => {
    const plugin = new StepperPipelinePlugin();
    const cfg = plugin.parseConfig({ mode: 'planned-react' });
    assert.equal(cfg.mode, 'planned-react');
    const inst = await plugin.build(cfg, fakeServerCtx());
    assert.equal(typeof inst.agent.streamProcess, 'function');
    await inst.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec 'src/pipelines/__tests__/stepper.test.ts'`
Expected: FAIL — `Cannot find module '../stepper.js'`.

- [ ] **Step 3: Write the test fixture + the plugin**

`packages/llm-agent-server-libs/src/pipelines/__tests__/fixtures.ts` — a minimal
`IServerPipelineContext` whose `createAgentBuilder()` returns a real
`SmartAgentBuilder` over a stub LLM and no MCP:

```ts
import type { ILlm, ISmartAgent } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import type { IServerPipelineContext } from '../server-context.js';

const stubLlm: ILlm = {
  chat: async () => ({ ok: true, value: { content: 'ok', toolCalls: [] } }) as never,
  streamChat: async function* () {},
  model: 'stub',
} as unknown as ILlm;

export function fakeServerCtx(): IServerPipelineContext {
  return {
    resolveLlm: async () => stubLlm,
    knowledgeRagFor: () => ({ add: async () => {}, query: async () => [] }) as never,
    toolsRag: { query: async () => [], lookup: () => undefined },
    callMcp: async () => '',
    subagents: [],
    mintStepperId: () => 's1',
    mintTurnId: () => 't1',
    createAgentBuilder: async () => new SmartAgentBuilder({}).withMainLlm(stubLlm).withMode('smart'),
    makeLlm: async () => stubLlm,
    mainLlm: stubLlm,
    mainTemp: 0,
    workerRegistry: new Map(),
    warn: () => {},
  };
}
```

`packages/llm-agent-server-libs/src/pipelines/stepper.ts`:

```ts
import type {
  IPipelineInstance, IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import {
  CyclicFactory, DeepStepperFactory, PlannedFactory,
  type StepperFactoryConfig, type StepperFactoryDeps,
} from '../factories/index.js';
import { parseStepperCoordinatorConfig, type StepperCoordinatorConfig } from './parsers.js';
import type { IServerPipelineContext } from './server-context.js';

export class StepperPipelinePlugin implements IPipelinePlugin<StepperCoordinatorConfig> {
  readonly name = 'stepper';

  parseConfig(raw: unknown): StepperCoordinatorConfig {
    return parseStepperCoordinatorConfig((raw ?? {}) as Record<string, unknown>);
  }

  async build(cfg: StepperCoordinatorConfig, ctx: IServerPipelineContext): Promise<IPipelineInstance> {
    // StepperFactoryConfig = Omit<StepperCompositionSpec,'planner'|'executor'>.
    // Source its fields from cfg (top-level) + cfg.flow (the StepperCompositionSpec).
    const spec: StepperFactoryConfig = {
      granularity: cfg.flow.granularity,
      finalizer: cfg.flow.finalizer,
      plannerSystemPrompt: cfg.flow.plannerSystemPrompt,
      executorSystemPrompt: cfg.flow.executorSystemPrompt,
      evaluatorEnabled: cfg.flow.evaluatorEnabled,
      evaluatorAtDepths: cfg.flow.evaluatorAtDepths,
      evaluatorSystemPrompt: cfg.flow.evaluatorSystemPrompt,
      reviewerAtDepths: cfg.reviewerAtDepths,
      maxParallelSteps: cfg.maxParallelSteps,
      maxDepth: cfg.maxDepth,
      tokenBudget: cfg.tokenBudget,
      formalizeTask: cfg.formalizeTask,
      plan: cfg.flow.plan,
      nodes: cfg.flow.nodes,
    };
    const deps: StepperFactoryDeps = {
      makeRoleLlm: (role) => ctx.resolveLlm(role),
      callMcp: (n, a, s) => ctx.callMcp(n, a, s).then(String),
      // F2: ctx.knowledgeRagFor is MaybePromise; StepperFactoryDeps wants Promise.
      knowledgeRagFor: async (sid) => ctx.knowledgeRagFor(sid),
      toolsRag: ctx.toolsRag,
      mintStepperId: () => ctx.mintStepperId(),
      mintTurnId: () => ctx.mintTurnId(),
      subagents: ctx.subagents,
    };
    const factory =
      cfg.mode === 'cyclic-react' ? new CyclicFactory()
      : cfg.mode === 'deep-stepper' ? new DeepStepperFactory()
      : new PlannedFactory(); // 'planned-react' (default)
    const { handler } = await factory.build(spec, deps);
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
```

> `parseStepperCoordinatorConfig` + `StepperCoordinatorConfig` import from
> `./parsers.js` (the Step-0 facade); Task 16 moves the bodies there transparently.
> Verify the `spec` field set against `StepperFactoryConfig =
> Omit<StepperCompositionSpec,'planner'|'executor'>` — `tsc` will flag any
> missing/extra field.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec 'src/pipelines/__tests__/stepper.test.ts'`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/pipelines/stepper.ts packages/llm-agent-server-libs/src/pipelines/__tests__/stepper.test.ts packages/llm-agent-server-libs/src/pipelines/__tests__/fixtures.ts
git commit -m "feat(pipelines): built-in stepper pipeline plugin"
```

### Task 8: DAG pipeline plugin

**Files:**
- Create: `packages/llm-agent-server-libs/src/pipelines/dag.ts`
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/dag.test.ts`

- [ ] **Step 1: Write the failing test** (mirror Task 7's test, `name='dag'`, config `{ planner: { type: 'llm' } }`).

- [ ] **Step 2: Run → FAIL** (module missing).

- [ ] **Step 3: Write the plugin** — DAG deps need building from raw YAML via the
relocated `buildDagCoordinatorDeps` using ctx materials:

```ts
import type { IPipelineInstance, IPipelinePlugin } from '@mcp-abap-adt/llm-agent';
import { DagCoordinatorHandler } from '@mcp-abap-adt/llm-agent-libs';
import { buildDagCoordinatorDeps } from '../smart-agent/build-dag-coordinator-deps.js';
import type { IServerPipelineContext } from './server-context.js';

/** Config = the raw `coordinator:` (DAG) YAML block, validated by parseConfig. */
export type DagPipelineConfig = Record<string, unknown>;

export class DagPipelinePlugin implements IPipelinePlugin<DagPipelineConfig> {
  readonly name = 'dag';

  parseConfig(raw: unknown): DagPipelineConfig {
    const cfg = (raw ?? {}) as Record<string, unknown>;
    if (cfg.planner === undefined) {
      throw new Error("pipeline 'dag' requires a 'planner' in its config");
    }
    return cfg;
  }

  async build(cfg: DagPipelineConfig, ctx: IServerPipelineContext): Promise<IPipelineInstance> {
    const deps = await buildDagCoordinatorDeps({
      coordCfg: cfg,
      llmMap: ctx.llmMap,
      pipelineFallback: ctx.pipelineFallback,
      mainLlm: ctx.mainLlm,
      helperLlm: ctx.helperLlm,
      mainTemp: ctx.mainTemp,
      registry: ctx.workerRegistry,
      makeLlm: (c) => ctx.makeLlm(c),
      warn: (m) => ctx.warn(m),
    });
    if (!deps) throw new Error("pipeline 'dag': buildDagCoordinatorDeps returned undefined");
    const handler = new DagCoordinatorHandler(deps);
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
```

> `BuildDagCoordinatorDepsInput` (build-dag-coordinator-deps.ts) is exactly this
> shape — `tsc` verifies it. `withStepperCoordinator` is the generic
> register-coordinator path (it sets the `coordinator` stage handler).

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(pipelines): built-in dag pipeline plugin`.

### Task 9: Linear pipeline plugin

**Files:**
- Create: `packages/llm-agent-server-libs/src/pipelines/linear.ts`
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/linear.test.ts`

- [ ] **Step 0: Add `parseLinearConfig` to the parser facade** (`parsers.ts`). It
is NEW (no config.ts original), so define it here now — wrapping the exported
resolvers (`resolveCoordinatorPlanning`/`resolveCoordinatorDispatchKind`/
`resolveCoordinatorDispatch`/`resolveCoordinatorActivation`, all exported from
`config.ts:280-353`):

```ts
// append to packages/llm-agent-server-libs/src/pipelines/parsers.ts
import type { CoordinatorHandlerDeps } from '@mcp-abap-adt/llm-agent-libs';
import {
  resolveCoordinatorPlanning,
  resolveCoordinatorDispatch,
  resolveCoordinatorDispatchKind,
} from '../smart-agent/config.js';
import type { IServerPipelineContext } from './server-context.js';

export async function parseLinearConfig(
  cfg: Record<string, unknown>,
  ctx: IServerPipelineContext,
): Promise<CoordinatorHandlerDeps> {
  const plannerLlm = await ctx.resolveLlm('planner');
  const planningKind = (cfg.planning as string) ?? 'one-shot';
  const dispatchKind = resolveCoordinatorDispatchKind(cfg.dispatch as string | undefined);
  return {
    planning: resolveCoordinatorPlanning(planningKind, plannerLlm),
    dispatch: resolveCoordinatorDispatch(dispatchKind, plannerLlm, undefined),
    maxSteps: (cfg.maxSteps as number) ?? 10,
    maxRetriesPerStep: (cfg.maxRetriesPerStep as number) ?? 1,
    failPolicy: ((cfg.failPolicy as 'abort' | 'continue') ?? 'abort'),
  };
}
```

> Verify `resolveCoordinatorDispatch`'s 3rd arg (the context-builder) against
> `config.ts:310` — pass `undefined` if it is optional, else thread the builder
> the server uses. `tsc` flags a mismatch. (`resolveCoordinatorActivation` is for
> the `coordinator-activate` stage, wired by the builder, not this deps object.)

- [ ] **Step 1–2:** failing test (`name='linear'`, config `{ planning: 'one-shot', dispatch: 'self' }`), run → FAIL.

- [ ] **Step 3: Write the plugin** — linear builds `CoordinatorHandlerDeps` via the
`parseLinearConfig` facade helper and wraps `LinearFactory`:

```ts
import type { IPipelineInstance, IPipelinePlugin } from '@mcp-abap-adt/llm-agent';
import type { CoordinatorHandlerDeps } from '@mcp-abap-adt/llm-agent-libs';
import { LinearFactory } from '../factories/index.js';
import { parseLinearConfig } from './parsers.js'; // relocated resolver wrapper
import type { IServerPipelineContext } from './server-context.js';

export type LinearPipelineConfig = Record<string, unknown>;

export class LinearPipelinePlugin implements IPipelinePlugin<LinearPipelineConfig> {
  readonly name = 'linear';

  parseConfig(raw: unknown): LinearPipelineConfig {
    return (raw ?? {}) as Record<string, unknown>;
  }

  async build(cfg: LinearPipelineConfig, ctx: IServerPipelineContext): Promise<IPipelineInstance> {
    const deps: CoordinatorHandlerDeps = await parseLinearConfig(cfg, ctx); // resolves planning/dispatch + reads maxSteps/etc.
    const { handler } = await new LinearFactory().build(deps, {
      makeRoleLlm: (role) => ctx.resolveLlm(role),
      callMcp: (n, a, s) => ctx.callMcp(n, a, s).then(String),
    });
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
```

> `parseLinearConfig(cfg, ctx)` is the Step-0 helper in `parsers.ts`; it returns a
> `CoordinatorHandlerDeps { planning, dispatch, maxSteps, maxRetriesPerStep,
> failPolicy }` (the verbatim shape from `coordinator.ts:31-37`).

- [ ] **Step 4: Run → PASS. Step 5: Commit** `feat(pipelines): built-in linear pipeline plugin`.

### Task 10: Flat pipeline plugin

**Files:**
- Create: `packages/llm-agent-server-libs/src/pipelines/flat.ts`
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/flat.test.ts`

- [ ] **Step 1–2:** failing test (`name='flat'`, config `{}`), run → FAIL.

- [ ] **Step 3: Write the plugin** — no coordinator at all:

```ts
import type { IPipelineInstance, IPipelinePlugin } from '@mcp-abap-adt/llm-agent';
import type { IServerPipelineContext } from './server-context.js';

export class FlatPipelinePlugin implements IPipelinePlugin<Record<string, never>> {
  readonly name = 'flat';
  parseConfig(): Record<string, never> { return {}; }
  async build(_cfg: Record<string, never>, ctx: IServerPipelineContext): Promise<IPipelineInstance> {
    const builder = await ctx.createAgentBuilder(); // no with*Coordinator → plain tool-loop
    const handle = await builder.build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
```

- [ ] **Step 4: Run → PASS. Step 5: Commit** `feat(pipelines): built-in flat pipeline plugin`.

## Phase 4 — Legacy namespace + subpath exports

### Task 11: `legacy/*` curated re-export bundles

**Files:** create `packages/llm-agent-server-libs/src/legacy/{flat,linear,dag,stepper}.ts`.

- [ ] **Step 1: Write the files (re-exports only)**

```ts
// src/legacy/dag.ts
export { DagCoordinatorHandler } from '@mcp-abap-adt/llm-agent-libs';
export { buildDagCoordinatorDeps } from '../smart-agent/build-dag-coordinator-deps.js';
export { DagFactory } from '../factories/index.js';
```
```ts
// src/legacy/stepper.ts
export { StepperCoordinatorHandler } from '../smart-agent/stepper-coordinator-handler.js';
export { buildStepperRoot, buildFromComposition } from '../smart-agent/build-stepper-root.js';
export { CyclicFactory, PlannedFactory, DeepStepperFactory, buildStepperCoordinator } from '../factories/index.js';
export { parseStepperCoordinatorConfig } from '../pipelines/parsers.js'; // facade — survives the Task-16 move
```
```ts
// src/legacy/linear.ts
export { CoordinatorHandler } from '@mcp-abap-adt/llm-agent-libs';
export { LinearFactory } from '../factories/index.js';
```
```ts
// src/legacy/flat.ts
// No coordinator; expose the builder so a consumer can compose a flat agent.
export { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
```

- [ ] **Step 2: Build to verify the re-exports resolve**

Run: `cd /home/okyslytsia/prj/llm-agent && npm run build`
Expected: clean compile (any unresolved symbol = wrong import path; fix it).

- [ ] **Step 3: Commit** `feat(pipelines): legacy/* curated re-export bundles`.

### Task 12: subpath `exports` in package.json

**Files:** modify `packages/llm-agent-server-libs/package.json`.

- [ ] **Step 1: Replace the single `.` export with subpaths**

```jsonc
"exports": {
  ".":               { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./flat":          { "types": "./dist/pipelines/flat.d.ts",   "default": "./dist/pipelines/flat.js" },
  "./linear":        { "types": "./dist/pipelines/linear.d.ts", "default": "./dist/pipelines/linear.js" },
  "./dag":           { "types": "./dist/pipelines/dag.d.ts",    "default": "./dist/pipelines/dag.js" },
  "./stepper":       { "types": "./dist/pipelines/stepper.d.ts","default": "./dist/pipelines/stepper.js" },
  "./legacy/flat":   { "types": "./dist/legacy/flat.d.ts",    "default": "./dist/legacy/flat.js" },
  "./legacy/linear": { "types": "./dist/legacy/linear.d.ts",  "default": "./dist/legacy/linear.js" },
  "./legacy/dag":    { "types": "./dist/legacy/dag.d.ts",     "default": "./dist/legacy/dag.js" },
  "./legacy/stepper":{ "types": "./dist/legacy/stepper.d.ts", "default": "./dist/legacy/stepper.js" }
}
```

- [ ] **Step 2: Build + verify subpath resolution**

Run: `cd /home/okyslytsia/prj/llm-agent && npm run build`
Then: `node -e "import('@mcp-abap-adt/llm-agent-server-libs/legacy/dag').then(m=>console.log(Object.keys(m)))"`
Expected: prints `[ 'DagCoordinatorHandler', 'buildDagCoordinatorDeps', 'DagFactory' ]`.

- [ ] **Step 3: Commit** `feat(pipelines): subpath exports for built-in + legacy bundles`.

## Phase 5 — Host integration (refactor of `smart-server.ts` + `config.ts`)

> These edit the live large files. Each gives the target behavior + the test +
> exact anchors. Plugins load at `smart-server.ts:1058` (BEFORE RAG at `:1084`).

### Task 13: serverCtx wiring + empty `toolsRag` (F3)

- [ ] **Step 1: Define the empty tools-RAG handle**

In `smart-server.ts` (module scope), add the always-present empty handle so
`IServerPipelineContext.toolsRag` is never `undefined`:

```ts
import type { IToolsRagHandle } from '@mcp-abap-adt/llm-agent';
const EMPTY_TOOLS_RAG: IToolsRagHandle = {
  query: async () => [],
  lookup: () => undefined,
};
```

- [ ] **Step 2: Test (no-RAG/no-MCP)** — assert `createServerPipelineContext(...).toolsRag`
satisfies both members:

```ts
const ctx = server.createServerPipelineContext({ sessionId: 's', parts });
assert.deepEqual(await ctx.toolsRag.query('x'), []);
assert.equal(ctx.toolsRag.lookup('x'), undefined);
```

- [ ] **Step 3:** wire `createServerPipelineContext` (Task 6) to use
`this.toolsRagHandle ?? EMPTY_TOOLS_RAG`.
- [ ] **Step 4: build + test → PASS. Step 5: Commit** `feat(server): empty toolsRag + serverCtx`.

### Task 14: pipeline registry + `plugin.build` (replace the coordinator gate)

- [ ] **Step 1: Build the registry**

After plugins are loaded (~`:1058`), assemble:

```ts
const builtins: IPipelinePlugin[] = [
  new FlatPipelinePlugin(), new LinearPipelinePlugin(),
  new DagPipelinePlugin(), new StepperPipelinePlugin(),
];
const registry = new Map<string, IPipelinePlugin>();
for (const p of builtins) registry.set(p.name, p);
for (const [name, p] of plugins.pipelinePlugins) {
  if (registry.has(name)) throw new Error(`pipeline name '${name}' from a plugin collides with a built-in`);
  registry.set(name, p);
}
```

- [ ] **Step 2: Resolve + build, replacing the gate**

Replace the 3-way coordinator gate (`smart-server.ts:1267-1628`) AND the
per-session coordinator re-wire (`buildSessionAgent` `:2098-2212` coordinator part)
with:

```ts
const name = this.cfg.pipeline?.name ?? 'flat';
const plugin = registry.get(name);
if (!plugin) throw new Error(`unknown pipeline '${name}'; available: ${[...registry.keys()].join(', ')}`);
const cfg = plugin.parseConfig(this.cfg.pipeline?.config ?? {});
const inst = await plugin.build(cfg, this.createServerPipelineContext({ sessionId, parts }));
// inst.agent → serve; inst.close() → on session dispose / shutdown.
```

- [ ] **Step 3: Lifecycle** — hold `inst` per session; on shutdown / before recreate
call `inst.close()`; on LLM hot-swap, if `'reconfigure' in inst.agent` call it, else
`inst.close()` + rebuild.

- [ ] **Step 4: Gated integration test** — reuse `dag-coordinator-mcp.integration.test.ts`
harness with `pipeline: { name: 'dag', config: {...} }`; assert a request streams.

- [ ] **Step 5: Commit** `feat(server): pipeline registry replaces coordinator gate`.

### Task 15: `plugins: [<specifier>]` loader + startup order

- [ ] **Step 1: Config field** — add `plugins?: string[]` to `SmartServerConfig` and
its YAML parse.

- [ ] **Step 2: Load before RAG** — at the existing plugin-load site (`:1058`),
after the `pluginDir` scan, for each specifier:

```ts
import { createRequire } from 'node:module';
const requireFromCwd = createRequire(`${process.cwd()}/`);
for (const spec of this.cfg.plugins ?? []) {
  const resolved = spec.startsWith('.') || spec.startsWith('/')
    ? spec : requireFromCwd.resolve(spec);          // cwd-based resolution
  const mod = (await import(resolved)) as PluginExports;
  mergePluginExports(plugins, mod, spec);           // full PluginExports, like pluginDir
}
```

This keeps the load BEFORE RAG/embedder (`:1084`), so plugin `embedderFactories`/
`mcpClients` are visible. Duplicate pipeline names fail-fast via the Task-4 merge.

- [ ] **Step 3: Test** — a fixture package exporting `pipelinePlugins` + an
`embedderFactories` entry; assert both register (the pipeline resolvable, the
factory in `plugins.embedderFactories`).

- [ ] **Step 4: Commit** `feat(server): plugins:[specifier] dynamic loader (cwd resolution)`.

### Task 16: config clean break + parser relocation (F2/F4)

- [ ] **Step 1: Fill the parser facade.** `parsers.ts` already exists (Task 7
Step 0 = re-export facade; Task 9 Step 0 added `parseLinearConfig`). Now **physically
MOVE** the bodies in so it stops re-exporting from `config.ts`:
  - move `parseStepperCoordinatorConfig` (+ `StepperCoordinatorConfig`, `MODE_FLOW_PRESET`) from `config.ts:1586-1750`/`:1440-1447` INTO `parsers.ts`, replacing the Step-0 `export { … } from '../smart-agent/config.js'` line with the real definitions;
  - keep `parseLinearConfig` (already here); the resolvers it calls stay exported from `config.ts` (they are generic helpers, not coordinator dispatch).
  Importers (plugins Tasks 7/9, legacy Task 11) already point at `parsers.js` — **no importer changes**, and the build stays green because the move + the gate removal (Step 2) happen together.

- [ ] **Step 2: Remove top-level coordinator dispatch** from `config.ts`/`smart-server.ts`:
  delete `usesStepper` (`smart-server.ts:883-896`) and `assertCoordinatorConfigShape`
  (`config.ts:231-278`). Keep `YamlCoordinator` (schema, still used by parsers).

- [ ] **Step 3: pipeline.stages — schema-only, no parser to remove.** Verified: the
runtime never parses/executes `pipeline.stages` (it is a declared-but-unused schema
field; `DefaultPipeline` builds its own stages). So **leave `StageDefinition`
untouched** and simply drop the `stages?` field + its docs/examples from the
`PipelineConfig` schema (`pipeline.ts:98`) if desired. Do NOT touch
`packages/llm-agent/src/interfaces/pipeline.ts:49` (internal `StageDefinition`) or
`default-pipeline.ts`.

- [ ] **Step 4: Add `pipeline:` config** — `pipeline?: { name: string; config?: Record<string, unknown> }`
on `SmartServerConfig` + YAML parse. Update `examples/*/smart-server.yaml` to the
new `pipeline:`/`plugins:` form.

- [ ] **Step 5: build + test** the package; **Step 6: Commit** `feat(config): pipeline:/plugins: schema; relocate parsers; remove coordinator dispatch`.

## Phase 6 — Conformance

### Task 17: registry conformance + duplicate fail-fast

**Files:** create `packages/llm-agent-server-libs/src/pipelines/__tests__/conformance.test.ts`.

- [ ] **Step 1: Write the test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyLoadedPlugins, mergePluginExports } from '@mcp-abap-adt/llm-agent-libs';
import { FlatPipelinePlugin } from '../flat.js';
import { LinearPipelinePlugin } from '../linear.js';
import { DagPipelinePlugin } from '../dag.js';
import { StepperPipelinePlugin } from '../stepper.js';
import { fakeServerCtx } from './fixtures.js';

const BUILTINS = [
  new FlatPipelinePlugin(), new LinearPipelinePlugin(),
  new DagPipelinePlugin(), new StepperPipelinePlugin(),
];
const MIN_CFG: Record<string, unknown> = {
  flat: {}, linear: { planning: 'one-shot', dispatch: 'self' },
  dag: { planner: { type: 'llm' } }, stepper: { mode: 'planned-react' },
};

describe('built-in pipeline conformance', () => {
  for (const p of BUILTINS) {
    it(`${p.name}: parseConfig → build → stream → close`, async () => {
      const cfg = p.parseConfig(MIN_CFG[p.name]);
      const inst = await p.build(cfg, fakeServerCtx());
      assert.equal(typeof inst.agent.streamProcess, 'function');
      await inst.close();
    });
  }

  it('duplicate pipeline name across sources fails fast (stable contract)', () => {
    const r = emptyLoadedPlugins();
    const mk = (n: string) => ({ pipelinePlugins: { [n]: new DagPipelinePlugin() } });
    mergePluginExports(r, mk('dag'), 'pkg-a');
    mergePluginExports(r, mk('dag'), 'pkg-b');
    const dupe = r.errors.find(
      (e) => e.error.includes("'dag'") && e.error.includes('pkg-a') && e.error.includes('pkg-b'),
    );
    assert.ok(dupe, 'expected a duplicate error naming the pipeline and both sources');
  });
});
```

- [ ] **Step 2: Run → PASS (5 tests). Step 3: Commit** `test(pipelines): registry conformance + duplicate fail-fast`.

---


## Self-Review

**1. Spec coverage:**
- §1 core idea / §5 contract → Tasks 1–3 (IPipelinePlugin, IPipelineInstance, IPipelineContext, IReconfigurableSmartAgent, MaybePromise). ✓
- §5 server context + `createAgentBuilder` → Tasks 5–6 (IServerPipelineContext, extraction). ✓
- §6 built-ins as factory → BuiltCoordinator → builder wrappers → Tasks 7–10. ✓
- §7 loader plumbing (LoadedPlugins, merge reject-duplicate, source tracking) → Tasks 3–4. ✓
- §7/§7.1 host registry + `plugins:` loader + cwd resolution + startup order → Tasks 14–15. ✓
- §7 lifecycle (build per session, close, recreate, reconfigure feature-detect) → Tasks 1, 6, 14. ✓
- §5 empty `toolsRag` for no-RAG/no-MCP (F3) → Task 13. ✓
- §8 legacy/* + subpath exports → Tasks 11–12. ✓
- §9 YAML `pipeline:`/`plugins:` parsing + responsibility split → Tasks 15–16. ✓
- §10 testing → Tasks 4, 7–10, 17. ✓
- §11 migration / clean break (remove `coordinator:` + YAML `pipeline.stages`; KEEP internal StageDefinition, F4) → Task 16. ✓

**2. Placeholder scan:** All tasks now carry complete code (the contract types,
loader merge, every built-in plugin, the legacy bundles, the exports map, the
conformance test) **or**, for the three that edit the live ~3000-line
`smart-server.ts`/`config.ts` (Tasks 6, 13–16), the **target signatures + the test
+ exact source anchors + the precise field lists to thread/remove**. The latter
are in-place refactors, not greenfield files, so they specify the transformation
rather than a from-scratch listing — by design, not a content gap.

**3. Type consistency:** Symbols are consistent across tasks — `IPipelineInstance`
(`{ agent, close() }`), `IPipelinePlugin` (`name` / `parseConfig` / `build`),
`IPipelineContext` (`resolveLlm`, `knowledgeRagFor: MaybePromise`, `toolsRag`,
`mintTurnId`), `IServerPipelineContext` (adds `createAgentBuilder` + the dag/linear
materials `makeLlm`/`llmMap`/`mainLlm`/`workerRegistry`/`warn`), `BuiltCoordinator
{ handler }` wired via `builder.withStepperCoordinator(handler)`,
`StepperFactoryDeps.knowledgeRagFor` wrapped to `Promise` (F2),
`LoadedPlugins.pipelinePlugins` + `pipelinePluginSources`. The duplicate-merge
**contract** (the error names the pipeline + both sources) is what Task 4 asserts
and Task 17 re-asserts — both check `includes(name)` + both sources, **not** a
brittle exact phrase.

**4. Open assumptions to verify during implementation (tsc will catch each):**
- The `IServerPipelineContext` libs-service fields and `SmartAgentBuilder` import
  resolve from `@mcp-abap-adt/llm-agent-libs`; if a service interface is not
  exported there, export it at source (do not duplicate).
- The `StepperFactoryConfig` field set in Task 7 matches
  `Omit<StepperCompositionSpec,'planner'|'executor'>` exactly.
- `BuildDagCoordinatorDepsInput` (Task 8) and `CoordinatorHandlerDeps` (Task 9)
  match the verbatim shapes captured from the codebase.

> **Note on scope:** Phase 1–2 (Tasks 0–4) is a complete, shippable, tested
> foundation. Phase 3 (Tasks 5–10) and Phase 4/6 (Tasks 11–12, 17) are full code.
> Phase 5 (Tasks 13–16) + the keystone Task 6 are in-place refactors of
> `smart-server.ts`/`config.ts` specified by target + test + anchors; run
> `npm run build` after each so `tsc` validates the threading.
