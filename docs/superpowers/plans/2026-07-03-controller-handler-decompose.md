# Controller-Coordinator-Handler Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. Each task is one commit; run the lint + test gate before committing; do not batch tasks.

## Goal

Behavior-preserving, public-API-stable decomposition of
`packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`
(currently **2026 lines**) per the APPROVED blueprint in
`docs/superpowers/specs/2026-06-26-monolith-audit.md` → `## Blueprint: controller-coordinator-handler.ts`.

Relocate cohesive **module-scope free functions** (they sit ABOVE and BELOW the
`ControllerCoordinatorHandler` class body at lines `214`–`1577`) into controller sibling modules,
and fix one **inverted dependency**: `planner.ts` and `reviewer.ts` currently import
`extractJsonObject` *from the handler* — the handler is the bottom of the controller graph and must
not be a provider for its own siblings.

Net result: 3 new sibling modules (`parser.ts`, `usage-logging.ts`, `recall.ts`) + `renderLiveBoard`
relocated into existing `board.ts` + one inline (`toLlmToolCall`); the handler drops to ~1350 lines
(pure execution loop). No public API change; no logic change; every moved symbol re-exported from the
handler so all TEST import paths stay identical; the ONLY production import-path change is
`planner.ts` + `reviewer.ts` → `./parser.js`.

## Architecture

The `ControllerCoordinatorHandler` class (constructor field: only `private readonly deps:
ControllerHandlerDeps` — no mutable class state) is the residual R1 execution loop and stays put.
All coupling to the moved helpers is import-level (pure functions parameterized on catalog
interfaces `IKnowledgeRagHandle` / `IEmbedder` / `IRequestLogger`), so the seams are import cuts, not
field cuts. The extraction targets map onto the existing controller sibling family
(`board.ts`, `artifacts.ts`, `planner.ts`, `reviewer.ts`, `types.ts`, `outcome.ts`,
`session-bundle.ts`, `embedder-knowledge-index.ts`) — REUSE/relocate, no invented parallel layers.

Responsibility → destination (blueprint §3):

| R | Responsibility | Move target | Task |
|---|---|---|---|
| R5 | Plan JSON parsing (`parseNextStep`, `extractJsonObject`) | new `controller/parser.ts` (+ fix inverted dep) | 1 |
| R2 | Live board render glue (`renderLiveBoard`) | existing `controller/board.ts` | 2 |
| R-util | Token-usage logging (`makeLogUsage`) | new `controller/usage-logging.ts` | 3 |
| R3 | Run-scoped recall cluster | new `controller/recall.ts` | 4 |
| R4 | Tool-call normalization (`toLlmToolCall`) | INLINE into `runStep` | 5 |
| R1 | Controller execution loop | residual in handler | 6 (cleanup) |

## Tech Stack

- Package: `@mcp-abap-adt/llm-agent-server-libs` (ESM only, `.js` import extensions, TS strict,
  `noUnusedLocals: true`).
- Lint/format: Biome (`npm run format`, `npx @biomejs/biome check --write <files>`, `npm run lint:check`).
- Test runner (from `packages/llm-agent-server-libs/package.json`):
  `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`.
  **Single-file invocation** (run from `packages/llm-agent-server-libs/`):
  `node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/<file>.test.ts`

## Global Constraints

- **Behavior-preserving:** move function bodies **BYTE-FOR-BYTE**. The only edits allowed are
  import-path adjustments, barrel re-exports in the handler, the `planner.ts`/`reviewer.ts` repoint,
  and the `toLlmToolCall` inline expansion. No logic change. No public API change.
- **Public API byte-stable via handler barrel re-exports.** Every moved symbol is re-exported from
  `controller-coordinator-handler.ts` so all TEST import paths (`../controller-coordinator-handler.js`)
  stay identical. The ONLY production import-path change is `planner.ts` + `reviewer.ts` →
  `./parser.js` for `extractJsonObject` (required — a sibling re-exporting FROM the handler, which
  then imports FROM the sibling, would be circular). `ControllerCoordinatorHandler`,
  `ControllerHandlerDeps`, `TerminalUsage`, and the `execute()` signature stay in the handler
  unchanged. Do NOT touch any package barrel (`src/index.ts`) surface.
- **New sibling modules each < 500 lines**; handler target ~1350. `wc -l` each after every task.
- ESM `.js`, TS strict, Biome. `noUnusedLocals: true` — after each move, **prune now-dead imports from
  the handler**. Remember: `export { x } from './m.js'` does NOT create a local binding, so a symbol
  still CALLED inside the handler must ALSO be locally `import { x }`ed from its new module (needs
  BOTH statements); a symbol only re-exported needs ONLY the `export { … } from` line.
- **Lint gate per task:** `npm run format` → `npx @biomejs/biome check --write <changed files>` →
  `npm run lint:check` requiring **exit code 0** (warnings/infos are fine). Do NOT grep for
  "Found 0 errors" — trust the exit code.
- **Build gate per task:** `npm run build` (root or the package) must succeed — tsc `noUnusedLocals`
  is the authoritative dead-import check.
- Each task ends in **exactly one commit**. TDD: existing characterization tests pin each slice
  (GREEN before, GREEN after). Tasks 1 & 2 ADD a gap test as their FIRST step (GREEN against current
  code BEFORE the move).
- Characterization tests to keep GREEN (grep-verified real paths, all under
  `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/`):
  `controller-coordinator-handler.test.ts`, `round-trip.test.ts`, `run-scoped-recall.test.ts`,
  `board.test.ts`, `usage-logging.test.ts`, `planner.test.ts`, `planner.skills.test.ts`,
  `reviewer.test.ts`, `usage-e2e.test.ts`, `select-tools-options.test.ts`.

## File Structure

All paths relative to `packages/llm-agent-server-libs/src/smart-agent/`.

**New sibling modules (created by this plan):**
- `controller/parser.ts` — R5: `parseNextStep` + `extractJsonObject` (Task 1)
- `controller/usage-logging.ts` — R-util: `makeLogUsage` (+ private `dlog` copy) (Task 3)
- `controller/recall.ts` — R3: `runScopedRecall`, `relevantExtract`, `collectApproved`,
  `buildRecallBlock`, `rankStatus`, `isBetterStep`, `isBetterMcp`, recall constants (Task 4)

**Existing modules modified:**
- `controller/board.ts` — R2: gains `renderLiveBoard` (Task 2)
- `controller/controller-coordinator-handler.ts` — loses R2–R5 + R-util; gains barrel re-exports;
  inlines `toLlmToolCall`; prunes dead imports (Tasks 1–6)
- `controller/planner.ts` — repoint `extractJsonObject` import → `./parser.js` (Task 1)
- `controller/reviewer.ts` — repoint `extractJsonObject` import → `./parser.js` (Task 1)

**Gap-test files (existing test files receiving the two §4 gap tests):**
- `controller/__tests__/controller-coordinator-handler.test.ts` — add `parseNextStep` shape-matrix
  characterization test (Task 1, §4 #1)
- `controller/__tests__/board.test.ts` — add `renderLiveBoard` glue characterization test (Task 2, §4 #2)

---

### Task 1 — `controller/parser.ts`: move R5 + fix inverted dependency

**Files:** create `controller/parser.ts`; modify `controller-coordinator-handler.ts` (remove R5,
add re-export), `planner.ts` (repoint), `reviewer.ts` (repoint),
`__tests__/controller-coordinator-handler.test.ts` (add gap test).

**Interfaces:** `parseNextStep(content: string): NextStep | null`;
`extractJsonObject(raw: string): string | null`. Both stay byte-identical.

**Grounding facts (grep-verified):**
- `parseNextStep` is declared at `1686`, `extractJsonObject` at `1727`. `parseNextStep` calls
  `extractJsonObject` and uses `validateRequires` + type `NextStep`. Neither is CALLED inside the
  handler class body (only the declarations appear) — so the handler needs NO local import of either
  after the move, only re-exports.
- Production importers of `extractJsonObject` are EXACTLY `planner.ts` (line 7) and `reviewer.ts`
  (line 2) — both `import { extractJsonObject } from './controller-coordinator-handler.js';`.
  (`embedder-knowledge-index.ts` only mentions `relevantExtract` in a COMMENT — not an importer.)
- `parseNextStep` has ZERO production importers; its sole importer is the TEST
  `controller-coordinator-handler.test.ts` (line 20, from `../controller-coordinator-handler.js`).
- No test imports `extractJsonObject` directly; its re-export is a no-cost safety net.

**Steps:**

- [ ] **Gap test FIRST (§4 #1).** In `__tests__/controller-coordinator-handler.test.ts`, add a NEW
  `describe('parseNextStep shape matrix', ...)` block (leave the existing `parseNextStep requires
  validation` block at ~line 2283 intact). Import path is unchanged — `parseNextStep` already comes
  from `../controller-coordinator-handler.js` (line 20). Cover, asserting exact return shapes:
  - valid `done`: `parseNextStep('{"kind":"done","result":"R"}')` → `{ kind: 'done', result: 'R' }`
  - valid `next`: `{"kind":"next","step":{"name":"n","instructions":"i"}}` →
    `{ kind: 'next', step: { name: 'n', instructions: 'i' } }`
  - valid `rewind`: `{"kind":"rewind","reason":"why"}` → `{ kind: 'rewind', reason: 'why' }`
  - JSON-fenced input: same `next` payload wrapped in a ` ```json … ``` ` fence with surrounding prose
    → parses to the `next` shape
  - invalid: `parseNextStep('not json at all')` → `null`
  - partial/malformed JSON: `parseNextStep('{"kind":"next","step":{"name":"n"}')` (missing
    `instructions` and unbalanced) → `null`
- [ ] Run the file → GREEN against current code:
  `node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
- [ ] Create `controller/parser.ts` with this import block (derived from the two bodies' exact deps)
  and both functions moved BYTE-FOR-BYTE (including their JSDoc), with `extractJsonObject` declared
  so `parseNextStep` can call it:

  ```ts
  import { type NextStep, validateRequires } from './types.js';

  // <byte-for-byte copy of parseNextStep (handler lines 1681–1722), export kept>
  // <byte-for-byte copy of extractJsonObject (handler lines 1724–1751), export kept>
  ```
- [ ] In `controller-coordinator-handler.ts`, DELETE the `parseNextStep` (1681–1722) and
  `extractJsonObject` (1724–1751) declarations (and their JSDoc). Add the barrel re-export near the
  top of the file (e.g. just after the `ControllerHandlerDeps`/`TerminalUsage` exports, in a clearly
  commented "re-exported for import-path stability" region):

  ```ts
  // Re-exported for import-path stability (moved to ./parser.ts).
  export { extractJsonObject, parseNextStep } from './parser.js';
  ```
- [ ] Repoint `planner.ts` line 7: `import { extractJsonObject } from './parser.js';`
- [ ] Repoint `reviewer.ts` line 2: `import { extractJsonObject } from './parser.js';`
- [ ] `npm run build` — confirm no `noUnusedLocals` errors in the handler (verify `NextStep`,
  `validateRequires` are still used elsewhere in the handler; if either is now unused there, prune it
  from the handler's `./types.js` import — grep first: both are used broadly in the class, so expect
  to keep them).
- [ ] Lint gate: `npm run format` → `npx @biomejs/biome check --write` on the 5 changed files →
  `npm run lint:check` (exit 0).
- [ ] Test gate: run `controller-coordinator-handler.test.ts`, `planner.test.ts`,
  `planner.skills.test.ts`, `reviewer.test.ts` single-file → all GREEN. `wc -l parser.ts` (< 500).
- [ ] **Commit:** `refactor(controller): extract parser.ts + fix inverted dep (R5)`

---

### Task 2 — move `renderLiveBoard` into `controller/board.ts` (R2)

**Files:** modify `controller/board.ts` (add `renderLiveBoard`), `controller-coordinator-handler.ts`
(import for call site + re-export, delete local), `__tests__/board.test.ts` (add gap test).

**Interface:** `renderLiveBoard(rag: IKnowledgeRagHandle, bundle: SessionBundle, budget: BoardBudget):
Promise<string>` — byte-identical.

**Grounding facts:** `renderLiveBoard` is declared at `1786` as a non-exported `async function`,
and is CALLED once inside the handler at line `706`
(`boardText = await renderLiveBoard(rag, bundle, boardBudget);`). It delegates entirely to
`readPlanDecisions`/`readClaims` (from `./artifacts.js`), `rag.list`, `reconstructBoard`, `renderBoard`
(the latter two already live IN `board.ts`). ZERO handler-specific logic. No existing test imports it.
`board.ts` currently imports from `./artifacts.js` (types only) and `./types.js`
(`InFlightStep, PendingMarker, Step`); it does NOT yet import `IKnowledgeRagHandle`, the artifact
value-readers, or `SessionBundle`.

**Steps:**

- [ ] **Enable pinning.** In `controller-coordinator-handler.ts`, change the declaration at 1786 from
  `async function renderLiveBoard(` to `export async function renderLiveBoard(` (behavior-neutral —
  exposes the glue so the gap test can pin it before the move).
- [ ] **Gap test FIRST (§4 #2).** In `__tests__/board.test.ts`, add renderLiveBoard characterization
  test(s). NOTE: board.test.ts imports only `{ test }` from `node:test` — either add flat
  `test('renderLiveBoard …', …)` cases matching that existing style, or extend the import to
  `{ describe, it, test }` and use a `describe('renderLiveBoard', …)` group. Import `renderLiveBoard`
  from `../controller-coordinator-handler.js` on a separate `import` line (board.test.ts's existing
  `../board.js` import stays as-is). Cover:
  - absent runId → `''`: build a `SessionBundle` with `runId` undefined (via `hydrateBundle` or a
    minimal literal matching the type), call `renderLiveBoard(rag, bundle, budget)` → asserts `''`.
  - delegation: with a fake `IKnowledgeRagHandle` returning plan-decision + step-result + claim
    artifacts (reuse the `meta(...)` helper already in board.test.ts), assert the result equals
    `renderBoard(reconstructBoard({…}), budget)` for the same reconstructed inputs (i.e. the glue
    forwards structure/stepResults/claims/inFlight/pending unchanged).
- [ ] Run → GREEN against current code:
  `node --import tsx/esm --test --test-reporter=spec src/smart-agent/controller/__tests__/board.test.ts`
- [ ] Move `renderLiveBoard` BYTE-FOR-BYTE (JSDoc + body, lines 1784–1806) into `controller/board.ts`
  as an `export async function`. Add the imports it needs to `board.ts`:
  - `import type { IKnowledgeRagHandle } from '@mcp-abap-adt/llm-agent';`
  - add value readers to the existing artifacts import:
    `import { readClaims, readPlanDecisions, type PlanDecisionRecord, type StepStartClaim } from './artifacts.js';`
    (keep the existing type-only members)
  - add `SessionBundle` to the existing `./types.js` import:
    `import type { InFlightStep, PendingMarker, SessionBundle, Step } from './types.js';`
  - `reconstructBoard`, `renderBoard`, `BoardBudget` are already in-module — no import needed.
- [ ] In `controller-coordinator-handler.ts`: DELETE the local `renderLiveBoard` (1784–1806). Add
  `renderLiveBoard` to the EXISTING `import { … } from './board.js';` block (needed for the local
  call at 706 — a re-export alone gives no local binding). Also add the re-export line in the
  re-export region:

  ```ts
  // Re-exported for import-path stability (moved to ./board.ts).
  export { renderLiveBoard } from './board.js';
  ```
  (The gap test imports `renderLiveBoard` from the handler, so this re-export IS required.)
- [ ] `npm run build` — confirm the handler no longer references `readPlanDecisions`/`readClaims`/
  `reconstructBoard`/`renderBoard` ONLY via `renderLiveBoard`. **Verify they are still used elsewhere
  in the handler before pruning:** grep the handler — `reconstructBoard`/`renderBoard`/`readClaims`/
  `readPlanDecisions` may have other call sites (e.g. the `BoardOverBudgetError` branch ~706–715).
  Prune from the handler's `./board.js`/`./artifacts.js` imports ONLY the members tsc reports unused.
- [ ] Lint gate + test gate: run `board.test.ts`, `controller-coordinator-handler.test.ts`,
  `round-trip.test.ts` → GREEN. `wc -l board.ts` (< 500).
- [ ] **Commit:** `refactor(controller): move renderLiveBoard into board.ts (R2)`

---

### Task 3 — `controller/usage-logging.ts`: move R-util (`makeLogUsage`)

**Files:** create `controller/usage-logging.ts`; modify `controller-coordinator-handler.ts`
(import for call site + re-export, delete local).

**Interface:** `makeLogUsage(requestLogger, requestId, models): (role, u?) => void` — byte-identical.

**Grounding facts:** `makeLogUsage` is declared/exported at `79`–`113` and CALLED once inside
`execute()` at line `240` (`const logUsage = makeLogUsage(ctx.requestLogger, meta.traceId,
deps.models);`). Its body calls the module-scope `dlog` (line 63), which STAYS in the handler (used
by other handler code). Sole external importer is the TEST `usage-logging.test.ts` (line 5, from
`../controller-coordinator-handler.js`) — NO production importer outside the handler.

**Steps:**

- [ ] Create `controller/usage-logging.ts`. Move `makeLogUsage` BYTE-FOR-BYTE (JSDoc + body,
  handler lines 72–113 excluding the `TerminalUsage` type, which stays in the handler). Because the
  moved body references `dlog` and `dlog` stays in the handler, add a **private local copy** of the
  3-line `dlog` (byte-identical to handler lines 63–65) to `usage-logging.ts` (a tiny debug helper,
  not part of the public surface — duplication is intentional to avoid a new inverted dep back to the
  handler). Import block:

  ```ts
  import type {
    IRequestLogger,
    LlmComponent,
    LlmUsage,
  } from '@mcp-abap-adt/llm-agent';

  function dlog(msg: string): void {
    if (process.env.DEBUG_CONTROLLER) console.error(`[controller] ${msg}`);
  }

  // <byte-for-byte copy of makeLogUsage (handler lines 72–113), export kept>
  ```
- [ ] In `controller-coordinator-handler.ts`: DELETE the `makeLogUsage` declaration+JSDoc (72–113;
  keep `dlog` at 63 and `TerminalUsage` at 67–70). Add a local import for the call site at 240:
  `import { makeLogUsage } from './usage-logging.js';` AND a re-export for the test path:

  ```ts
  // Re-exported for import-path stability (moved to ./usage-logging.ts).
  export { makeLogUsage } from './usage-logging.js';
  ```
- [ ] `npm run build` — confirm no `noUnusedLocals` breakage. Verify the handler still uses
  `IRequestLogger`/`LlmComponent`/`LlmUsage` elsewhere (it does: `ControllerHandlerDeps`,
  `TerminalUsage`, `logUsage` calls) — do NOT prune those from the handler's llm-agent import.
- [ ] Lint gate + test gate: run `usage-logging.test.ts`, `usage-e2e.test.ts`,
  `controller-coordinator-handler.test.ts` → GREEN. `wc -l usage-logging.ts` (< 500).
- [ ] **Commit:** `refactor(controller): extract usage-logging.ts (R-util)`

---

### Task 4 — `controller/recall.ts`: move R3 cluster

**Files:** create `controller/recall.ts`; modify `controller-coordinator-handler.ts`
(imports for call sites + re-exports, delete cluster, drop `cosine` import, prune `KnowledgeEntry`).

**Interfaces (byte-identical):**
- `runScopedRecall(rag, text, k, runId, kPrime, artifactType, options?): Promise<readonly KnowledgeEntry[]>`
- `relevantExtract(content, ref, maxChars, embedder, options?): Promise<string>`
- `collectApproved(rag, runId): Promise<{ seq: number; content: string }[]>`
- `buildRecallBlock(hits, maxChars): string | undefined`
- internal: `rankStatus`, `isBetterStep`, `isBetterMcp`

**Grounding facts (grep-verified):**
- Cluster declarations: `buildRecallBlock` 1650, `collectApproved` 1857, `runScopedRecall` 1895,
  `rankStatus` 1944, `isBetterStep` 1960, `isBetterMcp` 1976, `relevantExtract` 1995;
  `MAX_EXTRACT_WINDOWS` const 1983; recall constants 1634–1642
  (`RECALL_ARTIFACT_TYPES`, `RECALL_K_STEP`, `RECALL_K_MCP`, `RECALL_MAX_CHARS_STEP`,
  `RECALL_MAX_CHARS_MCP`, `RECALL_EVIDENCE_CHARS`).
- `cosine` (imported at handler line 23 from `../embedder-knowledge-index.js`) is used ONLY inside
  `relevantExtract` (line 2017) — it moves entirely to `recall.ts`; the handler drops the import.
- Handler CALL SITES that must keep working (so the handler locally imports these from `./recall.js`):
  `runScopedRecall` (952, 961, 1011), `buildRecallBlock` (972, 973), `relevantExtract` (1021),
  `collectApproved` (1403 in `finalize()`), and the constants `RECALL_K_STEP` (955, 957, 1007),
  `RECALL_K_MCP` (964), `RECALL_ARTIFACT_TYPES` (1017), `RECALL_EVIDENCE_CHARS` (1024)
  — `RECALL_MAX_CHARS_STEP` (972), `RECALL_MAX_CHARS_MCP` (973). `rankStatus`/`isBetterStep`/
  `isBetterMcp` are called ONLY by `runScopedRecall`/each other → stay internal (not exported).
- `run-scoped-recall.test.ts` imports `runScopedRecall` + `relevantExtract` from
  `../controller-coordinator-handler.js` (lines 9–11) → both need a handler re-export.

**Steps:**

- [ ] Create `controller/recall.ts`. Import block (derived from exactly the bodies' deps):

  ```ts
  import {
    type CallOptions,
    type IEmbedder,
    type IKnowledgeRagHandle,
    type KnowledgeEntry,
  } from '@mcp-abap-adt/llm-agent';
  import { cosine } from '../embedder-knowledge-index.js';
  import { type Outcome, resolveByPrecedence } from './outcome.js';
  ```
- [ ] Move BYTE-FOR-BYTE into `recall.ts` (preserving JSDoc, `export` keywords, and the
  `// biome-ignore` lines inside `runScopedRecall`): the 6 recall constants (1634–1642),
  `buildRecallBlock` (1648–1669), `collectApproved` (1854–1884), `runScopedRecall` (1886–1941),
  `rankStatus` (1943–1952), `isBetterStep` (1954–1971), `isBetterMcp` (1973–1981),
  `MAX_EXTRACT_WINDOWS` (1983) + `relevantExtract` (1984–2026). Keep the pre-existing exports on
  `runScopedRecall`/`relevantExtract`; ADD `export` to the constants + `buildRecallBlock` +
  `collectApproved` (the handler imports them); leave `rankStatus`/`isBetterStep`/`isBetterMcp`/
  `MAX_EXTRACT_WINDOWS` unexported (internal).
- [ ] In `controller-coordinator-handler.ts`: DELETE all the moved declarations (1634–1642 constants
  + the "Pure helpers" cluster block covering `buildRecallBlock` through `relevantExtract`, i.e.
  1648–2026 EXCEPT the R1-residual helpers that live in that region — `extractPrompt` 1671–1679,
  `synthMeta` 1808–1822, `mapOutcome` 1824–1832, `recordStepControl` 1834–1852 STAY; move only the
  recall members listed above). Remove the `cosine` import (line 23). Add local imports for the call
  sites:

  ```ts
  import {
    buildRecallBlock,
    collectApproved,
    RECALL_ARTIFACT_TYPES,
    RECALL_EVIDENCE_CHARS,
    RECALL_K_MCP,
    RECALL_K_STEP,
    RECALL_MAX_CHARS_MCP,
    RECALL_MAX_CHARS_STEP,
    relevantExtract,
    runScopedRecall,
  } from './recall.js';
  ```
  and the re-exports for the test path:

  ```ts
  // Re-exported for import-path stability (moved to ./recall.ts).
  export { relevantExtract, runScopedRecall } from './recall.js';
  ```
- [ ] `npm run build` — tsc flags `KnowledgeEntry` as now-unused in the handler's llm-agent import
  (it was used only by the moved recall functions). **Prune `type KnowledgeEntry` from the handler's
  `@mcp-abap-adt/llm-agent` import block.** Confirm `IEmbedder` (still used by `ControllerHandlerDeps.
  embedder?`), `IKnowledgeRagHandle`, `CallOptions` remain used and are kept. Confirm
  `resolveByPrecedence` is STILL imported by the handler (used at 389, 607 outside `collectApproved`)
  — keep it.
- [ ] Lint gate + test gate: run `run-scoped-recall.test.ts`, `controller-coordinator-handler.test.ts`,
  `usage-e2e.test.ts` → GREEN. `wc -l recall.ts` (< 500).
- [ ] **Commit:** `refactor(controller): extract recall.ts (R3)`

---

### Task 5 — inline `toLlmToolCall` (R4)

**Files:** modify `controller-coordinator-handler.ts` only.

**Grounding facts:** `toLlmToolCall` is a non-exported module-scope function at `1753`–`1782`, with
ZERO external importers, called at EXACTLY one site inside `runStep` — line `1207`:
`const call = toLlmToolCall(firstCall);` followed by `const name = call.name;` and
`const args = call.arguments;`. Types `StreamToolCall`/`LlmToolCall` are imported at the top.

**Steps:**

- [ ] At the call site (1207), replace `const call = toLlmToolCall(firstCall);` by expanding the
  function body inline against `firstCall` (byte-equivalent logic), producing the same `call`
  object so the subsequent `const name = call.name;` / `const args = call.arguments;` are unchanged:

  ```ts
  // Normalize the StreamToolCall (full or delta) into an LlmToolCall inline.
  const call: LlmToolCall =
    'arguments' in firstCall &&
    typeof firstCall.arguments === 'object' &&
    firstCall.arguments !== null
      ? {
          id: ('id' in firstCall && firstCall.id) || 'call',
          name: ('name' in firstCall && firstCall.name) || '',
          arguments: firstCall.arguments as Record<string, unknown>,
        }
      : {
          id: ('id' in firstCall && firstCall.id) || 'call',
          name: ('name' in firstCall && firstCall.name) || '',
          arguments: (() => {
            const raw = 'arguments' in firstCall ? firstCall.arguments : undefined;
            if (typeof raw === 'string' && raw.length > 0) {
              try {
                return JSON.parse(raw) as Record<string, unknown>;
              } catch {
                return {};
              }
            }
            return {};
          })(),
        };
  ```
  (Logic is identical to the original two-branch function; the delta branch's IIFE preserves the
  `try/catch → {}` fallback. If preferred, keep the original imperative `let args` form in a small
  block instead — either is acceptable so long as behavior is byte-equivalent.)
- [ ] DELETE the `toLlmToolCall` declaration + JSDoc (1753–1782).
- [ ] `npm run build` — confirm `StreamToolCall` / `LlmToolCall` are still used
  (`LlmToolCall` at the inline + `surfaceToolCall` param 1564; `StreamToolCall` at `firstCall`'s
  type site). Prune `StreamToolCall` from the handler's llm-agent import ONLY if tsc reports it unused.
- [ ] Lint gate + test gate: run `round-trip.test.ts`, `controller-coordinator-handler.test.ts`
  (exercise the external-tool path) → GREEN.
- [ ] **Commit:** `refactor(controller): inline toLlmToolCall (R4)`

---

### Task 6 — residual cleanup

**Files:** modify `controller-coordinator-handler.ts` only.

**Steps:**

- [ ] Review every barrel re-export added in Tasks 1–4
  (`parser.ts`, `board.ts`, `usage-logging.ts`, `recall.ts`). Each is required by a TEST import path
  (`parseNextStep`/`extractJsonObject`, `renderLiveBoard`, `makeLogUsage`, `runScopedRecall`/
  `relevantExtract`). Confirm via grep that each re-exported symbol is imported by at least one test
  from `../controller-coordinator-handler.js`; remove any re-export that no test consumes
  (do NOT remove `extractJsonObject`/`parseNextStep`/`makeLogUsage`/`renderLiveBoard`/
  `runScopedRecall`/`relevantExtract` — all are grep-confirmed test-imported or blueprint-mandated
  safety nets).
- [ ] Consolidate the re-export lines into a single clearly-commented block near the top of the file
  (after `ControllerHandlerDeps` / `TerminalUsage`), and tighten the now-stale section-header comments
  in the shrunken handler (e.g. the "Episodic recall tuning" / "Pure helpers" banners that lost their
  content). No logic change.
- [ ] `wc -l controller-coordinator-handler.ts` — expect ~1350; `wc -l` all new modules (each < 500).
- [ ] `npm run build` (green) + lint gate (`npm run format` → biome check → `npm run lint:check`
  exit 0).
- [ ] Full controller test sweep single-file over: `controller-coordinator-handler.test.ts`,
  `round-trip.test.ts`, `run-scoped-recall.test.ts`, `board.test.ts`, `usage-logging.test.ts`,
  `planner.test.ts`, `planner.skills.test.ts`, `reviewer.test.ts`, `usage-e2e.test.ts`,
  `select-tools-options.test.ts` → all GREEN.
- [ ] **Commit:** `refactor(controller): residual cleanup`

---

## Self-check (blueprint §6 principles)

- **Build ON components:** R2 reuses `board.ts`; R3 parameterized on `IKnowledgeRagHandle`/`IEmbedder`;
  R-util on `IRequestLogger`; all new modules land in the existing controller sibling family. ✅
- **Interfaces:** pure-function modules; the signatures ARE the interface — no widened/new interface. ✅
- **Don't break components:** all production blast-radius importers (`controller-factory.ts`,
  `pipelines/controller.ts`, and all tests) keep their paths via handler re-exports; only
  `planner.ts` + `reviewer.ts` change to `./parser.js` (the inverted-dep fix, correct direction). ✅
- **Control file size:** 2026 → ~1350 residual + 3 new modules (< 500 each) + enriched `board.ts`. ✅
