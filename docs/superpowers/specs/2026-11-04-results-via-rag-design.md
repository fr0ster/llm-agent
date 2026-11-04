# Task results via RAG, not via context

Status: draft for review (2026-11-04)
Scope: `@mcp-abap-adt/llm-agent` (interfaces), `@mcp-abap-adt/llm-agent-libs` (dialogue coordinator), host integration (cloud-llm-hub as the reference host)

## Intent

Pipeline participants exchange task results through RAG records, referenced by id, instead of copying result text through LLM contexts. The coordinator keeps the plan and a short notice per task; that is enough for it to decide the next action (check or not, redo, next step, deliver). Full results stay in RAG; whoever needs them reads them there.

Product owner's words: "Обмін через контекст це те чого ми хотіли позбутися, обмін має бути через RAG". "Координатор сам без необхідності в RAG не лізе, а тільки отримує повідомлення про результат … передасть в якій колекції результат попереднього кроку лежить в наступний крок. Або ставить задачу і наступний агент сам витаскує з RAG все." "Достатньо, щоб він рішив, треба чекнути чи ні."

## Why now

A four-session parallel review on the hub (llm-agent-libs 30.31.0) showed the cost of context exchange. In one session the coordinator (the most expensive model) used 1.15M input tokens in 54 requests; about 1.1M of them came from two turns in which it read full task results (~28k and ~67k characters) into its own context and then re-sent them with ~20 small follow-up calls each. In another session one worker received ~722k input tokens. Two paths carry results through context today:

1. `delegate_task` (`planner-tools-client.ts`, dependency blocks) appends the full `output` of every `dependsOn` step to the next worker's `context` (`[result of step …]` / `[result to check: step …]`, cap 120 000 characters).
2. `get_task` with `view: "full"` returns the full `output` (paged only if the coordinator asks for offset/limit). Task events end with "use get_task to read output", which invites the read.

`deliver` already passes the stored `output` to the user without the coordinator retyping it; that stays.

## Goals

- G1. A finished task's full result is stored as a RAG record by the library, deterministically, before the task is reported done. The coordinator never has to copy result text anywhere.
- G2. The coordinator sees per task only a short notice: state, result kind, verdict for checks, the worker's short summary, size, and the record reference. No full-text view by default.
- G3. A dependent worker or a checker receives references to the dependency results (collection, record id, size, summary) instead of their text, and reads what it needs with the read tools it already has.
- G4. `deliver` gives the user the stored result. User-visible text is unchanged except that results longer than the 60 000-character state cut are now delivered complete.
- G5. Nothing the library adds to the coordinator's context automatically (task notices, `get_task`, memory recall) grows with the size of worker results. Whether the coordinator reads a stored result on purpose is governed by its prompt (D3).

## Non-goals

- No change to how durable user knowledge is persisted: `rag_persist` keeps copying session records into user collections when the request asks for durable storage.
- No new summarisation LLM call in the library. The short summary comes from the worker.
- No change to plan authoring (plans state results, the coordinator picks the worker; 30.31.0 stays).
- No change to tool-trace evidence for checkers in this iteration (the trace stays in the checker context; it is small and bounded already).

## Anti-goals (would make this a failure even if it works)

- The coordinator reads results from RAG by habit, recreating the same cost through another door.
- A task is marked done while its result record is missing or partial.
- A worker of one session can read another session's results.
- Results end up in instruction-class collections (agents, skills): task results are information only.

## Design

### D1. Result store interface (llm-agent)

A host-provided store, injected into the dialogue session the way profile source and state store are:

```ts
interface TaskResultRef {
  collection: string;   // logical session collection id visible to this session's workers
  record: string;       // record id; equals the task id
  chars: number;        // stored length
}
type TaskResultOutcome = 'done' | 'stopped' | 'failed';
interface TaskResultEntry {
  id: string;                      // task id
  stepId?: string;                 // plan step the task was delegated for (from the session's task→step map)
  worker: string;
  goal: string;
  result: 'report' | 'verdict';
  outcome: TaskResultOutcome;
  budgetExhausted?: boolean;
  verdict?: 'pass' | 'fail';
  summary: string;                 // the notice summary (D2), ≤ 600 chars
  output: string;                  // full, uncut worker output (or error text for failed tasks)
}
interface ITaskResultStore {
  /** Create the record once; resolves only after it is readable. A second put for the same id
   *  returns the existing ref when the stored text is identical, otherwise an `exists` error. */
  put(entry: TaskResultEntry, options?: CallOptions): Promise<Result<TaskResultRef, TaskResultStoreError>>;
  /** Read the full stored text. */
  read(ref: TaskResultRef, options?: CallOptions): Promise<Result<string, TaskResultStoreError>>;
}
```

- **Finalisation order** in the task board: the run returns → the board determines the outcome (`done` / `stopped` / `failed`, budget flag, verdict) → `put(entry)` with the raw output → only then sets `TaskRecord.state`, `resultRef`, `summary`, and emits the event.
- **`put` failures.** For an outcome that would be `done`, a failed `put` makes the task `failed` with a storage error (anti-goal: no done without a record). For `stopped`/`failed` outcomes a failed `put` keeps that outcome; the task simply has no `resultRef`, and its notice says the result is not stored.
- **Abort during `put`** makes the task `interrupted` without `resultRef`. On restore, `running`/`queued` tasks become `interrupted` as today; a record that may already exist for such a task is not referenced (the task is redone if needed, with a new id).
- One record per task id, created once (immutability, D7). A re-delegated step creates a new task and therefore a new record; older records stay readable for history.
- When no store is configured (other hosts, tests), behaviour falls back to today's context passing. This keeps the library usable without RAG; the hub always configures the store.
- `TaskRecord` gains `resultRef?: TaskResultRef` and `summary?: string`. `output` stays in the dialogue state for delivery, restore and backwards compatibility.

### D2. Worker summary (llm-agent-libs)

- Report workers end with a short summary for the coordinator. Mechanism: a library-provided `submit_report({ summary, result? })` tool, the report-kind sibling of the hub's `submit_verdict`. `summary` is required, max 600 characters; `result` is the full report text. A valid call finishes the task through the existing `dialogue.task.finish` signal.
- **Typed channel.** The finish signal payload and `finishDialogueTask(task, output, tool?, summary?)` gain an optional typed `summary`; `ISubAgentResult` gains `summary?`; the board copies it into `TaskEntry.summary` / `TaskRecord.summary`. No side channel.
- **Works without host signals.** When the host passes no `signals`, the dialogue session uses a built-in in-memory signal bus that supports `emit`, `retire` and `last` (today's default `{ emit() {}, retire() {} }` drops the finish payload). `submit_report` and its `summary` therefore reach the task board without host code.
- **`result` omitted** in a `submit_report` call: the result is the worker's collected assistant text of the run (all accepted texts in order, see the worker-output fix). If nothing was collected yet, the call is invalid: the tool returns an error saying `result` is required because no report text was written, and the task does not finish. The result is never the summary and never empty.
- If the worker ends without calling it (model ignored the tool), the library uses the collected assistant text as `result` and its first 600 characters as `summary`, marked `summary: truncated`. No extra LLM call.
- Verdict tasks keep `submit_verdict`; their summary is the verdict line (`pass`/`fail`, count, note), with the note cut to fit the same 600-character summary limit.
- Worker base profile text gets one sentence about `submit_report`; hosts own the wording of their profiles.

### D3. Coordinator view (llm-agent-libs)

- Task events (`[task events]` lines) show: id, worker, state, result kind, verdict, summary, `chars`, and `result: <collection>/<record>`. The "use get_task to read output" hint is removed.
- **Every text field of a notice is bounded:** summary ≤ 600 characters (D2), goal ≤ 200, error/diagnostic ≤ 600. A failed task's full error text goes into its record (`outcome: failed`), not into the notice.
- `get_task` returns the same short notice by default. `view: "full"` is removed from the coordinator tool schema. Reading a stored result remains possible with the normal read tools when really needed; the coordinator profile says to read only for a concrete gap that the summary cannot decide.
- `taskReference()` and `compactText(output, 1200)` stop being the coordinator's way to see results.
- **No code gate on coordinator strategy.** Whether and when the coordinator reads a stored result is governed only by its prompt, never by a gate or read budget in code (product owner: hardcoded behaviour would break learning; assistants shape the coordinator with a base prompt plus corrective skills). Code gates in this design protect data integrity and isolation only (D7 immutability, session scope), not coordinator strategy.

### D3a. Coordinator function (prompt, host-owned)

The coordinator profile describes its function explicitly: it delegates every step of the plan to an agent and never executes steps itself. When no specialised profile fits a step, it starts the default agent (the host's general executor profile) with a brief and a model; that agent can take any task; it finds knowledge in RAG by searching from the brief and earlier task results by listing the session's `task-results` (D4). The coordinator therefore keeps read-only RAG tools and gets no execution tools. It decides the next action from the plan and the task notices (summary, verdict, size, reference); it does not read stored results to pass them on, compile reports or copy results into briefs. To hand a result on, it declares the dependency (the library attaches the reference, D4) or, for an agent without dependencies, names the task whose result to use. The user receives results through `deliver`.

### D4. Dependency hand-off (llm-agent-libs)

- `delegate_task` no longer appends dependency `output` to the worker `context`. It appends a reference block per dependency:
  `[result of step s1 (task t3)] record task-results/t3, 12 345 chars. Summary: …`
  For checks: `[result to check: step s1 (task t3)] record task-results/t3, …` plus the existing tool-trace block and expected items.
- The 120 000-character dependency cap no longer applies to references (they are small); the "split or narrow the step" error disappears with it.
- **References are always attached** for every `dependsOn` step, so the hand-off stays unambiguous (the step's `successfulWorkTaskId` names the exact record). An agent without dependencies (for example the default executor started with a brief) finds earlier results by listing the session's `task-results` with `collection_records`, which returns record metadata (task id, step id, worker, goal, summary, size) without bodies, and reads a body with `rag_read` by id. It never needs `rag_search` for results.
- **Legacy dependencies** (tasks restored from state saved before the upgrade, without `resultRef`) are handed over the old way, as text, on every delegation that depends on them; no records are back-filled.
- The worker gets RAG read tools for that collection as part of its normal tool set (hosts already give workers RAG read tools; the hub's worker gate already allows reading session collections).

### D5. Delivery

- **The record wins over the state copy.** `deliver({ task_id })` sends the full text read with `store.read(resultRef)`; without a store or without `resultRef` it sends `task.output` as today.
- `deliver` becomes asynchronous (`scope.deliver` returns a promise and the tool awaits it). If `read` fails, the `deliver` tool call returns an error naming the task and the storage failure; nothing is delivered and the coordinator decides what to do next (no silent fallback to the cut copy).
- **Delivered text in planner memory.** The `planner-reply` memory entry for a delivery stores the coordinator's note plus the task notice (summary and reference), not the delivered text. Memory already indexed before the upgrade is left as is.

### D6. Hub integration (cloud-llm-hub)

- Implement `ITaskResultStore` on the session's RAG: one session-scoped collection per session, logical id `task-results`, created on first `put`, scoped exactly like other session collections (same owner, same session id, same expiry) so session isolation holds by construction.
- Records carry metadata `{ kind: 'task-result', taskId, worker, result, stepId? }`, source/trust like other worker-produced information (information class, never instruction class).
- Workers read it with the existing `rag_read` / `collection_records` tools; `rag_persist` can copy a task result into a user collection when the request asks to keep it.
- The coordinator profile drops "Judge results against get_task done criteria" in favour of "Judge results by the task notice; read the stored record only for a concrete gap", and states the D3a function.
- Per-agent cost coefficients (correcting each model's token cost in usage reports) are a separate, later design; this spec does not depend on them.

### D7. Decisions from the builder check (author's calls, marked for review)

- **Immutable results.** `task-results` is written only by the store. Workers and the coordinator may read it but not add, update, delete or drop it; the host's write gate refuses those calls for this collection. A checked result therefore cannot change between the check and `deliver`.
- **Read by id, not searched.** Task results are stored documents read by id (`rag_read`, `collection_records`). They are not embedded and are excluded from `rag_search` and from automatic retrieval, so results cannot leak back into contexts through search and `put` costs no embedding tokens. How the host stores unembedded records on each backend is left to the builder.
- **Full result in the record.** `put` receives the raw worker output before the 60 000-character cut. The task state keeps the cut copy for restore. Delivery follows D5 (record wins).
- **Read access follows the reference.** Every worker that receives a result reference can read its own session's `task-results`, independent of profile allow/deny lists and tool selection (better an extra tool than a missing one). No context fallback for workers without read tools.
- **Which outcomes get a record.** Every task that produced output or an error: `done` (including budget-exhausted), verdict tasks, and `stopped`/`failed` tasks (outcome in the entry, D1). Legacy tasks: see D4.
- **Planner memory.** Both memory paths store compact projections: the `planner-task` entry stores the task notice (summary and reference) instead of the output, and the `planner-reply` entry of a delivery follows D5. Results therefore do not reach the coordinator through memory recall either.

## Constraints

- Static typing everywhere: no `any`/`unknown` except narrowed caught errors, no `as unknown as`, no `as never`.
- No timeouts in new work paths: `put` and `read` wait as long as the backend needs, cancellation only via abort. Existing timers (the task board's forced-abort timer, the memory writer's deadline) are out of scope and unchanged.
- Session isolation is guaranteed: no fallback may let a worker read another session's `task-results`.
- No customer- or engagement-specific details in docs.
- Release order for llm-agent: version PR → signed per-package tags → npm publish by the owner; hub follows with a dependency bump.

## Verification

- Library unit tests: put-before-done ordering; put failure fails the task; no context dependency text when a store exists; fallback when none; `get_task` has no full view; task-event text carries summary and ref; `submit_report` validation and finish; truncated-summary fallback.
- Hub tests: session isolation of `task-results` (two sessions, same user and different users); record metadata and trust; `rag_persist` of a task result; restore after restart keeps refs readable.
- POC measurement: rerun the four parallel reviews (E19, read-only) with context capture `full`. Report per model, input and output separately. Expect coordinator input per turn to stay roughly flat regardless of result size, and no single worker input dominated by dependency text.

## Left to the builder

- Exact names of types, files and test layout.
- How the hub creates the collection lazily and names the physical id.
- Wording of the fallback marker and of the reference block, as long as it carries step, task, record, size and summary.
- Whether `submit_report` lives in libs or is provided by hosts through an interface, as long as the default works without host code.
