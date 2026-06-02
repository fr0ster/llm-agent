# Pipeline Builder-Factories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the library-grade guts of `@mcp-abap-adt/llm-agent-server` into a NEW importable package `@mcp-abap-adt/llm-agent-server-libs`, and within it expose each pipeline variant as a separate, self-contained, exportable builder-factory (`LinearFactory`, `DagFactory`, `CyclicFactory`, `PlannedFactory`, `DeepStepperFactory`) so they can be reused in other projects.

**Architecture:** Today `llm-agent-server` is a single package mixing a thin CLI/HTTP binary with the whole SmartServer composition runtime (which therefore cannot be imported elsewhere — the package is "binary only"). We split it: a new library package `llm-agent-server-libs` holds SmartServer + composition (`build-stepper-root`, `build-dag-coordinator-deps`, `stepper-coordinator-handler`, `config` parsing, sessions) + the five new factories; the binary package keeps only the CLI/HTTP entrypoints, the MCP transport glue, generated version, and the bundled provider deps, and depends on the new library. A uniform `IPipelineFactory` interface lives in contracts (`@mcp-abap-adt/llm-agent`). Because the factories live alongside the composition code, they wrap it **in place** — no code is lifted into core `llm-agent-libs`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Biome, `node --test` via `tsx`, lockstep workspace build (`npx tsc -b`), npm workspaces.

---

## Dependency chain (after)

```
llm-agent-server         (binary: cli.ts, check-models-cli.ts, server.ts HTTP, mcp/, generated/, agent.ts, smoke; bundles provider pkgs)
  └→ llm-agent-server-libs   (NEW library: SmartServer, build-stepper-root, build-dag-coordinator-deps,
  │                            stepper-coordinator-handler, config, sessions, pipeline.ts, factories/)  ← exported for reuse
  └→ llm-agent-libs          (core composition: Stepper, planners, executor, evaluator, handlers, builder)
       └→ {llm-agent-mcp, llm-agent-rag}
            └→ llm-agent     (contracts: I* interfaces, shared types)
```

## The five factories

| Factory | kind | wraps | spec preset |
|---|---|---|---|
| `LinearFactory` | `linear` | `CoordinatorHandler` (in `llm-agent-libs`) | — |
| `DagFactory` | `dag` | `DagCoordinatorHandler` (in `llm-agent-libs`) | — |
| `CyclicFactory` | `cyclic` | `StepperCoordinatorHandler` via `buildFromComposition` | `{planner:'none', executor:'cyclic-react'}` |
| `PlannedFactory` | `planned` | same | `{planner:'llm', executor:'cyclic-react'}` |
| `DeepStepperFactory` | `deep-stepper` | same | `{planner:'llm', executor:'recursive'}` |

`flow` and `gnostic` are NOT factories — `flow` is an explicit composition block, `gnostic` is a config with a domain `knowledgeSeed`; both are inputs to the Stepper factories. (`MODE_FLOW_PRESET`, `config.ts:1440`.)

## File Structure

**New package skeleton** (`packages/llm-agent-server-libs/`):
- `package.json` — name `@mcp-abap-adt/llm-agent-server-libs`, deps on `@mcp-abap-adt/llm-agent`, `-libs`, `-mcp`, `-rag`, `yaml`, `zod`; **library** exports (`main`/`types`/`exports` → `dist/index.js`).
- `tsconfig.json` — mirror `llm-agent-libs/tsconfig.json` (composite project).
- `src/index.ts` — public barrel.
- `src/smart-agent/**` — the MOVED modules (see Task 2).
- `src/factories/{cyclic,planned,deep-stepper,dag,linear}-factory.ts`, `src/factories/index.ts` — the new factories.

**Contracts:**
- Create `packages/llm-agent/src/interfaces/pipeline-factory.ts` — `IPipelineFactory`, `PipelineFactoryKind`, `BuiltCoordinator`, `PipelineFactoryDepsBase`.

**Binary (`packages/llm-agent-server/`):**
- Keep: `src/index.ts` (re-export from server-libs + binary helpers), `src/agent.ts`, `src/smoke-adapters.ts`, `src/mcp/**`, `src/generated/**`, `src/smart-agent/cli.ts`, `src/smart-agent/check-models-cli.ts`, `src/smart-agent/server.ts` (HTTP listen only).
- Modify `package.json` — add dep `@mcp-abap-adt/llm-agent-server-libs`; the moved modules are imported from there.

## Shared contracts type (Task 1 — referenced everywhere)

```ts
// packages/llm-agent/src/interfaces/pipeline-factory.ts
import type { IStageHandler } from './stage-handler.js';
import type { ILlm } from './llm.js';

export type PipelineFactoryKind = 'linear' | 'dag' | 'cyclic' | 'planned' | 'deep-stepper';

/** The built, ready-to-register `coordinator` stage handler for one pipeline. */
export interface BuiltCoordinator {
  handler: IStageHandler;
}

/** Deps shared by every factory. */
export interface PipelineFactoryDepsBase {
  /** Resolve+construct the LLM for a logical role ('planner'|'executor'|…). */
  makeRoleLlm: (role: string) => Promise<ILlm>;
  /** Invoke an MCP tool by name; returns its textual result. */
  callMcp: (name: string, args: unknown, signal?: AbortSignal) => Promise<string>;
}

export interface IPipelineFactory<TConfig = unknown> {
  readonly kind: PipelineFactoryKind;
  build(config: TConfig, deps: PipelineFactoryDepsBase): Promise<BuiltCoordinator>;
}
```

---

### Task 1: Uniform factory interface in contracts

**Files:**
- Create: `packages/llm-agent/src/interfaces/pipeline-factory.ts`
- Modify: `packages/llm-agent/src/index.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/pipeline-factory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuiltCoordinator, IPipelineFactory, PipelineFactoryDepsBase } from '../pipeline-factory.js';

test('IPipelineFactory: a stub factory satisfies the contract', async () => {
  const handler = { name: 'coordinator', async execute() { return true; } };
  const factory: IPipelineFactory<{ x: number }> = {
    kind: 'linear',
    async build() { return { handler } as BuiltCoordinator; },
  };
  const deps: PipelineFactoryDepsBase = {
    makeRoleLlm: async () => ({ name: 'stub', async chat() { return { ok: true, value: { content: '' } }; } }) as never,
    callMcp: async () => '',
  };
  const built = await factory.build({ x: 1 }, deps);
  assert.equal(built.handler.name, 'coordinator');
  assert.equal(factory.kind, 'linear');
});
```

- [ ] **Step 2: Run → FAIL** `cd packages/llm-agent && node --import tsx/esm --test src/interfaces/__tests__/pipeline-factory.test.ts` → `Cannot find module '../pipeline-factory.js'`.
- [ ] **Step 3: Create `pipeline-factory.ts`** with the "Shared contracts type" contents above. Verify `./stage-handler.js` and `./llm.js` are the real paths (`grep -rn "export interface IStageHandler\|export interface ILlm" packages/llm-agent/src/interfaces`); adjust imports if different.
- [ ] **Step 4: Export** — add `export * from './interfaces/pipeline-factory.js';` to `packages/llm-agent/src/index.ts`.
- [ ] **Step 5: Run → PASS** (same command).
- [ ] **Step 6: Build** `npx tsc -b packages/llm-agent` → exit 0.
- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent/src/interfaces/pipeline-factory.ts packages/llm-agent/src/index.ts packages/llm-agent/src/interfaces/__tests__/pipeline-factory.test.ts
git commit -m "feat(contracts): IPipelineFactory uniform interface for pipeline builder-factories"
```

---

### Task 2: Scaffold `llm-agent-server-libs` and move the composition modules

This is the largest task. Do it as one atomic commit so the build never sees a half-moved tree.

**Files:**
- Create: `packages/llm-agent-server-libs/package.json`, `tsconfig.json`, `src/index.ts`
- Move (git mv) from `packages/llm-agent-server/src/smart-agent/` → `packages/llm-agent-server-libs/src/smart-agent/`:
  `build-stepper-root.ts`, `build-dag-coordinator-deps.ts`, `stepper-coordinator-handler.ts`, `config.ts`, `pipeline.ts`, `smart-server.ts`, `resolve-agent-embedder.ts`, `jsonl-knowledge-backend.ts`, `session-identity-resolver.ts`, `session-meta-store.ts`, and their `__tests__/` (only the tests for moved modules).
- Keep in `packages/llm-agent-server/src/smart-agent/`: `cli.ts`, `check-models-cli.ts`, `server.ts`.
- Modify: root `tsconfig.json` build list (add the new project before `llm-agent-server`), root `package.json` `build`/`clean` scripts (add the new package path in dependency order), `packages/llm-agent-server/package.json` (add dep), `packages/llm-agent-server/src/smart-agent/{cli,check-models-cli,server}.ts` imports.

- [ ] **Step 1: Create `package.json`** for the new package:

```json
{
  "name": "@mcp-abap-adt/llm-agent-server-libs",
  "version": "18.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "tsc -p tsconfig.json --clean",
    "test": "node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'"
  },
  "dependencies": {
    "@mcp-abap-adt/llm-agent": "^18.0.0",
    "@mcp-abap-adt/llm-agent-libs": "^18.0.0",
    "@mcp-abap-adt/llm-agent-mcp": "^18.0.0",
    "@mcp-abap-adt/llm-agent-rag": "^18.0.0",
    "yaml": "^2.8.3",
    "zod": "^4.3.6"
  }
}
```

  (Match exact versions to the other packages — read `packages/llm-agent-libs/package.json` and copy its `version` + dependency version ranges.)

- [ ] **Step 2: Create `tsconfig.json`** — copy `packages/llm-agent-libs/tsconfig.json` verbatim, then adjust `references` to point at the packages this one depends on (`../llm-agent`, `../llm-agent-libs`, `../llm-agent-mcp`, `../llm-agent-rag`). Verify the shape against an existing composite tsconfig before writing.

- [ ] **Step 3: `git mv` the modules** listed above into `packages/llm-agent-server-libs/src/smart-agent/`. Use `git mv` so history follows.

- [ ] **Step 4: Fix intra-move imports.** The moved modules import each other by relative path — those still resolve (they moved together). Any import that pointed UP into binary-only files (`./cli.js`, `./server.js`, `./check-models-cli.js`) must be inverted: those binary files should import FROM the library, never the reverse. Grep for such edges: `grep -rn "from './cli\|from './server\|from './check-models" packages/llm-agent-server-libs/src` — expected: none (composition does not import the binary). If any exist, that symbol must stay in or move to the library.

- [ ] **Step 5: Write `src/index.ts`** re-exporting the public surface (SmartServer + build functions + handler + config parsers + spec types). Read the current `packages/llm-agent-server/src/index.ts` to see what was already public and mirror it:

```ts
export * from './smart-agent/smart-server.js';
export * from './smart-agent/build-stepper-root.js';
export * from './smart-agent/build-dag-coordinator-deps.js';
export * from './smart-agent/stepper-coordinator-handler.js';
export * from './smart-agent/config.js';
export * from './smart-agent/pipeline.js';
export * from './factories/index.js'; // added in Task 3+
```

  (Drop the `factories` line until Task 6 if it does not yet exist, or create an empty `factories/index.ts` now.)

- [ ] **Step 6: Wire the binary to the library.** In `packages/llm-agent-server/src/smart-agent/{cli,check-models-cli,server}.ts`, change imports of the moved modules from `./smart-server.js` etc. to `@mcp-abap-adt/llm-agent-server-libs`. Add the dependency to `packages/llm-agent-server/package.json`:

```json
"@mcp-abap-adt/llm-agent-server-libs": "^18.1.0",
```

  Update `packages/llm-agent-server/src/index.ts` to `export * from '@mcp-abap-adt/llm-agent-server-libs';` for back-compat of any existing import path.

- [ ] **Step 7: Wire the workspace build.** Add `packages/llm-agent-server-libs` to the root `package.json` `build` and `clean` tsc `-b` lists, positioned AFTER `llm-agent-libs`/`-mcp`/`-rag` and BEFORE `llm-agent-server`. Add it to the root `tsconfig` references if one exists.

- [ ] **Step 8: Install + build** `npm install && npm run build` → exit 0. (npm install links the new workspace.)

- [ ] **Step 9: Run moved tests** `cd packages/llm-agent-server-libs && npm test 2>&1 | tail -20` → all pass (behaviour unchanged, only location).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: extract llm-agent-server-libs (SmartServer composition) from the binary package"
```

---

### Task 3: `CyclicFactory`, `PlannedFactory`, `DeepStepperFactory`

**Files:**
- Create: `packages/llm-agent-server-libs/src/factories/{cyclic,planned,deep-stepper}-factory.ts`
- Test: `packages/llm-agent-server-libs/src/factories/__tests__/stepper-factories.test.ts`

The Stepper factories bake the `{planner,executor}` preset and delegate to the existing `buildFromComposition` (now in this package), then wrap the result in `StepperCoordinatorHandler`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CyclicFactory } from '../cyclic-factory.js';
import { PlannedFactory } from '../planned-factory.js';
import { DeepStepperFactory } from '../deep-stepper-factory.js';

const stubLlm = { name: 'stub', model: 'stub', async chat() { return { ok: true as const, value: { content: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }; } };
const deps = { makeRoleLlm: async () => stubLlm as never, callMcp: async () => '', mintStepperId: () => 'id', registry: new Map() };
const cfg = { granularity: 'coarse', finalizer: 'root', evaluatorEnabled: false, reviewerAtDepths: [], maxParallelSteps: 1, maxDepth: 2, tokenBudget: 100000, formalizeTask: false } as never;

test('CyclicFactory: kind=cyclic, builds a coordinator handler', async () => {
  assert.equal(new CyclicFactory().kind, 'cyclic');
  const built = await new CyclicFactory().build(cfg, deps);
  assert.equal(built.handler.name, 'coordinator');
});
test('PlannedFactory: kind=planned', () => assert.equal(new PlannedFactory().kind, 'planned'));
test('DeepStepperFactory: kind=deep-stepper', () => assert.equal(new DeepStepperFactory().kind, 'deep-stepper'));
```

- [ ] **Step 2: Run → FAIL** `cd packages/llm-agent-server-libs && node --import tsx/esm --test src/factories/__tests__/stepper-factories.test.ts` → `Cannot find module '../cyclic-factory.js'`.

- [ ] **Step 3: Implement `cyclic-factory.ts`** (verify `buildFromComposition` + its `BuildFromCompositionDeps` shape and `StepperCoordinatorHandler` ctor signature first — `grep -n "export async function buildFromComposition\|interface BuildFromCompositionDeps\|class StepperCoordinatorHandler" packages/llm-agent-server-libs/src/smart-agent/*.ts`):

```ts
import type { BuiltCoordinator, IPipelineFactory, IStepper, PipelineFactoryDepsBase } from '@mcp-abap-adt/llm-agent';
import { buildFromComposition, type BuildFromCompositionDeps, type StepperCompositionSpec } from '../smart-agent/build-stepper-root.js';
import { StepperCoordinatorHandler } from '../smart-agent/stepper-coordinator-handler.js';

export type StepperFactoryConfig = Omit<StepperCompositionSpec, 'planner' | 'executor'>;

export interface StepperFactoryDeps extends PipelineFactoryDepsBase {
  mintStepperId: () => string;
  logLlmCall?: BuildFromCompositionDeps['logLlmCall'];
  subagents?: BuildFromCompositionDeps['subagents'];
  registry?: ReadonlyMap<string, IStepper>;
}

// build-stepper-root's resolveRoleLlm chain uses llmMap/pipelineFallback/makeLlm.
// The factory bypasses that by passing a makeLlm that ignores its config arg and
// calls makeRoleLlm — but buildFromComposition resolves by ROLE, not by passing
// the role to makeLlm. Therefore Task 4 (below) FIRST refactors buildFromComposition
// to accept an optional `makeRoleLlm` that, when present, supersedes the
// llmMap/makeLlm resolution. This task depends on Task 4 being done first.

function build(spec: StepperCompositionSpec, deps: StepperFactoryDeps): Promise<BuiltCoordinator> {
  // see Task 4 for the makeRoleLlm wiring
  throw new Error('implemented after Task 4');
}

export class CyclicFactory implements IPipelineFactory<StepperFactoryConfig> {
  readonly kind = 'cyclic' as const;
  build(config: StepperFactoryConfig, deps: StepperFactoryDeps) {
    return build({ ...config, planner: 'none', executor: 'cyclic-react' } as StepperCompositionSpec, deps);
  }
}
```

  **NOTE / ordering correction:** the role-resolution wiring is non-trivial, so REORDER — do Task 4 (refactor `buildFromComposition` to accept `makeRoleLlm`) BEFORE finishing this file. With Task 4 in place, the `build()` helper becomes:

```ts
async function build(spec: StepperCompositionSpec, deps: StepperFactoryDeps): Promise<BuiltCoordinator> {
  const built = await buildFromComposition(spec, {
    makeRoleLlm: deps.makeRoleLlm,
    callMcp: deps.callMcp,
    mintStepperId: deps.mintStepperId,
    registry: deps.registry ?? new Map(),
    ...(deps.logLlmCall ? { logLlmCall: deps.logLlmCall } : {}),
    ...(deps.subagents ? { subagents: deps.subagents } : {}),
  } as BuildFromCompositionDeps);
  return { handler: new StepperCoordinatorHandler(built) };
}
```

  `planned-factory.ts` / `deep-stepper-factory.ts`: identical except `kind` and the baked preset (`{planner:'llm',executor:'cyclic-react'}` and `{planner:'llm',executor:'recursive'}`).

- [ ] **Step 4: Run → PASS** (same command, 3 tests).
- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/factories/
git commit -m "feat(server-libs): Cyclic/Planned/DeepStepper builder-factories"
```

---

### Task 4: Teach `buildFromComposition` to accept `makeRoleLlm` (do BEFORE finishing Task 3)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/build-stepper-root.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/build-stepper-root.test.ts` (add a case)

- [ ] **Step 1: Add a failing test** — building with only `makeRoleLlm` (no llmMap/makeLlm) succeeds:

```ts
test('buildFromComposition: makeRoleLlm supersedes llmMap/makeLlm resolution', async () => {
  const stub = { name: 'stub', model: 'stub', async chat() { return { ok: true as const, value: { content: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }; } };
  const built = await buildFromComposition(
    { planner: 'none', executor: 'cyclic-react', granularity: 'coarse', finalizer: 'root', evaluatorEnabled: false, reviewerAtDepths: [], maxParallelSteps: 1, maxDepth: 1, tokenBudget: 100000, formalizeTask: false } as never,
    { makeRoleLlm: async () => stub as never, callMcp: async () => '', mintStepperId: () => 'id', registry: new Map() } as never,
  );
  assert.ok(built.rootStepper);
});
```

- [ ] **Step 2: Run → FAIL** (currently `makeLlm` is required and `resolveRoleLlm` calls `resolveLlmConfig`/`makeLlm`).

- [ ] **Step 3: Refactor.** In `BuildFromCompositionDeps` make `makeLlm`, `llmMap`, `pipelineFallback` optional and add `makeRoleLlm?: (role: string) => Promise<ILlm>;`. In `resolveRoleLlm`, when `deps.makeRoleLlm` is set, use it; else fall back to the existing `resolveLlmConfig(llmMap, role, pipelineFallback) → makeLlm(cfg)` path:

```ts
const inner = deps.makeRoleLlm
  ? await deps.makeRoleLlm(role)
  : await deps.makeLlm!(resolveLlmConfig(llmMap, role, pipelineFallback) ?? STUB_LLM_CFG);
```

  (Keep the `LoggingLlm`/ledger wrapping below it unchanged. `model: inner.model ?? cfg.model` → `model: inner.model ?? 'unknown'` since `cfg` may be absent.)

- [ ] **Step 4: Run → PASS.** Then re-run the FULL existing `build-stepper-root` tests — the legacy `makeLlm` path must still pass (back-compat for the server adapter).
- [ ] **Step 5: Build** `npx tsc -b packages/llm-agent packages/llm-agent-libs packages/llm-agent-server-libs` → exit 0.
- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/build-stepper-root.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/build-stepper-root.test.ts
git commit -m "refactor(server-libs): buildFromComposition accepts makeRoleLlm (config-decoupled path for factories)"
```

---

### Task 5: `DagFactory` and `LinearFactory`

**Files:**
- Create: `packages/llm-agent-server-libs/src/factories/{dag,linear}-factory.ts`
- Test: add cases to `packages/llm-agent-server-libs/src/factories/__tests__/stepper-factories.test.ts` (or a new `coordinator-factories.test.ts`)

- [ ] **Step 1: Add failing test cases**

```ts
import { DagFactory } from '../dag-factory.js';
import { LinearFactory } from '../linear-factory.js';
test('DagFactory: kind=dag', () => assert.equal(new DagFactory().kind, 'dag'));
test('LinearFactory: kind=linear', () => assert.equal(new LinearFactory().kind, 'linear'));
```

- [ ] **Step 2: Run → FAIL** `Cannot find module '../dag-factory.js'`.

- [ ] **Step 3: Implement.** `DagFactory` wraps `DagCoordinatorHandler` (in `llm-agent-libs`), `LinearFactory` wraps `CoordinatorHandler` (in `llm-agent-libs`). Read each handler's ctor deps first:
  `grep -n "interface DagCoordinatorHandlerDeps" packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`
  `grep -n "interface CoordinatorHandlerDeps" packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`
  and mirror `build-dag-coordinator-deps.ts` for the DAG field mapping. The factory `build()` maps its `TConfig` (the handler's deps, minus anything derivable from `PipelineFactoryDepsBase`) into the handler ctor:

```ts
import type { BuiltCoordinator, IPipelineFactory, PipelineFactoryDepsBase } from '@mcp-abap-adt/llm-agent';
import { DagCoordinatorHandler, type DagCoordinatorHandlerDeps } from '@mcp-abap-adt/llm-agent-libs';

export class DagFactory implements IPipelineFactory<DagCoordinatorHandlerDeps> {
  readonly kind = 'dag' as const;
  async build(config: DagCoordinatorHandlerDeps, _deps: PipelineFactoryDepsBase): Promise<BuiltCoordinator> {
    return { handler: new DagCoordinatorHandler(config) };
  }
}
```

  (DAG is functionally untouched — the factory only wraps the existing handler. `LinearFactory` is analogous with `CoordinatorHandler`/`CoordinatorHandlerDeps`.)

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/factories/dag-factory.ts packages/llm-agent-server-libs/src/factories/linear-factory.ts packages/llm-agent-server-libs/src/factories/__tests__/
git commit -m "feat(server-libs): Dag + Linear builder-factories (wrap existing handlers)"
```

---

### Task 6: Barrel + public export

**Files:**
- Create: `packages/llm-agent-server-libs/src/factories/index.ts`
- Modify: `packages/llm-agent-server-libs/src/index.ts`
- Test: `packages/llm-agent-server-libs/src/factories/__tests__/public-api.test.ts`

- [ ] **Step 1: `factories/index.ts`**

```ts
export { CyclicFactory } from './cyclic-factory.js';
export { PlannedFactory } from './planned-factory.js';
export { DeepStepperFactory } from './deep-stepper-factory.js';
export { DagFactory } from './dag-factory.js';
export { LinearFactory } from './linear-factory.js';
export type { StepperFactoryConfig, StepperFactoryDeps } from './cyclic-factory.js';
```

- [ ] **Step 2: Ensure `src/index.ts` re-exports `./factories/index.js`** (added in Task 2, Step 5).

- [ ] **Step 3: Public-API test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lib from '@mcp-abap-adt/llm-agent-server-libs';
test('all five factories exported from the package root', () => {
  for (const n of ['CyclicFactory', 'PlannedFactory', 'DeepStepperFactory', 'DagFactory', 'LinearFactory'])
    assert.equal(typeof (lib as Record<string, unknown>)[n], 'function', `${n} exported`);
});
```

- [ ] **Step 4: Run → PASS + build** `cd packages/llm-agent-server-libs && npm test && cd ../.. && npm run build` → exit 0.
- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/factories/index.ts packages/llm-agent-server-libs/src/index.ts packages/llm-agent-server-libs/src/factories/__tests__/public-api.test.ts
git commit -m "feat(server-libs): export the five pipeline builder-factories from the package root"
```

---

### Task 7: Full build + lint + tests + docs

- [ ] **Step 1: Lockstep build** `npm run build` → exit 0.
- [ ] **Step 2: Lint** `npm run lint:check` (then `npm run lint` to auto-fix if needed).
- [ ] **Step 3: All tests** `npm test` → all pass.
- [ ] **Step 4: Update docs** — add `@mcp-abap-adt/llm-agent-server-libs` to the package table + dependency order in `CLAUDE.md` and `docs/ARCHITECTURE.md`; add a short "Reusing pipeline factories" snippet to `docs/INTEGRATION.md` showing `import { CyclicFactory } from '@mcp-abap-adt/llm-agent-server-libs'`.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: document llm-agent-server-libs + pipeline builder-factories; chore: lint"
```

---

## Self-Review

**1. Spec coverage:** New importable package `llm-agent-server-libs` — Task 2. Five named factories — Tasks 3 + 5. Exported from the library root — Task 6. Uniform interface — Task 1. Config decoupling so factories work outside the server config — Task 4. Binary still works (imports from the new lib) — Task 2 Steps 6–8. DAG functionally untouched (factory only wraps the existing handler) — Task 5. ✓

**2. Placeholder scan:** Field maps for `DagFactory`/`LinearFactory` config and the exact moved-module list depend on greps the steps specify; no literal `TBD` should reach code. Task 3's first code block intentionally shows the WRONG (throwing) version then the corrected one — the implementer writes only the corrected `build()` after Task 4. The task ORDER note (do Task 4 before finishing Task 3) is explicit.

**3. Type consistency:** `IPipelineFactory.build(config, deps) → Promise<BuiltCoordinator>`, `BuiltCoordinator.handler: IStageHandler`, `PipelineFactoryDepsBase.{makeRoleLlm, callMcp}` are used identically in Tasks 1, 3, 5. `buildFromComposition` gains an optional `makeRoleLlm` (Task 4) consumed by the Stepper factories (Task 3) and unchanged for the legacy server path (Task 2 binary). `StepperFactoryConfig = Omit<StepperCompositionSpec,'planner'|'executor'>` is single-sourced in `cyclic-factory.ts` and re-exported (Task 6).

## Risk notes

- **Task 2 is the heavy one** (package extraction). Keep it one atomic commit; rely on `npm run build` to prove the move is clean. If a moved module imports a binary-only symbol, that symbol was mis-located — move it into the library too (Task 2, Step 4).
- **No behaviour change** is intended anywhere: factories wrap existing handlers/composition; the server binary calls the same code via the new package; the legacy `makeLlm` path in `buildFromComposition` is preserved (Task 4).
