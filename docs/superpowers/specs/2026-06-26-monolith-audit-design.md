# Monolith Audit — Design

**Status:** draft (awaiting review)
**Date:** 2026-06-26
**Goal:** Produce a repo-wide **audit + decomposition blueprint** of over-grown source
files — **without changing any code** — that future per-monolith plans can consume.
This spec is the audit's *charter*: it fixes the task, the constraints, and the exact
shape of the deliverable. Producing the audit document is a separate step (a plan).

---

## 1. Why

The MCP-readiness work surfaced that the codebase has accreted several god-objects
(e.g. `smart-server.ts` ~3.9k lines) that violate the binding **Architecture
Principles** (`docs/ARCHITECTURE.md`): the app stopped *consuming* components and
started *accreting* bespoke glue. Before refactoring, we need a clear-eyed map of
WHAT is over-grown, WHY, and HOW each should be reduced — done once, thoroughly, so
the actual refactors are well-scoped, component-first, and low-risk.

This is an **audit-first** effort: analysis only. No code changes here.

---

## 2. Scope

- **All** source files under `packages/*/src/**` that are **> 500 lines**. A whole-repo
  sweep, not just the known three.
- **Binding excludes** (the sweep MUST filter these out — a naive glob otherwise pulls
  in large vendored files, e.g. Zod under `packages/*/node_modules/**/src/**`):
  `**/node_modules/**`, test files (`*.test.ts`, `__tests__/`), build output
  (`dist/`, `build/`), `coverage/`, generated files (`*.d.ts`, codegen output), and any
  vendored third-party code. With `node_modules` excluded, the snapshot below matches
  current HEAD.
- **Snapshot at authoring time (2026-06-26), 13 files > 500:**

  | Lines | File |
  |------:|------|
  | 3926 | `llm-agent-server-libs/.../smart-server.ts` |
  | 2160 | `llm-agent-libs/src/agent.ts` |
  | 2026 | `llm-agent-server-libs/.../controller/controller-coordinator-handler.ts` |
  | 1648 | `llm-agent-server-libs/.../config.ts` |
  | 1437 | `llm-agent-libs/src/builder.ts` |
  | 1004 | `llm-agent-libs/.../pipeline/handlers/tool-loop.ts` |
  | 769 | `llm-agent-libs/.../skills/plugin-host/qdrant-store.ts` |
  | 554 | `sap-aicore-llm/.../sap-core-ai-provider.ts` |
  | 543 | `llm-agent-libs/src/testing/index.ts` |
  | 542 | `llm-agent-libs/.../pipeline/default-pipeline.ts` |
  | 536 | `llm-agent-libs/.../pipeline/handlers/dag-coordinator.ts` |
  | 509 | `llm-agent-server-libs/.../controller/plan-analysis.ts` |
  | 507 | `llm-agent-mcp/src/client.ts` |

- The audit RE-SWEEPS at execution time (the list may shift); 500 is the trigger, not
  a hard cliff — a 480-line file with five responsibilities is fair game to note.

---

## 3. Deliverable

A single document: `docs/superpowers/specs/2026-06-26-monolith-audit.md` (the audit
itself — distinct from this charter), with two parts.

### 3a. Triage table — EVERY file over the threshold

One row per file:

| Column | Meaning |
|---|---|
| File / lines | path + current line count |
| Responsibilities | count + short names (the distinct jobs the file does) |
| Principle violated | which of the 7 (usually #6 file-size, often #2 app-bespoke-glue) |
| Split risk | low / med / high — driven by public-API surface, test coverage, hot-path |
| Blast radius | how many modules import/depend on it |
| Driver | one line: WHY it grew (accretion of which features) |
| Priority | rank to tackle (function of size × #responsibilities × blast-radius × component-fit) |

### 3b. Deep decomposition blueprint — top **N ≈ 5, PRIORITY-driven**

Selection is by the triage **priority** rank (§4), NOT raw line count — otherwise a
high-value target just under the line cliff is left without a blueprint even though the
audit may name it the first refactor to start with. Concretely:

- Take the top **~5** files by priority, AND
- **MUST include any file already named in `docs/ARCHITECTURE.md` → Current Technical
  Debt** (currently `builder.ts` — the active MCP lifecycle/vectorization accumulation
  point — and `agent.ts`).

At authoring time that yields at least: `smart-server.ts`, `agent.ts`,
`controller-coordinator-handler.ts`, `config.ts`, `builder.ts` (the four > 1500 plus
the tech-debt-named `builder.ts`). The audit re-ranks at execution time and adjusts the
exact set; `tool-loop.ts` (1004) is the likely 6th if priority warrants. Each blueprint
contains:

1. **Responsibility map** — the distinct jobs, with line ranges / method clusters.
2. **Seams** — the natural cut lines (method groups, import clusters, data boundaries).
3. **Decomposition target per responsibility** — *components-first* (see §4):
   "REUSE existing component `X`" or "EXTRACT new small module `Y` (interface-bounded,
   reusable)". State which, and why, for each responsibility.
4. **Behavior-preservation strategy** — how the refactor stays behavior-identical
   (characterization tests to lean on / add; public API kept stable).
5. **Suggested slices** — an ordered list of small, independently-reviewable steps
   (one extraction / one reimplementation each), with a rough size and risk per slice.
   **Delivery: one PR per monolith** — the slices are ordered, behavior-preserving
   *commits* inside that single PR (commit = review unit, PR = delivery unit); a monolith
   is never split across two PRs (a half-decomposed file risks an inconsistent state and a
   dropped slice/seam).
6. **Per-blueprint principle self-check** — the 7 principles, checked against the
   proposed decomposition.

---

## 4. Method & criteria

- **Components-first (the primary constraint).** For each responsibility: FIRST search
  the component catalog (`@mcp-abap-adt/llm-agent` interfaces + the `*-mcp` / `*-rag` /
  `*-libs` building blocks) — does a component already do this? If yes, the blueprint
  is "reimplement on `X`". Only when NO component fits does it propose EXTRACT a new
  module, and that module MUST be small + interface-bounded + reusable (a component,
  not an ad-hoc fragment of the monster).
- **Prioritization** = `f(lines, #responsibilities, blastRadius, componentFit)`.
  A file that maps cleanly onto existing components ranks higher (cheap, high-value);
  a tangled hot-path with a wide public API ranks lower (do later, carefully).
- **Risk rating inputs:** exported public API surface, current test coverage of the
  file, whether it is on the per-request hot path.

---

## 5. Constraints (binding — recorded here so plans inherit them)

1. **The 7 Architecture Principles** (`docs/ARCHITECTURE.md`) govern every
   recommendation; each blueprint self-checks against them.
2. **No code changes in the audit** — analysis + documents only.
3. **Behavior-preserving** — future refactors must not change behavior; blueprints
   call out the characterization tests that guarantee it.
4. **One monolith per future plan/PR** — the audit feeds *separate* plans; it does not
   bundle refactors.
5. **Public API stays stable** — extractions must not break published package exports
   (or, where a break is unavoidable, the blueprint flags it explicitly as a breaking
   change needing a version bump).
6. **Component-first over extract-new** (see §4).

---

## 6. Out of scope

- The actual refactoring/extraction (each becomes its own plan after this audit).
- Non-size code-quality concerns (naming, micro-perf) unless they block a clean split.
- Test files (excluded from the sweep), though a blueprint may note missing
  characterization coverage as a prerequisite for its refactor.

---

## 7. Success criteria

- Every file over the threshold appears in the triage table with a priority.
- The top-N-by-priority (§3b — ~5, including any tech-debt-named file such as
  `builder.ts`) each have an actionable blueprint a future plan can consume directly
  (responsibilities → seams → component-first targets → PR slices → principle check).
- Every recommendation is component-first and principle-compliant; any proposed new
  module is justified as reusable/interface-bounded, not an ad-hoc fragment.
- The audit names the single highest-value, lowest-risk first refactor to start with.
