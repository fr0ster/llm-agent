# Monolith Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the audit document `docs/superpowers/specs/2026-06-26-monolith-audit.md` — a triage table of every over-grown source file plus deep, component-first decomposition blueprints for the top-N — per the charter spec, changing NO product code.

**Architecture:** This is an **analysis/documentation** deliverable, not code. Each task produces one section of the audit document; "verification" is mechanical (sweep output matches the table; every required column/subsection present; every blueprint runs the 7-principle self-check) rather than unit tests. Order: build the component-catalog reference → triage every file (which yields priority) → write a blueprint per top-priority file → synthesize.

**Tech Stack:** Markdown; shell (`find`, `wc -l`, `grep`, `rg`) for sweeping and responsibility-clustering; reading the source. No product code is modified.

## Global Constraints

(Copied from the charter spec `docs/superpowers/specs/2026-06-26-monolith-audit-design.md` — every task inherits these.)

- **No product-code changes** — analysis + the audit document only.
- **Components-first** — for each responsibility, FIRST check the component catalog (Task 1); propose EXTRACT a new module only when no existing component fits, and only if it is reusable + interface-bounded.
- **The 7 Architecture Principles** (`docs/ARCHITECTURE.md` → Architecture Principles) govern every recommendation; each blueprint self-checks against all 7.
- **Behavior-preserving** — blueprints describe refactors that do not change behavior, and name the characterization tests that guarantee it.
- **One monolith per future plan/PR** — the audit feeds *separate* plans; it bundles no refactors.
- **Public API stays stable** — extractions must not break published package exports; a forced break is flagged explicitly as needing a version bump.
- **Sweep excludes** (binding): `**/node_modules/**`, tests (`*.test.ts`, `__tests__/`), `dist/`/`build/`, `coverage/`, generated (`*.d.ts`), vendored third-party.

**Audit document section order (the deliverable's table of contents):**
1. Scope & method (short preamble) · 2. Component catalog reference (Task 1) · 3. Triage table (Task 2) · 4. Blueprints (Tasks 3–N) · 5. Synthesis & first refactor (final task).

---

## Task 1: Component catalog reference

**Files:**
- Create: `docs/superpowers/specs/2026-06-26-monolith-audit.md` (start the doc; add the "Component catalog reference" section)

**Interfaces:**
- Produces: the **catalog table** every later task consults for "components-first" — a list of existing reusable components/interfaces with one-line "what it owns", so a responsibility can be matched to "REUSE `X`".

- [ ] **Step 1: Enumerate the public interfaces (the contracts package)**

Run:
```bash
rg -n "^export (interface|type|class|function|const) " packages/llm-agent/src/interfaces/index.ts | head -200
```
Also list the building-block packages' public exports:
```bash
for p in llm-agent-mcp llm-agent-rag llm-agent-libs llm-agent-server-libs; do
  echo "== $p =="; sed -n '1,80p' packages/$p/src/index.ts
done
```

- [ ] **Step 2: Write the catalog table**

In the audit doc, add a `## Component catalog reference` section: a table of the
reusable components/interfaces that a monolith's responsibilities could be reimplemented
on. Columns: **Component / interface** · **Package** · **Owns (one line)**. Include at
least: `IMcpConnectionStrategy` + `Lazy/Periodic/Noop` + `makeConnectionStrategy`,
`IReadinessReporter`, `IMcpClient`/`McpClientAdapter`, the pipeline `IStageHandler` +
stage handlers, `IPipelinePlugin` + the builder-factories (`LinearFactory`, `DagFactory`,
…), `IPipelineFactory`, `HealthChecker`, `ISessionManager`/session stores, the LLM
factories (`makeLlm`), RAG (`makeRag`, `resolveEmbedder`), `IRequestLogger`, the config
parsers (`parseLinearConfig`, `parseStepperCoordinatorConfig`, …). One row each.

- [ ] **Step 3: Verify completeness**

Run: `rg -c "^\| " docs/superpowers/specs/2026-06-26-monolith-audit.md` — expect ≥ 15
catalog rows. Confirm each row names a real export (spot-check 3 via `rg <name> packages/*/src/index.ts`).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-26-monolith-audit.md
git commit -m "docs(audit): component catalog reference"
```

---

## Task 2: Triage table — every file over the threshold

**Files:**
- Modify: `docs/superpowers/specs/2026-06-26-monolith-audit.md` (add the triage section)

**Interfaces:**
- Consumes: the catalog (Task 1) for the "component-fit" judgement.
- Produces: the **priority ranking** that selects which files get a deep blueprint (Tasks 3–N).

- [ ] **Step 1: Re-sweep the repo (with the binding excludes)**

Run (this is the authoritative file list; `packages/*/src` already excludes node_modules):
```bash
find packages/*/src -name "*.ts" ! -name "*.test.ts" ! -path "*/__tests__/*" ! -name "*.d.ts" \
  | xargs wc -l 2>/dev/null | awk '$1>500 && $2!="total"{print $1"\t"$2}' | sort -rn
```
Expected: ~13 files; `smart-server.ts` (~3.9k) first. If the count drifts from the
charter's snapshot, use the live result (the threshold is the trigger).

- [ ] **Step 2: For each file, identify its responsibilities**

For each swept file, cluster its jobs. Useful probes (adapt per file):
```bash
F=packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
rg -n "^\s*(private|public|async|export function) [A-Za-z_]+\(" "$F" | head -80   # method inventory
rg -n "urlPath ===|req.method ===|new HealthChecker|connectMcp|buildSubAgent|_handleChat" "$F"  # route/concern markers
```
Name 2–6 distinct responsibilities per file (the jobs it does).

- [ ] **Step 3: Write the triage table**

Add a `## Triage` section. One row per swept file with the charter's columns:
**File / lines · Responsibilities (count + names) · Principle violated · Split risk
(low/med/high) · Blast radius (importers) · Driver (why it grew) · Priority**.

Compute **Blast radius** per file:
```bash
# importers of a module (adjust the import path/name)
rg -l "from '.*/smart-server" packages --type ts | grep -v "__tests__" | wc -l
```
Compute **Priority** = a rank from `f(lines, #responsibilities, blastRadius, componentFit)`
— state the ordering explicitly (1 = do first). componentFit = how cleanly the
responsibilities map onto the Task-1 catalog (clean map ⇒ higher priority: cheap + high value).

- [ ] **Step 4: Verify table ↔ sweep consistency**

Confirm EVERY file from Step 1 has exactly one triage row and every row has all 7
columns filled (no blanks). Run the Step-1 sweep again and diff the file set against the
table's File column — they must match.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-26-monolith-audit.md
git commit -m "docs(audit): triage table (all files >500 lines)"
```

---

## Task 3: Blueprint — `smart-server.ts`

**Files:**
- Modify: `docs/superpowers/specs/2026-06-26-monolith-audit.md` (add the smart-server blueprint)

**Interfaces:**
- Consumes: catalog (Task 1) + this file's triage row (Task 2).
- Produces: a blueprint section with the six subsections defined below (the template all blueprint tasks reuse).

- [ ] **Step 1: Map responsibilities to line ranges / method clusters**

Run:
```bash
F=packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
rg -n "^\s*(private|public|async|static) [A-Za-z_]+\s*\(" "$F"        # method inventory + line numbers
rg -n "urlPath ===|_handle|_withSession|HealthChecker|connectMcp|buildSubAgent|buildSessionAgent|_makeLlm|writeNotReady" "$F"
```
Write subsection **1. Responsibility map** — each job with its method names / line ranges
(e.g. HTTP routing `_handle`/`_handleChat`; infra build `_buildInfra`; MCP wiring
`callMcp`/`buildMcpBridge`; LLM resolution `_makeLlm`/`resolveRoleLlm`; worker build
`buildSubAgent`/`buildWorkerRegistry`; session handling `_withSession`).

- [ ] **Step 2: Subsection 2 — Seams**

State the natural cut lines (method groups + their shared state). Note which state each
group reads/writes (e.g. `_sharedMcpClients`, `_workerLlmCache`) — shared state across a
proposed seam is a coupling cost the blueprint must call out.

- [ ] **Step 3: Subsection 3 — Decomposition target per responsibility (components-first)**

For EACH responsibility, write "REUSE existing component `X`" (from the Task-1 catalog)
or "EXTRACT new module `Y` (interface-bounded, reusable)". Justify each. Prefer REUSE;
EXTRACT only when no catalog component fits. (Example shape: HTTP routing → EXTRACT a
small `HttpRouter`/handler-table module; MCP lifecycle/health → REUSE
`IMcpConnectionStrategy` + `IReadinessReporter`; LLM resolution → REUSE `makeLlm` +
existing role-resolver.)

- [ ] **Step 4: Subsection 4 — Behavior-preservation strategy**

Name the characterization tests that pin current behavior (existing ones to lean on +
any to add BEFORE refactoring). Note the public-API surface that must stay stable
(`SmartServer` exports, route shapes).

- [ ] **Step 5: Subsection 5 — Suggested PR slices**

An ordered list of small, independently-reviewable PRs (one extraction / one
reimplementation each), with a rough line-delta and risk per slice. The first slice
should be the lowest-risk, highest-value cut.

- [ ] **Step 6: Subsection 6 — Principle self-check**

A 7-row check (each Architecture Principle) confirming the proposed decomposition
complies — especially #1 (build-on-components), #2 (no ad-hoc fragments), #6 (file size).

- [ ] **Step 7: Verify the blueprint is complete & commit**

Confirm all six subsections are present and every responsibility from Step 1 has a
target in Step 3. Then:
```bash
git add docs/superpowers/specs/2026-06-26-monolith-audit.md
git commit -m "docs(audit): blueprint — smart-server.ts"
```

---

## Task 4: Blueprint — `agent.ts`

**Files:**
- Modify: `docs/superpowers/specs/2026-06-26-monolith-audit.md`

**Interfaces:**
- Consumes: catalog + triage row. Produces: a blueprint with the same six subsections as Task 3.

- [ ] **Step 1: Responsibilities → method clusters**

Run:
```bash
F=packages/llm-agent-libs/src/agent.ts
rg -n "^\s*(private|public|async) [A-Za-z_]+\s*\(" "$F" | head -80
rg -n "_runStreamingToolLoop|streamProcess|healthCheck|isReady|classifyToolResult|toolClientMap|heartbeat" "$F"
```
Likely jobs: the streaming tool loop (the biggest — candidate to extract, mirrors the
pipeline `tool-loop.ts`), classification/RAG orchestration, health/readiness, config.

- [ ] **Steps 2–6: same six-subsection template as Task 3**

Fill subsections 2–6 (Seams · Decomposition target components-first · Behavior-preservation ·
PR slices · Principle self-check). For the tool loop, note the existing pipeline
`ToolLoopHandler` + `classifyToolResult` as REUSE/share targets (the two loops already
share `classifyToolResult`; the blueprint should propose converging them).

- [ ] **Step 7: Verify complete & commit**

```bash
git add docs/superpowers/specs/2026-06-26-monolith-audit.md
git commit -m "docs(audit): blueprint — agent.ts"
```

---

## Task 5: Blueprint — `controller-coordinator-handler.ts`

**Files:**
- Modify: `docs/superpowers/specs/2026-06-26-monolith-audit.md`

**Interfaces:**
- Consumes: catalog + triage row. Produces: a six-subsection blueprint.

- [ ] **Step 1: Responsibilities → method clusters**

Run:
```bash
F=packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts
rg -n "^\s*(private|public|async) [A-Za-z_]+\s*\(" "$F" | head -80
rg -n "evaluator|planner|executor|reviewer|finalizer|recover|rewind|board|digest" "$F"
```
Note neighbours already extracted (`controller/planner.ts`, `plan-analysis.ts`) — the
blueprint should map responsibilities onto that existing controller component family.

- [ ] **Steps 2–6: six-subsection template (as Task 3)**

- [ ] **Step 7: Verify complete & commit**

```bash
git add docs/superpowers/specs/2026-06-26-monolith-audit.md
git commit -m "docs(audit): blueprint — controller-coordinator-handler.ts"
```

---

## Task 6: Blueprint — `config.ts`

**Files:**
- Modify: `docs/superpowers/specs/2026-06-26-monolith-audit.md`

**Interfaces:**
- Consumes: catalog + triage row. Produces: a six-subsection blueprint.

- [ ] **Step 1: Responsibilities → method clusters**

Run:
```bash
F=packages/llm-agent-server-libs/src/smart-agent/config.ts
rg -n "^export (function|interface|type|const) [A-Za-z_]+" "$F"
rg -n "resolveSmartServerConfig|validate|parse[A-Za-z]+Config|checkLlmRole|checkRagStore" "$F"
```
Likely jobs: YAML→config resolution, validation, per-section parsers (already partly
discrete functions — a natural split by section parser).

- [ ] **Steps 2–6: six-subsection template (as Task 3)** — EXTRACT here likely means
  splitting the per-section parsers/validators into their own small modules (each
  parser already a discrete function → low-risk, high-value); REUSE where a parser
  belongs to an existing component (e.g. pipeline factory configs).

- [ ] **Step 7: Verify complete & commit**

```bash
git add docs/superpowers/specs/2026-06-26-monolith-audit.md
git commit -m "docs(audit): blueprint — config.ts"
```

---

## Task 7: Blueprint — `builder.ts` (tech-debt-named; mandatory per charter §3b)

**Files:**
- Modify: `docs/superpowers/specs/2026-06-26-monolith-audit.md`

**Interfaces:**
- Consumes: catalog + triage row. Produces: a six-subsection blueprint.

- [ ] **Step 1: Responsibilities → method clusters**

Run:
```bash
F=packages/llm-agent-libs/src/builder.ts
rg -n "^\s*(private|public|async) [A-Za-z_]+\s*\(|with[A-Z][A-Za-z]+\(" "$F" | head -100
rg -n "mcpConfigs|makeConnectionStrategy|vectoriz|toolsRag|upsertRaw|resolve\(\[\]\)" "$F"
```
Call out the **MCP block's tool vectorization** (the active accumulation point named in
`docs/ARCHITECTURE.md` tech-debt) as the prime EXTRACT candidate → a small
`vectorize-mcp-tools.ts` module consumed by the builder (already flagged in the
Architecture doc).

- [ ] **Steps 2–6: six-subsection template (as Task 3)**

- [ ] **Step 7: Verify complete & commit**

```bash
git add docs/superpowers/specs/2026-06-26-monolith-audit.md
git commit -m "docs(audit): blueprint — builder.ts"
```

> If Task 2's priority ranking surfaces a 6th file above `tool-loop.ts`-priority (e.g.
> `tool-loop.ts` itself), add a Task 7b with the SAME six-subsection template for it.
> The charter sets N ≈ 5 (priority-driven, mandatory-include tech-debt files), so 5–6
> blueprints total.

---

## Task 8: Synthesis & first refactor; audit self-review; cleanup

**Files:**
- Modify: `docs/superpowers/specs/2026-06-26-monolith-audit.md` (add the synthesis section)
- Delete: `docs/superpowers/specs/2026-06-26-monolith-audit-design.md` (charter) and `docs/superpowers/plans/2026-06-26-monolith-audit.md` (this plan) — per the repo convention (kept only while active; the audit document is now the lasting artifact, itself active until the refactor campaign completes).

- [ ] **Step 1: Write the synthesis**

Add a `## Synthesis` section: the final priority-ordered refactor sequence, and a clear
call-out of **the single highest-value, lowest-risk first refactor to start with** (the
charter's success criterion) — with one sentence of why.

- [ ] **Step 2: Audit self-review (fresh eyes)**

Check the whole audit doc: (a) every swept file is in the triage table; (b) every
top-priority file (incl. tech-debt-named `builder.ts`) has a complete six-subsection
blueprint; (c) every recommendation is components-first (REUSE named, or EXTRACT
justified as reusable/interface-bounded); (d) no placeholders/TBD; (e) each blueprint's
principle self-check is filled. Fix inline.

- [ ] **Step 3: Remove the charter spec + this plan; commit the audit + cleanup**

```bash
git rm docs/superpowers/specs/2026-06-26-monolith-audit-design.md docs/superpowers/plans/2026-06-26-monolith-audit.md
git add docs/superpowers/specs/2026-06-26-monolith-audit.md
git commit -m "docs(audit): synthesis + first-refactor pick; retire charter & plan"
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --base main --title "docs(audit): monolith audit — triage + decomposition blueprints" --body "Audit-only (no product code). Triage of all src files >500 lines + component-first decomposition blueprints for the top-priority monoliths (incl. builder.ts per tech-debt). Feeds separate per-monolith refactor plans. Principle self-checks per blueprint."
```

---

## Self-Review (plan ↔ charter spec)

- §2 Scope (sweep + binding excludes) → Task 2 Step 1 (excludes applied) ✓
- §3a Triage table (all files, all columns) → Task 2 ✓
- §3b Deep blueprints, priority-driven N≈5, MUST include tech-debt-named → Tasks 3–7 (smart-server, agent, controller-coordinator-handler, config, builder) + Task 7b hook ✓
- §4 Method: components-first + prioritization + risk inputs → Task 1 (catalog), Task 2 Step 3 (priority + componentFit), blueprint Step 3 ✓
- §5 Constraints (7 principles, no code change, behavior-preserving, one-monolith-per-plan, stable API) → Global Constraints + each blueprint subsections 4 & 6 ✓
- §6 Out of scope (no refactoring) → enforced: plan changes only the audit doc ✓
- §7 Success criteria (every file triaged; top-N blueprints; component-first; name first refactor) → Tasks 2, 3–7, Task 8 Step 1 ✓
- No placeholders: each task gives exact commands + the output schema (the six-subsection template); no "TBD". ✓
