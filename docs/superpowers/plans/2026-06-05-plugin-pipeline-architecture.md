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

This plan is organized in phases. **Phase 1–2 (Tasks 0–4)** are fully specified
with complete TDD code — they form a self-contained, compilable, testable
foundation (the contract layer + loader support that everything else depends on).
**Phases 3–6 (Tasks 5–17)** build on that foundation; their entry points are
identified concretely from the codebase, with file:line anchors.

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
// packages/llm-agent/tsconfig.test.json — type-check sources INCLUDING tests.
// Build still uses tsconfig.json (which excludes tests); this is gate-only.
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*"],
  "exclude": ["dist"]
}
```

- [ ] **Step 2: Verify it type-checks the package as-is (baseline green)**

Run: `cd packages/llm-agent && npx tsc -p tsconfig.test.json --noEmit`
Expected: PASS (no test files referencing missing types yet).

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

## Phases 3–6 — Built-ins, legacy, host, conformance (roadmap → expand to TDD)

> **Status / scope honesty (plan-review F5):** Phases 1–2 above are full executable
> TDD. Phases 3–6 below are a **grounded roadmap**, not yet bite-sized TDD — they
> rewrite sections of the ~3000-line `smart-server.ts` and must be expanded into
> step-by-step tasks against a close read **before** an agentic worker runs them.
> The wiring below is verified from the codebase (the plan-review corrections
> F1–F4 are folded in); the design spec is the source of truth.
>
> **Keystone correction (F1/F2 — builder ownership, decided):** the existing
> factories return `BuiltCoordinator { handler: IStageHandler }` (the coordinator
> stage handler) — **NOT** a `SmartAgentHandle`. The agent variant is determined
> ONLY by which coordinator handler is wired; all other infra
> (RAG/MCP/embedder/adapters/request-logger/subagents/options) is assembled
> identically by the host. Therefore the host owns assembly and exposes it to
> plugins via `IServerPipelineContext.createAgentBuilder()` (spec §5).

### Task 5: `IServerPipelineContext` + `createAgentBuilder` (spec §5)

- Create `packages/llm-agent-server-libs/src/pipelines/server-context.ts` exporting
  `IServerPipelineContext extends IPipelineContext` (from `@mcp-abap-adt/llm-agent`)
  adding: the libs services `sessionManager?`/`tracer?`/`metrics?`/`toolCache?`/
  `toolPolicy?`/`outputValidator?` (imported from `@mcp-abap-adt/llm-agent-libs`)
  **and** `createAgentBuilder(): Promise<SmartAgentBuilder>` (the builder pre-wired
  with all shared infra EXCEPT the coordinator).
- Test: shape test mirroring Task 1 (assert `createAgentBuilder` is a function).

### Task 6 (keystone): extract `createAgentBuilder` from smart-server.ts

This is the load-bearing refactor; do it before the built-in plugins.
- In `smart-server.ts`, the builder assembly is lines **~1091–1259** (everything
  from `new SmartAgentBuilder(...)` through `.withSubAgents(...)`) followed by the
  **3-way coordinator gate at ~1267–1628** and `builder.build()` at **~1631**. The
  per-session variant is `buildSessionAgent` at **~2098–2212**.
- Extract the assembly **up to but excluding** the coordinator gate into a private
  method `private buildBaseBuilder(parts): SmartAgentBuilder` used by BOTH the
  startup path and `buildSessionAgent` (DRY — they wire the same `withXxx` set).
- The server's `IServerPipelineContext.createAgentBuilder` delegates to
  `buildBaseBuilder(...)` for the current (session) scope.
- Test: an integration-style test (gated like the existing
  `dag-coordinator-mcp.integration.test.ts`) asserting a built base builder
  produces a working agent for a no-coordinator config.

### Tasks 7–10: Built-in pipeline plugins (spec §6) — one per variant

Under `packages/llm-agent-server-libs/src/pipelines/<flow>.ts`. Each
`IPipelinePlugin` uses the **factory → BuiltCoordinator → builder** flow:

```ts
// dag.ts (pattern; linear/stepper analogous)
export class DagPipelinePlugin implements IPipelinePlugin<DagCoordinatorHandlerDeps> {
  readonly name = 'dag';
  parseConfig(raw: unknown): DagCoordinatorHandlerDeps { /* validate dag dialect */ }
  async build(cfg: DagCoordinatorHandlerDeps, ctx: IServerPipelineContext): Promise<IPipelineInstance> {
    const { handler } = await new DagFactory().build(cfg, {
      makeRoleLlm: ctx.resolveLlm,
      callMcp: async (n, a, s) => String(await ctx.callMcp(n, a, s)),
    });
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
```

- `parseConfig` per variant calls the **relocated** parser (moved to
  `src/pipelines/parsers.ts` in Task 16, not deleted): `linear` → linear
  `YamlCoordinator` field reader → `CoordinatorHandlerDeps`; `dag` → the DAG deps
  reader → `DagCoordinatorHandlerDeps`; `stepper` → `parseStepperCoordinatorConfig`
  → `StepperCompositionSpec`, with the three modes selecting
  `CyclicFactory`/`PlannedFactory`/`DeepStepperFactory` and `StepperFactoryConfig`;
  `flat` → no factory and no parser: `(await ctx.createAgentBuilder()).build()`
  directly (no coordinator).
- Stepper plugins pass the richer `StepperFactoryDeps` (`knowledgeRagFor`,
  `toolsRag`, `mintStepperId`, `mintTurnId`, `subagents`, `logLlmCall`) — all from `ctx`.
- `withStepperCoordinator(handler)` is the builder's generic register-coordinator
  path; any factory's `BuiltCoordinator.handler` registers through it.
- Each task: unit test — `parseConfig(fixture)` → `build(stubServerCtx)` (stub
  `createAgentBuilder` to return a builder over fake LLM/MCP) → `inst.agent.streamProcess`
  → `inst.close()`.

### Tasks 11–12: legacy/* relocation + subpath exports (spec §8)

- **Task 11:** create `packages/llm-agent-server-libs/src/legacy/{flat,linear,dag,stepper}.ts`,
  each re-exporting the low-level classes for that flow (`DagCoordinatorHandler`,
  `StepperCoordinatorHandler`, `Stepper`, `CoordinatorHandler`, `CyclicReActExecutor`,
  `buildStepperRoot`, `buildDagCoordinatorDeps`, the factories). Re-exports only.
- **Task 12:** replace the single `.` export in
  `packages/llm-agent-server-libs/package.json` with subpath `exports` for `.`,
  `./flat`, `./linear`, `./dag`, `./stepper`, `./legacy/flat`, `./legacy/linear`,
  `./legacy/dag`, `./legacy/stepper` (spec §8 has the exact map). Verify
  `npm run build` then `node -e "import('@mcp-abap-adt/llm-agent-server-libs/legacy/dag').then(m=>console.log(Object.keys(m)))"`.

### Tasks 13–16: Host integration (spec §7, §7.1, §9, §11)

In `smart-server.ts` + `config.ts`. Plugins load at `:1058` (before RAG `:1084`).

- **Task 13 (empty toolsRag + serverCtx, F3):** build the `IServerPipelineContext`
  the host passes to plugins. `resolveLlm` closes over the role-LLM map;
  `createAgentBuilder` = Task 6; `knowledgeRagFor`/`toolsRag`/`mintStepperId`/
  `mintTurnId` from the existing session wiring. **`toolsRag` is always present**:
  when no tools RAG is configured, supply an **empty `IToolsRagHandle`** (a handle
  whose query returns `[]`) so the contract never yields `undefined`. Test: a
  no-RAG/no-MCP config still yields a working `ctx.toolsRag` (query returns `[]`).
- **Task 14 (registry + build, replaces gate):** build `Map<string, IPipelinePlugin>`
  = 4 built-ins (static) + `LoadedPlugins.pipelinePlugins`; resolve `pipeline.name`;
  `parseConfig` then `build(serverCtx)`. **Replace** the 3-way coordinator gate
  (`:1267-1628`) AND the per-session coordinator re-wire in `buildSessionAgent`
  (`:2098-2212`) with `const cfg = plugin.parseConfig(yaml.pipeline.config); const inst = await plugin.build(cfg, sessionCtx)`.
  Unknown name → fail-fast listing available names.
- **Task 15 (`plugins:` loader + order):** add `plugins: string[]` to the config;
  resolve each specifier with `createRequire(process.cwd())` / `import.meta.resolve`
  (cwd base) + absolute-path support; `await import()` and route the **full module**
  through `mergePluginExports()` **alongside** `pluginDir`, **before** RAG/embedder
  build (preserve the `:1058`-before-`:1084` order). Duplicate names fail-fast via
  the Task-4 merge.
- **Task 16 (config clean break, F2 + F4):** the variant config parsers are
  **relocated, not deleted** (F2) — the built-in plugins (Tasks 7–10) own their
  `parseConfig`, so the parsing logic must survive. Concretely:
  - **Relocate** the variant parsers into a shared module the plugins import — e.g.
    `packages/llm-agent-server-libs/src/pipelines/parsers.ts` — moving
    `parseStepperCoordinatorConfig` (`config.ts:1586-1750`), `MODE_FLOW_PRESET`
    (`:1440-1447`), the linear `YamlCoordinator` field reader (`:159-167`), and the
    DAG deps reader. Each plugin's `parseConfig` calls its relocated parser.
  - **Remove** from `config.ts` only the **top-level `coordinator:` dispatch** —
    the `usesStepper()` gate, the 3-way selection, and
    `assertCoordinatorConfigShape` (`:231-278`) — i.e. the SERVER-level orchestration
    that chose a coordinator, not the per-variant field parsing.
  - **Remove** the **YAML `pipeline.stages` authoring path** — but **KEEP** the
    internal `StageDefinition` type (`packages/llm-agent/src/interfaces/pipeline.ts:49`)
    and `DefaultPipeline`'s stage executor (`default-pipeline.ts:314`); they run
    every agent's request pipeline (F4).
  - **Add** `pipeline: { name, config }` + `plugins: string[]` parsing. Update
    example YAMLs under `examples/`.

### Task 17: Conformance + generic-host test (spec §10)

- Create `packages/llm-agent-server-libs/src/pipelines/__tests__/conformance.test.ts`:
  iterate the built-in registry — each must `parseConfig` a minimal config, `build`
  an `IPipelineInstance` (stub `createAgentBuilder`/LLM/MCP), `streamProcess` a
  trivial request, and `close()` cleanly. Add a negative case asserting duplicate
  pipeline names across two sources produce a fail-fast error — assert on the same
  stable contract as Task 4 (the error `includes(name)` + both source ids), not a
  fixed phrase (reuse the Task-4 merge).

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

**2. Placeholder scan:** Phases 1–2 (Tasks 1–4) contain complete code and exact
commands. Tasks 5–17 are a **grounded roadmap** (file:line anchors + the exact
factories/parsers/builder calls), explicitly flagged as needing bite-sized
expansion before execution — the planned phase boundary, not a hidden content gap.

**3. Type consistency:** Symbols are consistent across tasks — `IPipelineInstance`
(`{ agent, close() }`), `IPipelinePlugin` (`name` / `parseConfig` / `build`),
`IPipelineContext` (`resolveLlm`, `knowledgeRagFor: MaybePromise`, `toolsRag`),
`IServerPipelineContext` (adds `createAgentBuilder`), `BuiltCoordinator { handler }`
wired via `builder.withStepperCoordinator(handler)`,
`LoadedPlugins.pipelinePlugins` + `pipelinePluginSources`. The duplicate-merge
**contract** (the recorded error names the pipeline + both sources) is what Task 4
asserts and Task 17 re-asserts — both check `includes(name)` + both sources, **not**
a brittle exact phrase, so the wording in the merge code can change freely.

> **Note on scope:** Phases 1–2 are a complete, shippable, tested foundation. Phases
> 3–6 (Tasks 5–17) carry the plan-review corrections (factories return
> `BuiltCoordinator` not `SmartAgentHandle`; host owns assembly via
> `createAgentBuilder`; empty `toolsRag`; internal `StageDefinition` stays) and
> should be expanded into their own bite-sized plan before implementation — the
> host integration (Tasks 13–16) rewrites sections of the ~3000-line
> `smart-server.ts`. The keystone is Task 6 (extract `createAgentBuilder`); the
> anchors make the rest mechanical.
