# Config.ts Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. Each task is one commit; run the lint gate and the pinned characterization tests GREEN before committing.

## Goal

Behavior-preserving decomposition of the 1648-line
`packages/llm-agent-server-libs/src/smart-agent/config.ts` into 5 focused modules + a
thin residual integration root, per the APPROVED blueprint
(`docs/superpowers/specs/2026-06-26-monolith-audit.md` → `## Blueprint: config.ts`). This is
the LOWEST-risk decomposition in the audit: `config.ts` is a pure-function module with no
class state — all coupling flows through imports and the shared `YamlConfig` /
`NormalizedLlmMap` types. The work is **relocation + barrel re-export**, not re-architecture.

## Architecture

`config.ts` currently holds six responsibilities (R1–R6). Each is already expressed as
discrete exported functions or cohesive private-helper clusters. We move each cluster
BYTE-FOR-BYTE into its own module and make `config.ts` barrel-re-export every symbol it
currently exports, so the package's public surface stays byte-stable.

| R | Responsibility | New module |
|---|---|---|
| R6 | Stepper coordinator config parsing | `smart-agent/stepper-config.ts` |
| R1 | YAML load + env-var resolution + template | `smart-agent/yaml-loader.ts` |
| R2 | LLM config normalization + role resolution | `smart-agent/llm-config-map.ts` |
| R4 | Config validation | `smart-agent/config-validator.ts` |
| R3 | Coordinator/dispatch resolvers + finalizer | `pipelines/coordinator-resolvers.ts` |
| R5 | Top-level resolution + subagent parsing | **KEEP** as residual `config.ts` (~350 lines) |

### Critical public-API fact (bake in)

`packages/llm-agent-server-libs/src/index.ts` line 11 does
`export * from './smart-agent/config.js'`. Therefore **EVERY symbol `config.ts` currently
exports is PUBLIC API**. The blueprint §4's claim that `ConfigValidationError` and
`assertNoLegacyPipelineConfig` re-exports are "optional (no external importer)" is WRONG for
public-surface stability — because of the `export *`, they ARE public. **`config.ts` MUST
barrel-re-export `ConfigValidationError` and `assertNoLegacyPipelineConfig`** (from
`config-validator.ts`). Treat every symbol `config.ts` currently exports as public API that
must remain re-exported from `config.ts` after its move.

Currently-exported symbols of `config.ts` (grep-verified — every one must be re-exported):
`LlmConfigMap`, `NormalizedLlmMap`, `normalizeLlmConfig`, `resolveLlmConfigStrict`,
`resolveLlmConfig`, `resolveReviewerLlmName`, `YamlCoordinator`,
`resolveCoordinatorPlanning`, `resolveCoordinatorDispatchKind`, `resolveCoordinatorDispatch`,
`resolveCoordinatorActivation`, `resolveToolSelectionStrategy`, `ConfigValidationError`,
`YamlConfig`, `ResolveConfigArgs`, `YAML_TEMPLATE`, `resolveEnvVars`, `loadYamlConfig`,
`generateConfigTemplate`, `FinalizerYaml`, `buildFinalizer`, `assertNoLegacyPipelineConfig`,
`ResolveSmartServerConfigOptions`, `resolveSmartServerConfig`, `StepperMode`,
`CompositionNode`, `StepperCompositionSpec`, `StepperCoordinatorConfig`,
`parseStepperCoordinatorConfig`. (`ResolveConfigArgs`, `ResolveSmartServerConfigOptions`,
`resolveSmartServerConfig` stay physically in the residual `config.ts` — R5 KEEP.)

Private (not exported → NOT re-exported): `isFlatLlmConfig`, `VALID_PROVIDERS`,
`VALID_RAG_TYPES`, `get` accessor, `checkLlmRole`, `checkRagStore`, `validateLlmEntry`,
`validateResolvedConfig`, `parseSubAgents`, `MODES`, `MODE_FLOW_PRESET`, `parseFlowPlan`,
`FlowBounds`, `parseNestedFlowSpec`, `parseSystemPromptOverride`, `parseCompositionNodes`.

### Import-path blast radius (re-grep-verified)

Direct production (non-test) importers of `config.ts` (via a `config.js` path):

| Importer | Symbols | Path change? |
|---|---|---|
| `builders/controller-skill-pipeline-builder.ts` | `YamlConfig`, `resolveSmartServerConfig` | No (barrel + residual) |
| `smart-agent/smart-server.ts` | `NormalizedLlmMap`, `normalizeLlmConfig`, `resolveLlmConfig`, `resolveLlmConfigStrict`, `resolveToolSelectionStrategy`, `resolveSmartServerConfig`, R1 re-exports | No (all via barrel) |
| `smart-agent/build-dag-coordinator-deps.ts` | `buildFinalizer`, `NormalizedLlmMap`, `resolveCoordinatorActivation`, `resolveLlmConfig`, `resolveLlmConfigStrict`, `resolveReviewerLlmName` | No (all via barrel from `./config.js`) |
| `smart-agent/llm/role-llm-resolver.ts` | `NormalizedLlmMap`, `resolveLlmConfig` (from `../config.js`) | No (barrel) — **MISSED by blueprint §4 table** |
| `smart-agent/build-stepper-root.ts` | `parseStepperCoordinatorConfig`, `StepperCompositionSpec`, `StepperCoordinatorConfig`, `resolveLlmConfig`, `NormalizedLlmMap`; **re-exports** `CompositionNode`, `StepperCompositionSpec` (line 107) | **YES** — stepper symbols → `./stepper-config.js` |
| `pipelines/server-context.ts` | `NormalizedLlmMap` (from `../smart-agent/config.js`) | No (barrel) |
| `pipelines/parsers.ts` | re-exports `parseStepperCoordinatorConfig`, `StepperCoordinatorConfig`; imports `resolveCoordinatorDispatch`, `resolveCoordinatorDispatchKind`, `resolveCoordinatorPlanning` | **YES** — stepper re-export → `../smart-agent/stepper-config.js`; coordinator import → `./coordinator-resolvers.js` |
| `llm-agent-server/src/smart-agent/cli.ts` | `resolveSmartServerConfig` | No (residual + `export *`) |
| `llm-agent-server/scripts/start-smart-server.ts` | `resolveSmartServerConfig` | No |

Indirect (via a facade, not `config.js` directly — unaffected):
`pipelines/stepper.ts` (imports stepper symbols from `./parsers.js`), `legacy/stepper.ts`
(re-exports from `../pipelines/parsers.js`), `factories/cyclic-factory.ts` (imports
`StepperCompositionSpec` from `../smart-agent/build-stepper-root.js`).

**Conclusion:** ONLY `pipelines/parsers.ts` and `smart-agent/build-stepper-root.ts` change
an import PATH (both same-package internal). Do NOT touch `src/index.ts`. Blast radius is
**9**, not 8 — the §4 table omitted `role-llm-resolver.ts` (path stays stable via the R2
barrel re-export; no fix needed beyond noting it).

### `get` YAML-path accessor decision (explicit)

The private 5-line `get` accessor (`config.ts` lines 505–511) is used by BOTH R4
(`validateResolvedConfig`) and R5 (`resolveSmartServerConfig`). After R4 moves to
`config-validator.ts`, it is needed in both `config-validator.ts` and the residual
`config.ts`. **Decision: DUPLICATE the byte-identical 5-line helper in `config-validator.ts`,
keep the original in `config.ts`.** Rationale: (a) behavior-preserving — a verbatim copy of a
trivial pure function with zero dependencies; (b) avoids introducing a new shared-util module
+ two new import edges for 5 lines; (c) keeps each module self-contained with no new
cross-module coupling, which is the whole point of this decomposition. A shared util would be
DRY-purer but adds a file and import wiring disproportionate to a 5-line helper.

## Tech Stack

- ESM only (`.js` extension imports), TypeScript strict, `noUnusedLocals: true`.
- Biome for lint/format (2 spaces, single quotes, always semicolons).
- Test runner (per `packages/llm-agent-server-libs/package.json`):
  `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`. Run a single file
  with `node --import tsx/esm --test --test-reporter=spec <file>`.
- Tests live in `__tests__/` dirs; existing char tests are under
  `packages/llm-agent-server-libs/src/smart-agent/__tests__/`.

## Global Constraints

- **Behavior-preserving:** move functions/types/consts BYTE-FOR-BYTE; the only edits are
  import-path adjustments + barrel re-exports. No logic/public-API change.
- **Public API byte-stable via barrel re-exports in `config.ts`.** Because `index.ts` does
  `export * from './smart-agent/config.js'`, EVERY symbol `config.ts` currently exports is
  public and MUST stay re-exported from `config.ts` after moving — **including
  `ConfigValidationError` and `assertNoLegacyPipelineConfig`**. Only `pipelines/parsers.ts`
  and `smart-agent/build-stepper-root.ts` may change an import PATH. Do NOT change
  `src/index.ts`.
- **Each new module < 500 lines** (targets: R6 ~450, R4 ~275, R3 ~200, R1 ~145, R2 ~110).
  Post-check with `wc -l`.
- ESM `.js`, TS strict, Biome, `noUnusedLocals: true` — remove dead imports after each move.
  Note: a barrel `export … from './x.js'` does NOT consume a local import binding, so
  moving a symbol out of `config.ts` means its now-unused local imports must be pruned.
- **Lint gate per task:** `npm run format` → `npx @biomejs/biome check --write <changed
  files>` → `npm run lint:check` **exit code 0** (warnings/infos fine). Do NOT grep for
  "Found 0 errors."
- Each task ends in exactly one commit. TDD: existing char tests pin each slice (GREEN
  before AND after). Tasks 2 and 5 ADD a gap test as their FIRST step (GREEN against current
  code before extracting).
- All commands use absolute paths or run from the repo root
  `/home/okyslytsia/prj/llm-agent`.

## File Structure

New modules (all in `packages/llm-agent-server-libs/src/`):

```
smart-agent/stepper-config.ts          (NEW, R6, ~450)
smart-agent/yaml-loader.ts             (NEW, R1, ~145)
smart-agent/llm-config-map.ts          (NEW, R2, ~110)
smart-agent/config-validator.ts        (NEW, R4, ~275)
pipelines/coordinator-resolvers.ts     (NEW, R3, ~200)
```

Modified:

```
smart-agent/config.ts                  (shrinks 1648 → ~350; barrel re-exports + R5 residual)
pipelines/parsers.ts                   (import PATH updates only)
smart-agent/build-stepper-root.ts      (import PATH updates only)
```

Gap tests (NEW):

```
smart-agent/__tests__/resolve-env-vars.test.ts   (Task 2, §4 #2 gap)
smart-agent/__tests__/build-finalizer.test.ts     (Task 5, §4 #1 gap)
```

---

### Task 1 — Extract `stepper-config.ts` (R6)

Most self-contained cluster: owns its own types/consts, zero shared types with R1–R5, not
called by R5. Only `PlanNode` (already imported) is an external dependency.

**Files:** create `smart-agent/stepper-config.ts`; edit `smart-agent/config.ts`,
`pipelines/parsers.ts`, `smart-agent/build-stepper-root.ts`.

**Interfaces / moved-cluster signatures (byte-for-byte from `config.ts`):**

- `export type StepperMode = 'cyclic-react' | 'planned-react' | 'deep-stepper';`
- `export interface CompositionNode { id; goal; dependsOn?; flow?; }`
- `export interface StepperCompositionSpec { … }`
- `export interface StepperCoordinatorConfig { … }`
- `const MODES` (private), `const MODE_FLOW_PRESET` (private)
- `function parseFlowPlan(raw: unknown): PlanNode[] | undefined` (private)
- `type FlowBounds = Pick<StepperCompositionSpec, …>` (private)
- `function parseNestedFlowSpec(flowCfg, bounds): StepperCompositionSpec` (private)
- `function parseSystemPromptOverride(raw, label): string | undefined` (private)
- `function parseCompositionNodes(raw, bounds): CompositionNode[] | undefined` (private)
- `export function parseStepperCoordinatorConfig(coord: Record<string, unknown>): StepperCoordinatorConfig`

Steps:

- [ ] Baseline the pinning tests GREEN before touching anything:
  `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/__tests__/stepper-config.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/build-stepper-root.test.ts`
- [ ] Create `packages/llm-agent-server-libs/src/smart-agent/stepper-config.ts` with header
  comment and the single external import:
  ```ts
  import type { PlanNode } from '@mcp-abap-adt/llm-agent';
  ```
- [ ] Move BYTE-FOR-BYTE from `config.ts` lines ~1208–1648 into `stepper-config.ts`:
  `StepperMode`, `CompositionNode`, `StepperCompositionSpec`, `StepperCoordinatorConfig`,
  `MODES`, `MODE_FLOW_PRESET`, `parseFlowPlan`, `FlowBounds`, `parseNestedFlowSpec`,
  `parseSystemPromptOverride`, `parseCompositionNodes`, `parseStepperCoordinatorConfig`
  (keep all leading doc-comments verbatim).
- [ ] In `config.ts`, delete the moved block and add the barrel re-export (re-export ONLY
  the 5 previously-public symbols):
  ```ts
  export { parseStepperCoordinatorConfig } from './stepper-config.js';
  export type {
    CompositionNode,
    StepperCompositionSpec,
    StepperCoordinatorConfig,
    StepperMode,
  } from './stepper-config.js';
  ```
- [ ] Update `pipelines/parsers.ts` — change the stepper re-export source (lines 3–6) from
  `'../smart-agent/config.js'` to `'../smart-agent/stepper-config.js'`:
  ```ts
  export {
    parseStepperCoordinatorConfig,
    type StepperCoordinatorConfig,
  } from '../smart-agent/stepper-config.js';
  ```
  (Leave the coordinator-resolver import at lines 9–13 alone — that changes in Task 5.)
- [ ] Update `smart-agent/build-stepper-root.ts`:
  - In the import block (lines 26–32) split the source: move
    `parseStepperCoordinatorConfig`, `StepperCompositionSpec`, `StepperCoordinatorConfig`
    to `import { parseStepperCoordinatorConfig, type StepperCompositionSpec, type StepperCoordinatorConfig } from './stepper-config.js';`
    and keep `import { type NormalizedLlmMap, resolveLlmConfig } from './config.js';` (both
    still barrel-provided by `config.ts`).
  - Line 107 re-export: change
    `export type { CompositionNode, StepperCompositionSpec } from './config.js';`
    → `from './stepper-config.js';`.
- [ ] Verify `factories/cyclic-factory.ts` still resolves `StepperCompositionSpec` — it
  imports from `../smart-agent/build-stepper-root.js`, which now re-exports from
  `stepper-config.js`. No edit needed; just confirm build passes.
- [ ] `wc -l packages/llm-agent-server-libs/src/smart-agent/stepper-config.ts` (expect ~450,
  < 500).
- [ ] Lint gate: `npm run format` → `npx @biomejs/biome check --write packages/llm-agent-server-libs/src/smart-agent/stepper-config.ts packages/llm-agent-server-libs/src/smart-agent/config.ts packages/llm-agent-server-libs/src/pipelines/parsers.ts packages/llm-agent-server-libs/src/smart-agent/build-stepper-root.ts` → `npm run lint:check` (exit 0).
- [ ] `npm run build` (from repo root) succeeds.
- [ ] Re-run the two pinning tests — GREEN.
- [ ] `git add -A && git commit -m "refactor(config): extract stepper-config.ts (R6)"`
  (footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`).

---

### Task 2 — Extract `yaml-loader.ts` (R1)

FIRST fold the §4 #2 gap test against CURRENT code (GREEN), then extract.

**Files:** create `smart-agent/__tests__/resolve-env-vars.test.ts`,
`smart-agent/yaml-loader.ts`; edit `smart-agent/config.ts`.

**Interfaces / moved-cluster signatures (byte-for-byte):**

- `export type YamlConfig = Record<string, unknown>;`
- `export const YAML_TEMPLATE = \`…\`;` (the full template literal, verbatim)
- `export function resolveEnvVars(value: unknown, env = process.env): unknown`
- `export function loadYamlConfig(filePath: string, env = process.env): YamlConfig`
- `export function generateConfigTemplate(outputPath: string): void`

Steps:

- [ ] Write `smart-agent/__tests__/resolve-env-vars.test.ts` importing `resolveEnvVars`
  from `../config.js` (works before AND after extraction — barrel keeps the path). Cover:
  `${VAR}` and `${VAR:-default}` substitution; fallback used when the env var is unset;
  env var present overrides the default; deep nesting (object → array → object) resolves at
  every depth; an array-of-objects each carrying a `${VAR:-default}` string. Use a local
  `env` object argument (do not mutate `process.env`).
  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { resolveEnvVars } from '../config.js';
  // e.g. array-of-objects at depth:
  const env = { A: 'x' } as NodeJS.ProcessEnv;
  const out = resolveEnvVars(
    { list: [{ k: '${A}' }, { k: '${B:-fallback}' }] },
    env,
  );
  assert.deepEqual(out, { list: [{ k: 'x' }, { k: 'fallback' }] });
  ```
- [ ] Run it GREEN against current code:
  `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-env-vars.test.ts`.
- [ ] Create `smart-agent/yaml-loader.ts` with imports derived from ONLY what the moved
  cluster needs:
  ```ts
  import fs from 'node:fs';
  import { parse as parseYaml } from 'yaml';
  ```
  (`node:path` is NOT needed here — `path` is used by `parseSubAgents` in R5, which stays.)
- [ ] Move BYTE-FOR-BYTE from `config.ts`: `YamlConfig` (line 284), `YAML_TEMPLATE`
  (311–428), `resolveEnvVars` (430–448), `loadYamlConfig` (450–456),
  `generateConfigTemplate` (458–460), with doc-comments.
- [ ] In `config.ts` add barrel re-exports and prune now-unused imports (`fs`, and `parse as
  parseYaml`) IF nothing else in `config.ts` still uses them (`parseSubAgents` calls
  `loadYamlConfig` — now imported from yaml-loader — so `fs`/`parseYaml` are no longer used
  directly in `config.ts`; `path` is still used by `parseSubAgents` — keep it):
  ```ts
  // LOCAL imports — ONLY the symbols config.ts itself still references after R1 moves:
  import { loadYamlConfig } from './yaml-loader.js';
  import type { YamlConfig } from './yaml-loader.js';
  // …
  // PUBLIC re-exports (independent of the local imports — keep every moved symbol public
  // because index.ts does `export *`):
  export {
    generateConfigTemplate,
    loadYamlConfig,
    resolveEnvVars,
    YAML_TEMPLATE,
  } from './yaml-loader.js';
  export type { YamlConfig } from './yaml-loader.js';
  ```
  **Do NOT add `resolveEnvVars` to the LOCAL import** — after R1 moves, `config.ts`'s only
  callers of `resolveEnvVars` (lines 439/444/455) left with it; the residual uses only
  `loadYamlConfig` (in `parseSubAgents`, ~824). Importing `resolveEnvVars` locally would be an
  unused local → `noUnusedLocals: true` build failure. It stays PUBLIC via the `export … from`
  re-export only. Likewise `YamlConfig` is still used LOCALLY as a type (`parseSubAgents` ~786,
  `resolveSmartServerConfig` ~885, and R4 validators until Task 4) → keep the local
  `import type { YamlConfig }` AND the `export type` re-export (a re-export does not satisfy a
  local type reference).
- [ ] `wc -l` yaml-loader.ts (~145, < 500).
- [ ] Lint gate on the changed files (`yaml-loader.ts`, `config.ts`, `resolve-env-vars.test.ts`).
- [ ] `npm run build` succeeds.
- [ ] Re-run `resolve-env-vars.test.ts` + `config-validation.test.ts` — GREEN.
- [ ] `git add -A && git commit -m "refactor(config): extract yaml-loader.ts (R1)"`.

---

### Task 3 — Extract `llm-config-map.ts` (R2)

**Files:** create `smart-agent/llm-config-map.ts`; edit `smart-agent/config.ts`.

**Interfaces / moved-cluster signatures (byte-for-byte):**

- `export type LlmConfigMap = Record<string, SmartServerLlmConfig>;`
- `export type NormalizedLlmMap = { main: SmartServerLlmConfig } & LlmConfigMap;`
- `function isFlatLlmConfig(input): boolean` (private)
- `export function normalizeLlmConfig(input?): NormalizedLlmMap | undefined`
- `export function resolveLlmConfigStrict(map, name): SmartServerLlmConfig | undefined`
- `export function resolveLlmConfig(map, name?, pipelineFallback?): SmartServerLlmConfig | undefined`
- `export function resolveReviewerLlmName(block, warn): string | undefined`

Steps:

- [ ] Baseline `llm-map-normalize.test.ts` GREEN.
- [ ] Create `smart-agent/llm-config-map.ts` with the single import it needs:
  ```ts
  import type { SmartServerLlmConfig } from './smart-server.js';
  ```
- [ ] Move BYTE-FOR-BYTE from `config.ts` lines 38–130: `LlmConfigMap`,
  `NormalizedLlmMap`, `isFlatLlmConfig`, `normalizeLlmConfig`, `resolveLlmConfigStrict`,
  `resolveLlmConfig`, `resolveReviewerLlmName` (with doc-comments).
- [ ] In `config.ts` add barrel re-exports and a local import for `resolveLlmConfig` (used
  by `buildFinalizer` — wait: `buildFinalizer` moves in Task 5; until then it still lives in
  `config.ts` and calls `resolveLlmConfig`, so `config.ts` needs the local binding now):
  ```ts
  import { resolveLlmConfig } from './llm-config-map.js';
  // …
  export {
    normalizeLlmConfig,
    resolveLlmConfig,
    resolveLlmConfigStrict,
    resolveReviewerLlmName,
  } from './llm-config-map.js';
  export type { LlmConfigMap, NormalizedLlmMap } from './llm-config-map.js';
  ```
  A single symbol can be BOTH locally imported and barrel-re-exported (`import { x }` +
  `export { x } from './y.js'`) — the re-export is a separate binding and does not clash.
  Prune the moved private `isFlatLlmConfig` and any now-unused imports from `config.ts`.
- [ ] Confirm `role-llm-resolver.ts` (`../config.js`) and `server-context.ts`
  (`../smart-agent/config.js`) still resolve `NormalizedLlmMap`/`resolveLlmConfig` via the
  barrel — no edit needed.
- [ ] `wc -l` llm-config-map.ts (~110, < 500).
- [ ] Lint gate on changed files.
- [ ] `npm run build` succeeds.
- [ ] Re-run `llm-map-normalize.test.ts` + `build-dag-coordinator-deps.test.ts` — GREEN.
- [ ] `git add -A && git commit -m "refactor(config): extract llm-config-map.ts (R2)"`.

---

### Task 4 — Extract `config-validator.ts` (R4)

Entirely internal module (no external production importer of the moved symbols), but
`ConfigValidationError` + `assertNoLegacyPipelineConfig` are public via `export *` → they
MUST be barrel-re-exported from `config.ts`.

**Files:** create `smart-agent/config-validator.ts`; edit `smart-agent/config.ts`.

**Interfaces / moved-cluster signatures (byte-for-byte):**

- `const VALID_PROVIDERS` / `const VALID_RAG_TYPES` (private consts)
- `export class ConfigValidationError extends Error`
- `const get = (obj, ...keys) => …` (private — DUPLICATED here per the `get`-accessor
  decision; the original stays in `config.ts`)
- `function checkLlmRole(…)` (private)
- `function checkRagStore(…)` (private)
- `function validateLlmEntry(…)` (private)
- `export function assertNoLegacyPipelineConfig(yaml: YamlConfig): void`
- `export function validateResolvedConfig(_resolved, yaml, env, opts?): void` — **was
  private in `config.ts`; it must become `export` so the residual `config.ts` can import it.
  It is NOT barrel-re-exported (never public before → do not widen the surface).**

Steps:

- [ ] Baseline `config-validation.test.ts` GREEN.
- [ ] Create `smart-agent/config-validator.ts` with imports derived from the moved cluster:
  ```ts
  import type { SmartServerConfig } from './smart-server.js';
  import type { YamlConfig } from './yaml-loader.js';
  ```
  (`validateResolvedConfig` uses `Omit<SmartServerConfig, 'log'>` and `YamlConfig`;
  `assertNoLegacyPipelineConfig` uses `YamlConfig`.)
- [ ] Move BYTE-FOR-BYTE from `config.ts`: `VALID_PROVIDERS` (258–264), `VALID_RAG_TYPES`
  (266–271), `ConfigValidationError` (273–282), `checkLlmRole` (513–561), `checkRagStore`
  (563–623), `validateLlmEntry` (626–635), `assertNoLegacyPipelineConfig` (648–671),
  `validateResolvedConfig` (673–771). Add `export` to `validateResolvedConfig`.
- [ ] DUPLICATE the 5-line `get` accessor into `config-validator.ts` (verbatim copy of
  lines 505–511); keep the original `get` in `config.ts` (R5 residual still uses it).
- [ ] In `config.ts`:
  - Import what the residual R5 needs for its own use:
    ```ts
    import {
      assertNoLegacyPipelineConfig,
      validateResolvedConfig,
    } from './config-validator.js';
    ```
  - Add the MANDATORY barrel re-export (public surface):
    ```ts
    export {
      assertNoLegacyPipelineConfig,
      ConfigValidationError,
    } from './config-validator.js';
    ```
  - Delete the moved consts/class/validators from `config.ts`; keep the local `get`. Prune
    now-unused imports (e.g. `VALID_PROVIDERS`/`VALID_RAG_TYPES` no longer referenced).
- [ ] `wc -l` config-validator.ts (~275, < 500).
- [ ] Lint gate on changed files.
- [ ] `npm run build` succeeds.
- [ ] Re-run `config-validation.test.ts` — GREEN.
- [ ] `git add -A && git commit -m "refactor(config): extract config-validator.ts (R4)"`.

---

### Task 5 — Extract `pipelines/coordinator-resolvers.ts` (R3)

FIRST add a focused `buildFinalizer` test against CURRENT code (GREEN), then extract. NOTE:
this is NOT filling missing coverage — `llm-map-normalize.test.ts:134` already covers the
`passthrough`/`template`/`llm` branches (one of the pinning suites). This new file LOCALIZES
that coverage next to the extraction AND adds the one branch the existing test omits: the
**no-LLM-config error case**. Keep it focused; don't duplicate what's already pinned.

**Files:** create `smart-agent/__tests__/build-finalizer.test.ts`,
`pipelines/coordinator-resolvers.ts`; edit `smart-agent/config.ts`, `pipelines/parsers.ts`.

**Interfaces / moved-cluster signatures (byte-for-byte):**

- `export interface YamlCoordinator { … }`
- `export function resolveCoordinatorPlanning(name: string, plannerLlm: ILlm)`
- `export function resolveCoordinatorDispatchKind(explicit?): 'subagent' | 'self' | 'hybrid'`
- `export function resolveCoordinatorDispatch(name, fallbackLlm?, contextBuilder?)`
- `export function resolveCoordinatorActivation(name: string)`
- `export function resolveToolSelectionStrategy(name, params?): IToolSelectionStrategy`
- `export type FinalizerYaml = { type?; finalizerLlm?; systemPrompt? };`
- `export async function buildFinalizer(cfg, llmMap, pipelineFallback, makeLlm): Promise<IFinalizer>`

Steps:

- [ ] Write `smart-agent/__tests__/build-finalizer.test.ts` importing `buildFinalizer` from
  `../config.js` (path stable before AND after via barrel). Cover all four cases:
  - absent block (`undefined`) → `PassthroughFinalizer` instance;
  - `{ type: 'passthrough' }` → `PassthroughFinalizer`;
  - `{ type: 'template' }` → `TemplateFinalizer`;
  - `{ type: 'llm', finalizerLlm: 'main' }` with a stub `makeLlm` → `LlmFinalizer`
    (assert `makeLlm` was called with the resolved config);
  - `{ type: 'llm' }` with `llmMap = undefined` and `pipelineFallback = undefined` →
    throws (`assert.rejects`) the "requires an LLM config" error.
  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import {
    LlmFinalizer,
    PassthroughFinalizer,
    TemplateFinalizer,
  } from '@mcp-abap-adt/llm-agent-libs';
  import { buildFinalizer } from '../config.js';
  ```
- [ ] Run it GREEN against current code:
  `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/__tests__/build-finalizer.test.ts`.
- [ ] Also baseline `coordinator-dispatch-resolver.test.ts` + `tool-selection-config.test.ts`
  GREEN.
- [ ] Create `pipelines/coordinator-resolvers.ts` with imports derived from the moved
  cluster (note the `../smart-agent/` prefix — this module lives in `pipelines/`):
  ```ts
  import type {
    IFinalizer,
    ILlm,
    ISubAgentContextBuilder,
    IToolSelectionStrategy,
  } from '@mcp-abap-adt/llm-agent';
  import {
    AutoActivation,
    ExplicitActivation,
    HybridDispatch,
    LlmFinalizer,
    OneShotPlanning,
    PassthroughFinalizer,
    ReplanOnErrorPlanning,
    ScoreThresholdToolSelection,
    SelfDispatch,
    SkillStepsPlanning,
    SubAgentDispatch,
    TemplateFinalizer,
    TopKToolSelection,
  } from '@mcp-abap-adt/llm-agent-libs';
  import {
    type NormalizedLlmMap,
    resolveLlmConfig,
  } from '../smart-agent/llm-config-map.js';
  import type { SmartServerLlmConfig } from '../smart-agent/smart-server.js';
  ```
- [ ] Move BYTE-FOR-BYTE from `config.ts`: `YamlCoordinator` (132–158),
  `resolveCoordinatorPlanning` (160–176), `resolveCoordinatorDispatchKind` (184–188),
  `resolveCoordinatorDispatch` (190–220), `resolveCoordinatorActivation` (222–233),
  `resolveToolSelectionStrategy` (235–256), `FinalizerYaml` (462–466), `buildFinalizer`
  (479–503), with doc-comments.
- [ ] In `config.ts` add the barrel re-exports and prune the now-unused imports (the
  `@mcp-abap-adt/llm-agent-libs` strategy classes, `IFinalizer`/`ISubAgentContextBuilder`/
  `IToolSelectionStrategy` types, and the local `resolveLlmConfig` import IF nothing else in
  `config.ts` still uses it — after `buildFinalizer` leaves, `resolveLlmConfig` is no longer
  used inside `config.ts`, so drop the local import but keep its barrel re-export from
  Task 3):
  ```ts
  export {
    buildFinalizer,
    resolveCoordinatorActivation,
    resolveCoordinatorDispatch,
    resolveCoordinatorDispatchKind,
    resolveCoordinatorPlanning,
    resolveToolSelectionStrategy,
  } from '../pipelines/coordinator-resolvers.js';
  export type {
    FinalizerYaml,
    YamlCoordinator,
  } from '../pipelines/coordinator-resolvers.js';
  ```
- [ ] Update `pipelines/parsers.ts` — change the coordinator-resolver import (lines 9–13)
  from `'../smart-agent/config.js'` to `'./coordinator-resolvers.js'` (same directory):
  ```ts
  import {
    resolveCoordinatorDispatch,
    resolveCoordinatorDispatchKind,
    resolveCoordinatorPlanning,
  } from './coordinator-resolvers.js';
  ```
- [ ] Confirm `build-dag-coordinator-deps.ts` still resolves `buildFinalizer`,
  `resolveCoordinatorActivation`, `resolveReviewerLlmName` via `./config.js` (barrel) — no
  edit.
- [ ] `wc -l` coordinator-resolvers.ts (~200, < 500).
- [ ] Lint gate on changed files.
- [ ] `npm run build` succeeds.
- [ ] Re-run `build-finalizer.test.ts` + `coordinator-dispatch-resolver.test.ts` +
  `tool-selection-config.test.ts` + `build-dag-coordinator-deps.test.ts` — GREEN.
- [ ] `git add -A && git commit -m "refactor(config): extract coordinator-resolvers.ts (R3)"`.

---

### Task 6 — Residual cleanup + parsers facade comment

**Files:** edit `smart-agent/config.ts`, `pipelines/parsers.ts`.

Steps:

- [ ] Confirm the residual `config.ts` now contains only R5 (`ResolveConfigArgs`,
  `ResolveSmartServerConfigOptions`, `parseSubAgents`, `resolveSmartServerConfig`, the local
  `get` accessor) + the barrel re-export blocks from Tasks 1–5. `wc -l
  packages/llm-agent-server-libs/src/smart-agent/config.ts` (expect ~350).
- [ ] Remove any dead boilerplate / stray now-unused imports left behind in `config.ts`
  (rely on `noUnusedLocals` + `npm run build` to surface them). Confirm the imports that
  REMAIN are exactly those R5 still uses:
  `fs`? (no — moved with R1), `path` (yes — `parseSubAgents`), `IFinalizer`/`ILlm`/… (no —
  moved with R3), `parseSkillPluginsConfig` (yes), `loadYamlConfig` (yes — R5 uses it),
  `assertNoLegacyPipelineConfig`/`validateResolvedConfig` (yes — R5 uses them), the
  `SmartServerConfig`/`SmartServerLlmConfig`/`SmartServerMode`/`SmartServerSubAgentConfig`
  types (yes — R5 shapes). Delete anything not referenced.
- [ ] Update `pipelines/parsers.ts` top comment (lines 1–2): the "PERMANENT facade:
  re-exports the pure parsers from config.ts (they STAY there …)" claim is now false —
  replace with an accurate note, e.g.:
  ```ts
  // Facade: re-exports the pure stepper parser from stepper-config.ts and the
  // coordinator resolvers from coordinator-resolvers.ts. parseLinearConfig
  // (below) is the only logic that lives here.
  ```
- [ ] Lint gate on `config.ts` + `parsers.ts`.
- [ ] `npm run build` succeeds; run the FULL server-libs suite once as a final check:
  `cd packages/llm-agent-server-libs && npm test` (or the root `npm test`) — GREEN.
- [ ] `git add -A && git commit -m "refactor(config): residual cleanup + parsers facade comment"`.

---

## Self-Review (writing-plans)

- **6 tasks cover R1–R6:** Task 1=R6, Task 2=R1, Task 3=R2, Task 4=R4, Task 5=R3,
  Task 6=residual R5 cleanup. ✅
- **2 gap tests folded:** §4 #2 (`resolveEnvVars` deep-nesting/fallback/array-of-objects)
  into Task 2 as its first step; §4 #1 (`buildFinalizer` passthrough/template/llm + no-LLM
  error) into Task 5 as its first step. Both written GREEN against current code before
  extracting. ✅
- **Barrel re-export list covers EVERY currently-exported symbol** — including
  `ConfigValidationError` and `assertNoLegacyPipelineConfig` (Task 4, MANDATORY per the
  `export *` correction). Cross-checked against the Architecture "currently-exported symbols"
  list; `ResolveConfigArgs`/`ResolveSmartServerConfigOptions`/`resolveSmartServerConfig` stay
  physically in the residual `config.ts` (no re-export needed). `validateResolvedConfig`
  becomes `export` but is NOT re-exported (was never public). ✅
- **`get`-accessor decision explicit:** DUPLICATE the 5-line helper in `config-validator.ts`,
  keep the original in `config.ts` — justified (behavior-preserving, no new module/edges,
  self-contained modules). ✅
- **Only `pipelines/parsers.ts` + `smart-agent/build-stepper-root.ts` change import paths.**
  All other importers (incl. the §4-missed `role-llm-resolver.ts`) keep stable paths via
  `config.ts` barrel re-exports. `src/index.ts` untouched. ✅
- **Importer the §4 table got wrong on re-grep:**
  `smart-agent/llm/role-llm-resolver.ts` (imports `NormalizedLlmMap` + `resolveLlmConfig`
  from `../config.js`) was omitted — actual blast radius is 9, not 8. Path stays stable via
  the R2 barrel; no code fix required beyond awareness.
