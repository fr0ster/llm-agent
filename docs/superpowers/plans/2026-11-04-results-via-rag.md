# Task Results via RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dialogue task results travel as immutable RAG records referenced by id; the coordinator sees only bounded task notices.

**Architecture:** llm-agent defines `ITaskResultStore` and the typed summary channel; llm-agent-libs stores every finished task's full output through the store before publishing its state, hands references (not text) to dependent tasks, bounds every coordinator-visible field, delivers from the record and writes only compact projections to planner memory. cloud-llm-hub implements the store as a per-session `task-results` collection that only the store can write and that is excluded from search.

**Tech Stack:** TypeScript, zod, node:test (llm-agent), jest (hub), changesets.

**Spec:** `docs/superpowers/specs/2026-11-04-results-via-rag-design.md` (approved 2026-11-04). Prerequisite: branch `fix/worker-output-all-text` merged (worker output = all accepted assistant texts; `CallOptions.onAssistantResponse`).

## Global Constraints

- Static typing: no `any`/`unknown` except narrowed caught errors, no `as unknown as`, no `as never`.
- No timeouts in new work paths: `put` and `read` wait as long as the backend needs; cancellation only via abort. Existing TaskBoard forced-abort timer and memory-writer deadline unchanged.
- Session isolation guaranteed: a worker can never read another session's `task-results`.
- No code gate on coordinator strategy; coordinator behaviour changes only in its prompt (hub `srv/agent-profiles/coordinator.md`).
- Bounds: summary ≤ 600 characters, notice goal ≤ 200, notice error/diagnostic ≤ 600.
- Without a configured store the library behaves as today (text hand-off, `task.output` delivery).
- No customer- or engagement-specific details in docs.
- Release: changesets (`llm-agent` minor, `llm-agent-libs` minor); version PR → signed per-package tags → owner publishes; hub bumps after publish.

## Review Focus

1. A dependency whose task has `resultRef` must never also get its text in the brief (double transport) — Task 5 test `no dependency text when the dependency has a record`.
2. A `done` outcome whose `put` fails must surface as `failed`, never as `done` without `resultRef` — Task 3 test `put failure turns done into failed`.
3. A restored legacy task (no `resultRef`) used by two later delegations gets its text both times — Task 5 test `legacy dependency text on every delegation`.
4. `deliver` of a task whose record read fails returns a tool error and delivers nothing — Task 6 test `deliver read failure delivers nothing`.
5. A worker in session B listing or reading session A's `task-results` is refused — Task 9 test `task-results isolation across sessions`.

---

## Part A — llm-agent / llm-agent-libs

### Task 1: Store interface, typed summary channel, default signal bus

**Files:**
- Create: `packages/llm-agent/src/interfaces/task-result-store.ts`
- Modify: `packages/llm-agent/src/interfaces/dialogue-signals.ts` (finish payload), `packages/llm-agent/src/interfaces/dialogue-task-context.ts` (`finishDialogueTask`), `packages/llm-agent/src/interfaces/subagent.ts` (`ISubAgentResult`), `packages/llm-agent/src/interfaces/dialogue.ts` (`TaskRecord`), interface index exports
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/dialogue-session.ts:488` (default signals)
- Test: `packages/llm-agent/src/interfaces/__tests__/task-result-store.test.ts`, `packages/llm-agent-libs/src/coordinator/dialogue/__tests__/signals.test.ts`

**Interfaces:**
- Produces:
  - `type TaskResultOutcome = 'done' | 'stopped' | 'failed'`
  - `interface TaskResultRef { collection: string; record: string; chars: number }`
  - `interface TaskResultEntry { id: string; stepId?: string; worker: string; goal: string; result: 'report' | 'verdict'; outcome: TaskResultOutcome; budgetExhausted?: boolean; verdict?: 'pass' | 'fail'; summary: string; output: string }`
  - `type TaskResultStoreError = { code: 'exists' | 'unavailable' | 'aborted'; message: string }`
  - `interface ITaskResultStore { put(entry: TaskResultEntry, options?: CallOptions): Promise<Result<TaskResultRef, TaskResultStoreError>>; read(ref: TaskResultRef, options?: CallOptions): Promise<Result<string, TaskResultStoreError>> }`
  - `DialogueSignals['dialogue.task.finish']` gains `summary?: string`
  - `finishDialogueTask(task, output, tool?, summary?)`
  - `ISubAgentResult.summary?: string`; `TaskRecord.resultRef?: TaskResultRef`, `TaskRecord.summary?: string`
  - `createMemorySignalBus(): ISignalEmitter<DialogueSignals> & ISignalSubscriber<DialogueSignals>` (libs), used as the `DialogueSession` default instead of `{ emit() {}, retire() {} }`

- [ ] **Step 1:** Tests: `finish payload carries summary` (emit with summary, `readFinish()` returns it); `default session bus retains finish` (session opened without `signals`; a worker calling `finishDialogueTask(ctx, 'R', 'submit_report', 'S')` → `readFinish()` returns `{ output: 'R', summary: 'S' }`).
- [ ] **Step 2:** Run both test files; expect FAIL (no `summary`, default bus drops payload).
- [ ] **Step 3:** Implement the types above and `createMemorySignalBus` (retains last payload per name/source/key; `retire` drops a source).
- [ ] **Step 4:** Run `npm run build` (both packages) and the two test files; expect PASS.
- [ ] **Step 5:** Commit `feat(dialogue): task result store interface and typed finish summary`.

### Task 2: `submit_report` tool and summary resolution

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dialogue/submit-report-tool.ts`
- Modify: `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts` (summary in result), tool exposure for report workers where verdict workers get `submit_verdict` hooks today (libs default; hosts may override)
- Test: `packages/llm-agent-libs/src/coordinator/dialogue/__tests__/submit-report.test.ts`

**Interfaces:**
- Consumes: Task 1 `finishDialogueTask(..., summary)`, worker collected assistant texts (prerequisite fix).
- Produces: tool `submit_report` with zod schema `{ summary: z.string().min(1).max(600), result: z.string().min(1).optional() }`; `resolveWorkerSummary(output: string, finishSummary?: string): { summary: string; truncated: boolean }` (first 600 chars when no finish summary).

- [ ] **Step 1:** Tests: `valid submit_report finishes with result and summary`; `omitted result uses collected text`; `omitted result with no collected text is an error and does not finish` (error text names `result`); `summary over 600 is rejected`; `no submit_report → summary is first 600 chars, truncated=true`; `verdict summary is verdict line with note cut to 600`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement tool, wire into report-kind workers, set `ISubAgentResult.summary`.
- [ ] **Step 4:** Run the file plus `smart-agent-subagent-*.test.ts`, `task-finish.test.ts`; expect PASS.
- [ ] **Step 5:** Commit `feat(dialogue): submit_report gives the coordinator a bounded summary`.

### Task 3: Board finalisation through the store

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/task-board.ts:440-500` (execute/finally), `TaskBoardOptions` (`resultStore?: ITaskResultStore`), `DialogueSessionOptions` pass-through, step id lookup from the session's task→step map
- Test: `packages/llm-agent-libs/src/coordinator/dialogue/__tests__/task-results.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 2 `resolveWorkerSummary`.
- Produces: `TaskRecord.resultRef`, `TaskRecord.summary` set before `onEvent` for `done`/`stopped`/`failed`.

- [ ] **Step 1:** Tests: `put happens before done is published` (fake store records call order vs event); `put receives raw uncut output` (output 70 000 chars → `entry.output.length === 70000`, `task.output` cut); `put failure turns done into failed` (error mentions storage, no `resultRef`); `stopped with failed put stays stopped without ref`; `abort during put → interrupted, no ref`; `failed task stores error text with outcome failed`; `no store → no put, behaviour unchanged`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement order: outcome → `put(entry)` → state/ref/summary → emit.
- [ ] **Step 4:** Run the file plus `task-board.test.ts`, `hard-stop.test.ts`; expect PASS.
- [ ] **Step 5:** Commit `feat(dialogue): finished tasks are stored before they are reported`.

### Task 4: Bounded coordinator notices and `get_task`

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/task-reference.ts` (`taskReference` → notice), `planner-tools-client.ts:183-185` (schema: drop `view`, offset/limit), `:464-520` (handler), `dialogue-session.ts:1426-1445` (event lines)
- Test: `__tests__/planner-tools-client.test.ts`, `__tests__/dialogue-session.test.ts`

**Interfaces:**
- Produces: `taskNotice(task: TaskRecord): string` containing id, worker, state, result kind, verdict, summary (≤600), `chars`, `result: <collection>/<record>`; goal ≤200; error ≤600; no "use get_task to read output".

- [ ] **Step 1:** Tests: `get_task schema has no view/offset/limit`; `notice bounds` (summary 900 → 600, goal 400 → 200, error 2000 → 600); `notice names the record`; `task event line has no get_task hint`; `task without store keeps compact output in notice`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `taskNotice`; use it in events and `get_task`; keep `include_trace` for checks.
- [ ] **Step 4:** Run both files; expect PASS.
- [ ] **Step 5:** Commit `feat(dialogue): coordinator sees bounded task notices`.

### Task 5: Reference hand-off for dependencies

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/planner-tools-client.ts:343-380`
- Test: `__tests__/delegation-profiles.test.ts`, `__tests__/check-steps.test.ts`

**Interfaces:**
- Produces: reference block `[result of step <step> (task <task>)] record <collection>/<record>, <chars> chars. Summary: <summary>`; check variant `[result to check: step …]` plus existing tool-trace block and expected items.

- [ ] **Step 1:** Tests: `no dependency text when the dependency has a record`; `check gets reference, trace and expected items`; `legacy dependency text on every delegation` (restored task without ref, two delegations both contain its text); `120000 cap applies only to legacy text blocks`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement: ref block when `resultRef`, legacy text block otherwise.
- [ ] **Step 4:** Run both files; expect PASS.
- [ ] **Step 5:** Commit `feat(dialogue): dependent tasks receive result references, not text`.

### Task 6: Delivery from the record and memory projections

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/dialogue-session.ts:1083-1135` (async deliver), `:303` (`planner-reply` text), `:505-525` (`planner-task` text), `planner-tools-client.ts:451-463` (await)
- Test: `__tests__/dialogue-session.test.ts`, `__tests__/planner-memory.test.ts`

**Interfaces:**
- Consumes: `ITaskResultStore.read`, Task 4 `taskNotice`.
- Produces: `scope.deliver(id, note?, resolves?): Promise<void>`.

- [ ] **Step 1:** Tests: `deliver sends full record text` (70 000-char record delivered complete); `deliver read failure delivers nothing` (tool error names task and storage); `deliver without store sends task.output`; `planner-task memory stores notice not output`; `planner-reply memory of a delivery stores note plus notice`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files; expect PASS.
- [ ] **Step 5:** Commit `feat(dialogue): deliver from stored results; memory keeps notices`.

### Task 7: Docs, changeset, full checks

- [ ] **Step 1:** README dialogue section and the dialogue spec docs: results via `ITaskResultStore`, notices, references, `submit_report`.
- [ ] **Step 2:** `.changeset/results-via-rag.md`: `@mcp-abap-adt/llm-agent: minor`, `@mcp-abap-adt/llm-agent-libs: minor`.
- [ ] **Step 3:** Run `npm run build && npm run lint && npm run typecheck`, libs and core node:test suites; expect 0 failures.
- [ ] **Step 4:** Commit `docs(dialogue): task results via RAG`.

## Part B — cloud-llm-hub (after the libs release is published)

### Task 8: `ITaskResultStore` on session RAG

**Files:**
- Create: `srv/lib/task-result-store.ts`
- Modify: `srv/lib/dialogue-sessions.ts:1131` (pass `resultStore`), `srv/rag-collections.ts` (collection kind `task-results`, unembedded documents, excluded from search/retrieval)
- Test: `test/unit/task-result-store.test.ts`

**Interfaces:**
- Produces: `createTaskResultStore(registry: CollectionRegistry, scope: { userId: string; sessionKey: string }): ITaskResultStore`; collection logical id `task-results`, `collectionKind: 'task-results'`, scope `session`, same owner/session/expiry as other session collections; record id = task id; metadata `{ kind: 'task-result', taskId, stepId?, worker, result, outcome, summary, chars }`, information class.

- [ ] **Step 1:** Tests: `put creates collection lazily and record readable`; `second identical put returns existing ref`; `different put for same id → exists`; `records are not embedded and rag_search skips them`; `collection_records lists metadata without bodies`; `read returns full text`.
- [ ] **Step 2–4:** Run (`npx jest --maxWorkers=1 test/unit/task-result-store.test.ts`), implement, re-run; expect PASS.
- [ ] **Step 5:** Commit `feat(dialogue): session task-results store`.

### Task 9: Write gate and read access

**Files:**
- Modify: `srv/agent-mcp-rag.ts:306-345` (refuse add/update/delete/set_enabled/collection_delete on `collectionKind: 'task-results'` for every role; allow reads of own session's `task-results` for any worker regardless of profile tool lists)
- Test: `test/unit/task-results-gate.test.ts`

- [ ] **Step 1:** Tests: `worker cannot write task-results`; `coordinator cannot write task-results`; `worker without rag tools in its profile can read own task-results`; `task-results isolation across sessions` (same user and different users); `rag_persist copies a task result into a user collection`.
- [ ] **Step 2–4:** Run, implement, re-run; expect PASS.
- [ ] **Step 5:** Commit `feat(rag): task-results are store-written and session-isolated`.

### Task 10: Profiles, bump, POC measurement

- [ ] **Step 1:** `srv/agent-profiles/coordinator.md`: D3a function text (delegate every step; default executor with brief and model when no profile fits; decide from notices; declare dependencies instead of copying; deliver); replace "Judge results against get_task done criteria" with "Judge results by the task notice; read the stored record only for a concrete gap". `_worker-base.md`: one sentence on `submit_report`.
- [ ] **Step 2:** Bump `@mcp-abap-adt/llm-agent` and `-libs` to the released minors; full jest (`npx jest --maxWorkers=1`), lint, typecheck; expect 0 failures.
- [ ] **Step 3:** Commit, PR, Codex review, release, deploy (each with the owner's yes); update POC `agents` records from the repo texts.
- [ ] **Step 4:** Rerun the four parallel reviews on E19 with context capture `full`; report per model, input and output separately, plus coordinator-model-relative cost; compare with the 2026-11-04 baseline (R4: coordinator 881k/1.24M relative cost).
