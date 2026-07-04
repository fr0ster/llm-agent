# Builder.ts Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. Each task is one commit; run the pinning tests and the scoped lint gate before committing; do NOT proceed to the next task until the current one is green and committed.

## Goal

Behavior-preserving decomposition of `packages/llm-agent-libs/src/builder.ts` (1437 lines) per the
APPROVED merged blueprint (`docs/superpowers/specs/2026-06-26-monolith-audit.md` → `## Blueprint: builder.ts`).
Extract **R1** (config/handle types) into `builder-types.ts` and **R3** (MCP tool + skill
vectorization — the ARCHITECTURE.md tech-debt block inside `build()`) into `mcp/vectorize-mcp-tools.ts`.
**R2** (fluent setters) and **R4** (core `build()` assembly) STAY in `builder.ts` (blueprint KEEP —
setters are inseparable from private fields; assembly is a sequential composition root).

Post-extraction `builder.ts` is ~1170 lines — EXPECTED and acceptable. Do NOT force it under any
line threshold.

## Architecture

`builder.ts` is one exported class `SmartAgentBuilder` + companion config types + one private guard,
divided into four jobs (blueprint §1):

| # | Responsibility | Disposition |
|---|---|---|
| R1 | Config/handle types (`BuilderMcpConfig`, `BuilderPromptsConfig`, `SmartAgentBuilderConfig`, `SmartAgentHandle`, `isModelProvider`) | **EXTRACT** → `builder-types.ts` |
| R2 | ~50 fluent `with*/set*/add*/create*` setters + private fields + constructor | **KEEP** |
| R3 | MCP tool-vectorization (batch → sequential fallback → sequential-only) + skill indexing | **EXTRACT** → `mcp/vectorize-mcp-tools.ts` |
| R4 | Core `build()` assembly (validation, RAG, registries, resilience wrapping, pipeline, `SmartAgent`) | **KEEP** |

Note: `buildRetrievalSource` (builder.ts ~713–723) is NOT part of R3 — it STAYS in builder.ts (used
by R4 coordinator dispatch wiring at ~1291).

## Tech Stack

- ESM only (`.js` import extensions), TypeScript strict (`noUnusedLocals: true`), Biome lint/format.
- Test runner (from `packages/llm-agent-libs/package.json`): `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`.
  - Single-file (both llm-agent-libs and llm-agent-server-libs): `node --import tsx/esm --test <path/to.test.ts>`.
- Node ≥ 22.

## Global Constraints

- **Behavior-preserving.** Move functions/types **BYTE-FOR-BYTE**. The only permitted edits are:
  import-path adjustments, barrel re-exports in `builder.ts`, and replacing the two inline
  vectorization blocks with calls to the extracted functions. No logic change. No public API change.
- **Public API byte-stable.** `SmartAgentBuilder` stays in `builder.ts`; the 4 public R1 types move to
  `builder-types.ts` but are **re-exported from `builder.ts`** so the package `index.ts` barrel
  (`export { … } from './builder.js'`) and every importer via it stay identical. **Do NOT change
  `index.ts`.** `vectorizeMcpTools`/`vectorizeSkills` are new internal helpers — exported from their
  module for the gap tests, but **NOT added to the package `index.ts` barrel**.
- **R2 setters + R4 assembly STAY** in `builder.ts`. Residual `builder.ts` ~1170 lines is EXPECTED —
  do NOT try to shrink it further.
- New modules (`builder-types.ts`, `mcp/vectorize-mcp-tools.ts`) each **< 500 lines**.
- **`noUnusedLocals: true`:** after each move, remove now-dead imports from `builder.ts`. A
  `export { x } from './m.js'` re-export does NOT consume a local import binding; a type still USED in
  `builder.ts` body (e.g. `SmartAgentBuilderConfig` on the field/constructor, `SmartAgentHandle` as
  `build()`'s return type) MUST ALSO be locally imported from `./builder-types.js`.
- **Lint gate per task (SCOPED — NOT the global `npm run format`):**
  `npx @biomejs/biome check --write <the changed files for THIS task>` then `npm run lint:check`
  requiring **exit code 0** (warnings/infos fine). Do NOT grep for "Found 0 errors."
- **Commit ONLY this task's files:** `git status --short`, then `git add` explicit paths (NEVER
  `git add -A` / `.`). If a file outside the task's blast-radius shows modified, STOP and report it.
- Each task ends in **exactly one commit**. TDD: the EXISTING characterization tests pin each slice —
  they stay GREEN **before AND after** every task (they are the behavior-preservation proof, together
  with the byte-for-byte move). Task 2 ALSO adds 2 NEW gap tests as its first step, but these follow a
  **RED-first** pattern, NOT green-against-current: because `vectorizeMcpTools`/`vectorizeSkills` do not
  exist until step 2b, the gap tests import the new module path and are expected to FAIL on the missing
  module first (RED), then pass once 2b creates the module (GREEN). A unit test of a not-yet-extracted
  function cannot be green beforehand — do NOT try to make the gap tests pass before the extraction, and
  do NOT build a temporary seam/wrapper to force that; the existing pinning tests (`builder-tool-selection`,
  `builder-mcp-failure-logging`, `mcp-yaml-vectorization`) are what carry the "current behavior GREEN
  before" guarantee. (This supersedes any "GREEN against current behavior" phrasing for the Task 2 gap
  tests — Task 2a's RED-first steps govern.)

### Resolved design decisions (grep-verified against the real 1437-line file)

- **`vectorizeMcpTools` signature (embedder source RESOLVED):**
  `vectorizeMcpTools(clients: IMcpClient[], toolsRag: IRag | undefined, requestLogger: IRequestLogger, logger: ILogger | undefined): Promise<void>`.
  The batch embedder is obtained **INSIDE** the function from the store —
  `const storeEmbedder = (toolsRag as any).embedder as IEmbedder | undefined;` (builder.ts:984) —
  **NOT** from `this._embedder`. So there is **NO separate embedder param**. The module imports
  `IEmbedder` (for the cast type) and `isBatchEmbedder` (runtime guard) from `@mcp-abap-adt/llm-agent`.
  `toolsRag` is `IRag | undefined` because the moved for-loop body keeps its inner `if (toolsRag)`
  guard byte-for-byte (builder.ts:977). `logger` corresponds to the `log` local (`this._logger`,
  type `ILogger | undefined`, builder.ts:726).
- **`vectorizeSkills` signature:**
  `vectorizeSkills(skillManager: ISkillManager, toolsRag: IRag, requestLogger: IRequestLogger, logger: ILogger | undefined): Promise<void>`.
  The call site KEEPS the outer guard `if (this._skillManager && toolsRag)` (builder.ts:1246), so both
  params are narrowed non-optional; the moved body is the inner block (builder.ts:1247–1275).
- **Blast-radius correction (blueprint §4 was authored pre-#209/#210 http/*.ts extraction).** Re-grep
  of `SmartAgentHandle` found **two production importers the §4 table omitted**, both still via the
  `@mcp-abap-adt/llm-agent-libs` barrel (so the re-export keeps them green):
  - `packages/llm-agent-server-libs/src/smart-agent/http/route-table.ts:20`
  - `packages/llm-agent-server-libs/src/smart-agent/http/chat-route-handler.ts:16`
  (`worker-registry.ts`, `config-reload-watcher.ts`, `config-route-handler.ts` reference
  `SmartAgentHandle` only in comments — not imports.) All `SmartAgentBuilder`/`SmartAgentHandle`
  importers reach the symbols via the package barrel; NO production file imports `./builder.js`
  directly except the package `index.ts` (`index.ts:39` region → `from './builder.js'`). The R1 types
  (`BuilderMcpConfig`/`BuilderPromptsConfig`/`SmartAgentBuilderConfig`) have NO external production
  importer (only the `index.ts` barrel exports them). `isModelProvider` is a PRIVATE function (not
  exported, not in `index.ts`) — it must stay private (re-exporting it publicly would change the API).
- **Test importers of the R1 symbols** (must stay green via the barrel re-export):
  `packages/llm-agent-libs/src/__tests__/handle-hotswap.test.ts` and
  `packages/llm-agent-server-libs/src/smart-agent/__tests__/worker-llm-cache.test.ts`.

## File Structure

```
packages/llm-agent-libs/src/
  builder.ts                          (MODIFIED: R1 types + R3 blocks removed;
                                       local imports + re-export of 4 public types;
                                       calls to vectorizeMcpTools/vectorizeSkills; ~1170 lines)
  builder-types.ts                    (NEW — Task 1: R1 types + isModelProvider; ~80 lines)
  index.ts                            (UNCHANGED — barrel still `from './builder.js'`)
  mcp/
    vectorize-mcp-tools.ts            (NEW — Task 2: vectorizeMcpTools + vectorizeSkills; ~250 lines)
  __tests__/
    vectorize-mcp-tools.test.ts       (NEW — Task 2: gap test for vectorizeMcpTools; batch /
                                       sequential-fallback / sequential-only)
    vectorize-skills.test.ts          (NEW — Task 2: gap test for vectorizeSkills; skills loop +
                                       !result.ok warning branch)
```

Pinning tests to keep GREEN (paths grep-verified):

- `packages/llm-agent-libs/src/__tests__/`: `builder-tool-selection.test.ts`,
  `builder-mcp-failure-logging.test.ts`, `builder-startup-validation.test.ts`,
  `builder-coordinator-dispatch-default.test.ts`, `builder-context-builder-wiring.test.ts`,
  `builder-api-adapters.test.ts`, `builder-rag-collection-idempotency.test.ts`,
  `handle-exposes-rag-registry.test.ts`, `mcp-clients-di.test.ts`, `agent-readiness.test.ts`,
  `handle-hotswap.test.ts`.
- `packages/llm-agent-server-libs/src/smart-agent/__tests__/`: `mcp-yaml-vectorization.test.ts`,
  `mcp-single-connect.test.ts`, `worker-llm-cache.test.ts`.

---

## Task 1 — `builder-types.ts`: extract R1

**Goal:** MOVE the R1 config/handle types + private guard BYTE-FOR-BYTE into a new companion file;
`builder.ts` re-exports the 4 public types (barrel stable) and locally imports what its body uses.

### Files

- NEW `packages/llm-agent-libs/src/builder-types.ts`
- MODIFIED `packages/llm-agent-libs/src/builder.ts`

### Interfaces / moved symbols (byte-for-byte from builder.ts)

- `BuilderMcpConfig` (builder.ts 111–121)
- `BuilderPromptsConfig` (builder.ts 123–134)
- `SmartAgentBuilderConfig` (builder.ts 136–154)
- `SmartAgentHandle` type alias (builder.ts 160–168, incl. the doc comment)
- `isModelProvider` private guard (builder.ts 174–181)

### Steps

- [ ] Run the R1 pinning tests to confirm GREEN baseline:
      `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts packages/llm-agent-libs/src/__tests__/handle-hotswap.test.ts packages/llm-agent-libs/src/__tests__/builder-startup-validation.test.ts`.
- [ ] Create `packages/llm-agent-libs/src/builder-types.ts` with this exact header + imports (the
      imports are the subset the moved symbols reference):

      ```ts
      /**
       * Config and handle types for SmartAgentBuilder.
       *
       * Public input/output shapes for the builder, relocated from builder.ts
       * so embed-as-library users can import the config contract without pulling
       * in the full builder implementation. Re-exported by builder.ts for API
       * stability.
       */

      import type {
        IModelProvider,
        SmartAgentHandle as SmartAgentHandleBase,
      } from '@mcp-abap-adt/llm-agent';
      import type { SmartAgent, SmartAgentConfig } from './agent.js';
      import type { SessionPolicy } from './policy/types.js';
      ```

- [ ] MOVE the 4 public type declarations (`BuilderMcpConfig`, `BuilderPromptsConfig`,
      `SmartAgentBuilderConfig`, and the `SmartAgentHandle` alias WITH its doc comment) into
      `builder-types.ts` **byte-for-byte** (keep `export` on each of the 4). Then MOVE `isModelProvider`
      **byte-for-byte** and ADD `export` to it (it must be importable by `builder.ts`; it is NOT added
      to `index.ts`, so it stays package-private):

      ```ts
      export function isModelProvider(obj: unknown): obj is IModelProvider {
        return (
          obj !== null &&
          typeof obj === 'object' &&
          typeof (obj as IModelProvider).getModels === 'function' &&
          typeof (obj as IModelProvider).getModel === 'function'
        );
      }
      ```

- [ ] In `builder.ts`, DELETE the moved declarations (the `Config types` block 107–154, the
      `Handle returned by build()` block 156–168, and the `isModelProvider` function 174–181). Keep the
      `// SmartAgentBuilder` separator (170–172) and the `export class SmartAgentBuilder` that follows.
- [ ] In `builder.ts`, ADD the local import (types USED in the builder body) + value import + the
      public re-export, immediately after the existing import block:

      ```ts
      import type {
        SmartAgentBuilderConfig,
        SmartAgentHandle,
      } from './builder-types.js';
      import { isModelProvider } from './builder-types.js';

      // Re-export the public builder config/handle types so the package barrel
      // (index.ts → builder.js) and all external importers stay byte-stable.
      export {
        type BuilderMcpConfig,
        type BuilderPromptsConfig,
        type SmartAgentBuilderConfig,
        type SmartAgentHandle,
      } from './builder-types.js';
      ```

      Rationale: `SmartAgentBuilderConfig` is used at the `cfg` field + constructor; `SmartAgentHandle`
      is `build()`'s return type; `isModelProvider` is called in `build()` (~1397) — all three MUST be
      locally imported (re-export alone does not create a usable binding). `BuilderMcpConfig` /
      `BuilderPromptsConfig` are NOT used in the builder body → re-export only.
- [ ] In `builder.ts`, REMOVE the now-dead imports (`noUnusedLocals`):
      - Remove `SmartAgentHandle as SmartAgentHandleBase,` from the `@mcp-abap-adt/llm-agent` type-import
        block (it was used ONLY by the moved alias).
      - Remove `SessionPolicy` from the `./policy/types.js` import (used ONLY by the moved
        `SmartAgentBuilderConfig`); KEEP `IPromptInjectionDetector` and `IToolPolicy` in that import
        (still used by the `_injectionDetector` / `_toolPolicy` fields).
      - KEEP `IModelProvider` (still used by `_modelProvider` field + `withModelProvider` + build()~1394),
        `SmartAgent` and `SmartAgentConfig` (still used by build() construction + agent-override fields).
- [ ] Verify `index.ts` is UNCHANGED (`git status --short` must NOT list `src/index.ts`).
- [ ] `npx @biomejs/biome check --write packages/llm-agent-libs/src/builder-types.ts packages/llm-agent-libs/src/builder.ts`
      then `npm run lint:check` — require exit code 0.
- [ ] `npm run build` (workspace) — TypeScript compiles clean.
- [ ] Re-run the R1 pinning tests (from step 1) — all GREEN, unchanged.
- [ ] `git status --short` — expect ONLY `builder-types.ts` (new) and `builder.ts` (modified). If any
      other file is modified, STOP and report.
- [ ] Commit ONLY these two files:
      `git add packages/llm-agent-libs/src/builder-types.ts packages/llm-agent-libs/src/builder.ts`
      then `git commit -m "refactor(builder): extract builder-types.ts (R1)"`.

---

## Task 2 — `mcp/vectorize-mcp-tools.ts`: extract R3 (PRIME EXTRACT)

**Goal:** FIRST author the two §4 gap tests against the NEW module path (RED — they fail on the
missing module until 2b), THEN move the two inline vectorization blocks BYTE-FOR-BYTE into that module
and call them from `build()` (turning the gap tests GREEN). The EXISTING pinning tests stay GREEN
before AND after and are the behavior-preservation guarantee. Closes the ARCHITECTURE.md tech-debt item.

### Files

- NEW `packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts`
- NEW `packages/llm-agent-libs/src/__tests__/vectorize-skills.test.ts`
- NEW `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts`
- MODIFIED `packages/llm-agent-libs/src/builder.ts`

### Interfaces (module contract — signatures ARE the contract; REUSE catalog interfaces)

```ts
export async function vectorizeMcpTools(
  clients: IMcpClient[],
  toolsRag: IRag | undefined,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
): Promise<void>;

export async function vectorizeSkills(
  skillManager: ISkillManager,
  toolsRag: IRag,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
): Promise<void>;
```

All parameter types are catalog interfaces from `@mcp-abap-adt/llm-agent`. The batch embedder is read
INSIDE `vectorizeMcpTools` from `(toolsRag as any).embedder` — no embedder param.

### Steps

#### 2a — Gap tests FIRST (RED-first: fail on missing module, GREEN after 2b)

Because the functions do not exist yet, the gap tests are authored to import from the target module
path `../mcp/vectorize-mcp-tools.js`; they will FAIL to import until step 2b creates the module. To
keep TDD honest, write them now, confirm they FAIL only on the missing module, then create the module
(step 2b) and confirm they pass. (The inline blocks they characterize are byte-identical to what 2b
moves, so passing tests prove behavior preservation.)

- [ ] Confirm current GREEN baseline for the R3 pinning tests:
      `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/builder-tool-selection.test.ts packages/llm-agent-libs/src/__tests__/builder-mcp-failure-logging.test.ts`
      and (server-libs)
      `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-single-connect.test.ts`.
- [ ] Write `packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts` covering the three
      paths (use the existing test helpers/stubs pattern from `builder-tool-selection.test.ts`):
      - **Batch path:** `toolsRag` whose `(rag as any).embedder` is a batch embedder
        (`isBatchEmbedder` true) AND `toolsRag.writer().upsertPrecomputedRaw` exists → assert
        `embedBatch` called once for all tools, `upsertPrecomputedRaw` called per tool with the
        precomputed vector, and `requestLogger.logLlmCall` called once with
        `{ component: 'embedding', detail: 'tools', scope: 'initialization' }`.
      - **Sequential fallback:** batch embedder present but `embedBatch` throws → assert a
        `warning` log ("Batch embedding failed, falling back to sequential") and per-tool `upsertRaw`
        calls with per-tool `logLlmCall(estimated: true)`.
      - **Sequential-only:** store embedder absent / not batch-capable → assert per-tool `upsertRaw`
        + per-tool estimated `logLlmCall`, no `embedBatch`.
      - **Failure warning:** a writer whose `upsertRaw`/`upsertPrecomputedRaw` returns
        `{ ok: false, error }` → assert the `Tool vectorization failed for "<name>"` warning.
      - **Guard:** `toolsRag: undefined` → no-op (no throw, no logging).
- [ ] Write `packages/llm-agent-libs/src/__tests__/vectorize-skills.test.ts`:
      - Mock `ISkillManager.listSkills()` returning `{ ok: true, value: [ {name, description}, … ] }`
        → assert per-skill `upsertRaw('skill:<name>', 'Skill: <name>\n<description>', {})` and per-skill
        estimated `logLlmCall({ detail: 'skills', … })`.
      - `!result.ok` warning branch: a writer returning `{ ok: false, error }` for a skill → assert the
        `Skill vectorization failed for "<name>"` warning.
      - `listSkills()` returning `{ ok: false }` → no upserts (loop body skipped).
- [ ] Run both new tests: expect FAILURE (module `../mcp/vectorize-mcp-tools.js` does not exist yet).
      This confirms the tests exercise the new module surface. Proceed to 2b.

#### 2b — Extract the module (BYTE-FOR-BYTE move)

- [ ] Create `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts` with the header + imports:

      ```ts
      /**
       * MCP tool + skill vectorization — extracted from SmartAgentBuilder.build()
       * per docs/ARCHITECTURE.md tech-debt (the builder's MCP block: connect stays
       * in the builder; the vectorization is pulled into this small module).
       *
       * Pure coordinators of catalog components — no builder state, no private fields.
       */

      import type {
        IEmbedder,
        ILogger,
        IMcpClient,
        IRag,
        IRequestLogger,
        ISkillManager,
      } from '@mcp-abap-adt/llm-agent';
      import { isBatchEmbedder } from '@mcp-abap-adt/llm-agent';
      ```

      (Verify at authoring time whether `IEmbedder`/`isBatchEmbedder` are exported from the value or
      type surface of `@mcp-abap-adt/llm-agent` — in `builder.ts` `IEmbedder` is a `type` import and
      `isBatchEmbedder` a value import from that same package; mirror exactly.)
- [ ] MOVE the tool-vectorization `for (const adapter of mcpClients) { … }` loop **byte-for-byte**
      from builder.ts (the loop body spanning ~973–1139, i.e. the `// Vectorize each connected
      client's tools…` comment through the client-level `catch` block) into `vectorizeMcpTools`.
      Wrap it exactly as:

      ```ts
      export async function vectorizeMcpTools(
        clients: IMcpClient[],
        toolsRag: IRag | undefined,
        requestLogger: IRequestLogger,
        logger: ILogger | undefined,
      ): Promise<void> {
        for (const adapter of clients) {
          try {
            // Vectorize tools into the tools RAG store
            if (toolsRag) {
              // … batch path / sequential fallback / sequential-only …
              // (moved byte-for-byte from builder.ts:977–1128)
            }
          } catch (err) {
            // Tool vectorization failed for this client — skip it; the agent
            // continues. (Connection failures are handled inside the strategy,
            // which skips a down target and reconnects it later.)
            logger?.log({
              type: 'warning',
              traceId: 'builder',
              message: `Tool vectorization failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
      ```

      **Mechanical renames only** inside the moved body: `mcpClients` → `clients` (the loop iterable is
      now the param), and every `log?.` → `logger?.` (the `log` local is now the `logger` param).
      `requestLogger` and `toolsRag` keep their names. NO other edits — the batch/sequential/embedder
      logic is verbatim.
- [ ] MOVE the skill-vectorization inner block **byte-for-byte** from builder.ts (~1247–1275, the body
      INSIDE `if (this._skillManager && toolsRag) { … }`) into `vectorizeSkills`:

      ```ts
      export async function vectorizeSkills(
        skillManager: ISkillManager,
        toolsRag: IRag,
        requestLogger: IRequestLogger,
        logger: ILogger | undefined,
      ): Promise<void> {
        const skillsResult = await skillManager.listSkills();
        if (skillsResult.ok) {
          for (const s of skillsResult.value) {
            // … moved byte-for-byte from builder.ts:1250–1273 …
          }
        }
      }
      ```

      **Mechanical renames only:** `this._skillManager.listSkills()` → `skillManager.listSkills()`,
      `log?.` → `logger?.`. `toolsRag`, `requestLogger`, the `text`/`embedStart`/`result` locals, and
      the `upsertRaw` + `logLlmCall` bodies are verbatim.

#### 2c — Update `build()` call sites

- [ ] In `builder.ts`, REPLACE the moved tool-vectorization loop (the `// Vectorize each connected
      client's tools…` comment through the client-level `catch`, ~973–1139) with a single call, keeping
      it inside the same `else` branch right after `mcpClients = resolved.clients;`:

      ```ts
      mcpClients = resolved.clients;
      await vectorizeMcpTools(mcpClients, toolsRag, requestLogger, log);
      ```

- [ ] In `builder.ts`, REPLACE the skill-vectorization block (~1245–1276) — KEEP the outer guard so the
      narrowed params satisfy the non-optional signature:

      ```ts
      // ---- Skill vectorization (optional) ------------------------------------
      if (this._skillManager && toolsRag) {
        await vectorizeSkills(this._skillManager, toolsRag, requestLogger, log);
      }
      ```

- [ ] In `builder.ts`, ADD the import (place with the other local `./` imports):
      `import { vectorizeMcpTools, vectorizeSkills } from './mcp/vectorize-mcp-tools.js';`
- [ ] In `builder.ts`, REMOVE the now-dead `isBatchEmbedder` from the `@mcp-abap-adt/llm-agent` value
      import (it was used ONLY inside the moved batch path, builder.ts:990). KEEP `IEmbedder`,
      `QueryEmbedding`, `IRag` (still used by `buildRetrievalSource` + fields), and
      `IMcpClient`/`IRequestLogger`/`ILogger`/`ISkillManager` (still used by builder body). Verify by
      grep that `isBatchEmbedder` has no remaining reference in `builder.ts` before removing.

#### 2d — Verify + commit

- [ ] `npx @biomejs/biome check --write packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts packages/llm-agent-libs/src/builder.ts packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts packages/llm-agent-libs/src/__tests__/vectorize-skills.test.ts`
      then `npm run lint:check` — require exit code 0.
- [ ] `npm run build` — clean compile.
- [ ] Run the two new gap tests — now GREEN:
      `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts packages/llm-agent-libs/src/__tests__/vectorize-skills.test.ts`.
- [ ] Re-run the R3 pinning tests (Task-2 baseline set) — all GREEN, unchanged.
- [ ] `git status --short` — expect ONLY the 2 new tests, the new module, and `builder.ts`. If any
      other file is modified, STOP and report.
- [ ] Commit ONLY these files:
      `git add packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts packages/llm-agent-libs/src/builder.ts packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts packages/llm-agent-libs/src/__tests__/vectorize-skills.test.ts`
      then `git commit -m "refactor(builder): extract vectorize-mcp-tools.ts (R3, closes ARCHITECTURE.md tech-debt)"`.

---

## Task 3 — Residual cleanup

**Goal:** Remove dead comments / section separators left in `build()` by the R3 extraction; verify the
residual line count. NO logic change.

### Files

- MODIFIED `packages/llm-agent-libs/src/builder.ts`

### Steps

- [ ] Inspect the region around the former tool-vectorization call (the `// ---- MCP clients + tool
      vectorization ----` header and inline explanatory comments that referenced the now-extracted
      batch/sequential loop). Keep comments that still describe the retained connect logic; remove
      comment fragments that only described the moved embed loop and now dangle. Do the same around the
      `// ---- Skill vectorization (optional) ----` block if any separator is now redundant.
- [ ] Do NOT touch R2 setters or R4 assembly logic — this task is comment/separator hygiene only.
- [ ] Verify residual size: `wc -l packages/llm-agent-libs/src/builder.ts` should read ~1170 (down from
      1437). This is the EXPECTED final shape (R2 setters + R4 assembly + re-exports) — do NOT chase a
      lower number.
- [ ] `npx @biomejs/biome check --write packages/llm-agent-libs/src/builder.ts` then `npm run lint:check`
      — require exit code 0.
- [ ] `npm run build` — clean compile.
- [ ] Run the full builder-adjacent pinning set once more (all GREEN):
      `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/builder-tool-selection.test.ts packages/llm-agent-libs/src/__tests__/builder-mcp-failure-logging.test.ts packages/llm-agent-libs/src/__tests__/builder-startup-validation.test.ts packages/llm-agent-libs/src/__tests__/builder-coordinator-dispatch-default.test.ts packages/llm-agent-libs/src/__tests__/builder-context-builder-wiring.test.ts packages/llm-agent-libs/src/__tests__/builder-api-adapters.test.ts packages/llm-agent-libs/src/__tests__/builder-rag-collection-idempotency.test.ts packages/llm-agent-libs/src/__tests__/handle-exposes-rag-registry.test.ts packages/llm-agent-libs/src/__tests__/mcp-clients-di.test.ts packages/llm-agent-libs/src/__tests__/agent-readiness.test.ts packages/llm-agent-libs/src/__tests__/handle-hotswap.test.ts packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts packages/llm-agent-libs/src/__tests__/vectorize-skills.test.ts`
      and (server-libs)
      `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-single-connect.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/worker-llm-cache.test.ts`.
- [ ] `git status --short` — expect ONLY `builder.ts`. If any other file is modified, STOP and report.
- [ ] Commit ONLY this file:
      `git add packages/llm-agent-libs/src/builder.ts`
      then `git commit -m "refactor(builder): residual cleanup"`.

---

## Done-when

- 3 commits on `refactor/builder-decompose`, in blueprint §5 order.
- `builder-types.ts` (~80 lines) and `mcp/vectorize-mcp-tools.ts` (~250 lines) each < 500 lines.
- `builder.ts` ~1170 lines; `SmartAgentBuilder` class + all 50 setters + `build()` assembly retained
  in place; the 4 public R1 types re-exported; `index.ts` byte-unchanged.
- All 14 pinning tests + 2 gap tests GREEN; `npm run lint:check` exit 0; `npm run build` clean.
- No public API change; no logic change (moves byte-for-byte + mechanical renames only).
