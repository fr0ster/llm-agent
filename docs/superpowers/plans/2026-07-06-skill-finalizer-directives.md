# Skill Delivery-Directives → Finalizer (#212) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task ends in exactly one commit; run the pinning tests and the SCOPED lint gate before committing.

**Goal:** Let a recalled `controllerSkillGroup` skill influence the controller finalizer's DELIVERED text (so an output/delivery directive in a skill — e.g. a required footer line — is honored in the final answer), while keeping the engine AGNOSTIC.

**Architecture:** The recall seam already exists — `deps.skillsRecall(goal, options)` produces a bounded skills block that today only reaches the planner. Thread that SAME block into the finalizer via a NEW focused `FinalizeOpts.skillsBlock` field (ISP — not the static config `hint`), put the block in the finalizer's USER message, and add ONE generic honor-clause to `FINALIZE_SYSTEM`. The clause is agnostic — it tells the finalizer to honor whatever output/delivery directives the skills block states; the CONSUMER's skill decides the content. No parsing of "which part is a directive" (the LLM finalizer applies it under the generic instruction).

**Tech Stack:** TypeScript (ESM `.js` imports), `node:test` + `tsx`, Biome. Package `@mcp-abap-adt/llm-agent-server-libs` (controller + docs).

## Global Constraints

- **Engine stays AGNOSTIC (hard requirement).** The `FINALIZE_SYSTEM` clause must be a GENERIC "honor output/delivery/formatting directives present in the provided skills block" — NO domain content, NO consumer decisions, NO examples that prescribe what a skill should contain. This mirrors the existing `appendHint` contract (prompts.ts: "a hint is NOT a domain description"). The skill (consumer-configured) supplies the actual directive; the engine only honors it generically.
- **Do NOT invent facts.** The finalizer must still "not invent facts beyond the provided results" — the skills block governs DELIVERY/FORMATTING only, not content. Keep that guard in `FINALIZE_SYSTEM`.
- **Behavior-preserving when no skill is configured.** With `deps.skillsRecall` absent or an empty block, the finalizer prompt is UNCHANGED (no skills section). `FinalizeOpts.skillsBlock` is optional.
- **Component-shaped, minimal.** Reuse the existing `skillsRecall` hook + the `FinalizeOpts` seam; do NOT touch the planner, executor, reviewer, or add cross-package plumbing. `IFinalizer.finalize` positional signature (`goal, request, approvedResults, opts`) is UNCHANGED — the new field rides in `opts`.
- ESM `.js`, TS strict, Biome. `noUnusedLocals: true`.
- **SCOPED lint gate per task:** `npx @biomejs/biome check --write <changed files>` → `npm run lint:check` **exit 0**. NOT the global `npm run format`.
- **Commit ONLY this task's files:** `git status --short`, `git add` explicit paths (NOT `-A`/`.`).
- **Release is HELD** — this is the last of the post-20.1.0 batch (#219, #211, #220 merged); after this merges, bump + publish.

---

## File Structure

- `packages/llm-agent-server-libs/src/smart-agent/controller/finalizer.ts` — **(Task 1)** add `FinalizeOpts.skillsBlock?: string`; `LlmFinalizer.finalize` includes the block in the USER message + a generic honor-clause in `FINALIZE_SYSTEM`.
- `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` — **(Task 2)** `finalize()` calls `deps.skillsRecall(bundle.goal, …)` and passes the result as `opts.skillsBlock`.
- `docs/EXAMPLES.md` (+ any `skillPlugins:` reference in `docs/`) — **(Task 3)** document that controller skills can now shape the delivered answer (agnostic wording).
- Tests: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/finalizer.test.ts` (Task 1); an existing controller test for the handler wiring (Task 2) or a focused stub; **Task 4** is a live acceptance repro (the reporter's exact case).

---

### Task 1 — `FinalizeOpts.skillsBlock` + `LlmFinalizer` honors it

**Files:** modify `controller/finalizer.ts`; test `controller/__tests__/finalizer.test.ts` (create if absent, else extend).

**Interfaces:** `FinalizeOpts` gains `skillsBlock?: string` (positional `finalize(goal, request, approvedResults, opts)` unchanged).

**Steps:**

- [ ] **Failing test first** in `finalizer.test.ts`. Construct `new LlmFinalizer(client, policy)` with a STUB client that captures the `messages` passed to `client.send(...)` and returns `{ kind: 'content', content: 'ok' }`. (Read the current file to match `LlmFinalizer`'s constructor + the `client.send` contract + `ApprovedResult` shape.) Cases:
  - **skillsBlock present:** call `finalize('g', 'r', [], { skillsBlock: 'Relevant skills:\n- always end with LINE-X' })` → the captured USER message CONTAINS the skills block text under a `Skills` header, AND the SYSTEM message contains the generic honor-clause (assert a stable substring of the new clause, e.g. `honor` + `directives`).
  - **skillsBlock absent:** call `finalize('g', 'r', [], {})` → the USER message contains NO `Skills` section (byte-equal to today's `Goal/Request/Results` format), and the SYSTEM message is `appendHint(FINALIZE_SYSTEM, undefined)` (the honor-clause is a static part of FINALIZE_SYSTEM, so it's always present in the constant — assert the user message has no skills section; that is the behavior-preservation check).
  - **empty skillsBlock:** `{ skillsBlock: '   ' }` → treated as absent (no skills section).
- [ ] Run → FAILS (no `skillsBlock` handling yet).
- [ ] **Implement** in `finalizer.ts`:
  - Add `skillsBlock?: string;` to `FinalizeOpts` (with a short doc comment: "Bounded skills recall block; the finalizer honors any output/delivery directives it states. Agnostic — content is consumer-supplied.").
  - Add a generic clause to `FINALIZE_SYSTEM` (append to the existing constant): ` 'If a skills block is provided below, honor any output, delivery, or formatting directives it states exactly; the skills govern delivery only — still do not invent facts beyond the provided results.'` (No domain content, no examples.)
  - In `LlmFinalizer.finalize`, build the user content with an optional skills section:
    ```ts
    const skills = opts.skillsBlock?.trim();
    const userContent =
      `Goal: ${goal}\nRequest: ${request}\nResults:\n${body}` +
      (skills ? `\n\nSkills (delivery directives):\n${skills}` : '');
    ```
    and pass `userContent` as the user message. Leave the system line as `appendHint(FINALIZE_SYSTEM, opts.hint)` (FINALIZE_SYSTEM now carries the honor-clause).
- [ ] Run tests → GREEN. `npm run build`. SCOPED lint gate. Commit: `feat(controller): finalizer honors delivery directives from a recalled skills block (#212)`.

---

### Task 2 — thread `skillsRecall` → `skillsBlock` in the handler's `finalize()`

**Files:** modify `controller/controller-coordinator-handler.ts` (the `deps.finalizer.finalize(...)` call ~1454); extend an existing controller test if a light seam exists (else rely on build + Task 4 live acceptance).

**Interfaces consumed:** `deps.skillsRecall?: (goal: string, options?: CallOptions) => Promise<string>` (handler:138).

**Steps:**

- [ ] **Read** the `finalize()` region (~1450-1466) to confirm the exact call + whether a `CallOptions`/`options` is in scope there. `deps.skillsRecall`'s `options` param is OPTIONAL, so if no `options` is in scope at the finalize call, call `deps.skillsRecall(bundle.goal)`.
- [ ] **Implement:** just before the `deps.finalizer.finalize(...)` call, compute the block once and pass it:
  ```ts
  const skillsBlock = deps.skillsRecall
    ? await deps.skillsRecall(bundle.goal /*, options if in scope */)
    : undefined;
  ```
  then add `skillsBlock,` to the opts object passed to `deps.finalizer.finalize(bundle.goal, request, approved, { hint: …, logUsage, log, skillsBlock })`. (The recall query uses `bundle.goal` — the SAME key the planner recalls with, so the same skills surface.)
- [ ] **Test/verify the wiring:** if `controller-coordinator-handler.test.ts` (or a controller test) can drive `finalize()` with a fake `deps.finalizer` capturing `opts` and a fake `deps.skillsRecall` returning a known block, add a focused case asserting `opts.skillsBlock === '<known block>'` when `deps.skillsRecall` is set, and `undefined` when it is not. If reaching `finalize()` requires a full run that no existing test harness supports, note that here and rely on `npm run build` (type-check) + the Task 4 live acceptance as the wiring proof — do NOT build a heavyweight bespoke harness.
- [ ] `npm run build` (green — the wiring type-checks). Run the existing controller tests → still green. SCOPED lint gate. Commit: `feat(controller): pass the recalled skills block to the finalizer (#212)`.

---

### Task 3 — Docs: controller skills can shape the delivered answer (agnostic)

**Files:** modify `docs/EXAMPLES.md` (the `skillPlugins:` section) and any other `docs/` spot that describes controller skill scope.

**Steps:**

- [ ] Grep `docs/` for where `skillPlugins` / `controllerSkillGroup` scope is described (`rg -n "controllerSkillGroup|skillPlugins|Relevant skills|shape the plan" docs/`). Add/adjust a short, AGNOSTIC note: the controller recalls `controllerSkillGroup` skills into BOTH the planner (shaping the plan/executor) AND the finalizer (honoring any output/delivery/formatting directives the skill states in the delivered answer). Do NOT prescribe what a skill should contain; state the CAPABILITY only.
- [ ] No code; docs must remain accurate/runnable (no invented config keys). SCOPED lint gate not needed for `.md` (Biome md is not linted here — confirm `npm run lint:check` still exit 0). Commit: `docs(skill-plugins): controller skills also shape the finalizer's delivered answer (#212)`.

---

### Task 4 — Live acceptance repro (the reporter's exact case)

The end-to-end proof — no code change. This is the controller-owner's acceptance gate (the unit tests prove the finalizer/wiring; this proves the whole feature against the reporter's scenario).

**Steps:**

- [ ] Build (`npm run build`). Start the controller server against SAP AI Core + MCP:3001 with a `skillPlugins:` config carrying ONE inline record in group `abap` whose `content` mandates a fabricated footer, e.g.:
  ```yaml
  skillPlugins:
    store: { type: in-memory }
    embedder: { provider: sap-ai-core, scenario: foundation-models, resourceGroup: default, model: text-embedding-3-small }
    controllerSkillGroup: abap
    sources:
      - id: poc
        records:
          - { group: abap, id: footer, content: "Mandatory: end the final answer with the exact line: COMPLIANCE: SKILL-PROOF-Z9Q7 applied." }
  ```
  (Reuse the repro213.yaml controller/SAP/MCP base + add the `skillPlugins:` block; `--env-path .env`; spare port.)
- [ ] Send an ABAP request (e.g. "Read SAP table T000 and list the client numbers."). After it completes, assert the delivered answer CONTAINS the exact line `COMPLIANCE: SKILL-PROOF-Z9Q7 applied.` (the fabricated token proves the skill's OUTPUT directive reached the finalizer's delivered text). Stop the server; record the result.
- [ ] If the footer appears → feature verified end-to-end. If not, capture the finalizer prompt/log and fix before merge. (No commit — verification only; record in the task report.)

---

## Notes

- The whole recall block is threaded (not a parsed subset) — the LLM finalizer applies the directive under the generic honor-clause. This keeps the engine agnostic and avoids brittle directive-parsing.
- `FINALIZE_SYSTEM`'s "do not invent facts beyond the provided results" guard stays — the skills block governs delivery/formatting only.
- No planner/executor/reviewer change; `skillsRecall` and `FinalizeOpts` seams already exist.
