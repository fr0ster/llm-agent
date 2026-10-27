# Planner wait mode — design

## Intent

The dialogue planner must never wait for its workers inside a turn. Today the prompt asks it to
("Never wait for a task inside a turn"), but nothing enforces it. A model polls `get_task` /
`list_tasks` every 2–3 s while a worker runs, and each call carries the full planner context. A
measured user turn made 21 planner calls in 65 s, about 1M input tokens, for a reply that only said
"started, waiting".

Waiting becomes a mode of the session instead of a behaviour of the model:

1. The planner ends its turn once it has delegated. Polling a running task ends the turn.
2. Two triggers drive the session while workers run:
   - **worker outcome**: the existing task events (`done`, `failed`, `stopped`) wake the planner in
     an event turn, as today;
   - **clock**: a session timer ticks while tasks are queued or running. A tick costs no LLM call.
     It publishes a wait status ("waiting for t1 executor · 1:30, t2 · 0:45"). When a task has run
     longer than a threshold, the tick wakes the planner once with a note ("t1 has been running for
     5:00 …") so it can check and decide: keep waiting, `stop_task`, or re-delegate.

## Goals

1. **End the turn instead of polling.**
   - Within one planner turn, `get_task` on a queued/running task, or `list_tasks` while any task is
     queued/running, is a status read.
   - The first status read in a turn is answered normally.
   - A second status read in the same turn, with no task outcome in between, ends the turn. The tool
     call is answered, then no further planner LLM call is made in this turn.
   - The turn's reply is the planner's text produced so far in this turn when non-empty. Otherwise it
     is a short waiting note listing the running task ids and workers.
   - Corrective turns (`maxCorrections`) are not started after a turn ended this way.
   - `delegate_task`, `stop_task`, `get_plan` and `update_plan` are not status reads.
   - Reading a finished task (`done`, `failed`, `stopped`, `interrupted`) is never a status read.
   - The `[actions]` record notes `wait (turn ended: tasks running)`.
2. **Wait clock (no LLM).**
   - While any task of the session is queued or running and the session is not closing, a timer runs
     with `waitTickMs` (option, default 30 000). It starts with the first queued/running task and stops
     when none remain, on close, and on restore without running tasks.
   - Each tick emits a new signal `dialogue.wait`:
     `{ tasks: Array<{ id; worker; goal; state: 'queued' | 'running'; elapsedMs; toolCalls?; maxToolCalls? }> }`.
     `elapsedMs` is measured from `startedAt`, else `createdAt`. A tick never calls the planner.
3. **Long-running wake.**
   - `longTaskMs` (option, default 300 000).
   - When a running task's elapsed time first reaches `longTaskMs`, the session queues a non-terminal
     task event `{ kind: 'long_running', task }`. This wakes the planner through the existing event-turn
     path.
   - The planner sees it in `[task events]` as e.g.
     `t1 (executor) is still running after 5:00 (12/40 tool calls): check it and decide: keep waiting, stop_task, or re-delegate`.
     Tool calls appear only when known.
   - After a `long_running` event for a task, the next one for the same task fires only after another
     `longTaskMs` of running.
   - A `long_running` event is dropped if the task settled before the event turn ran.
   - `long_running` carries no usage and does not count as a consumed outcome for
     `PlannerMessage.usage.tasks`.
   - In event turns where only `long_running` events were consumed, `NO_MESSAGE` stays allowed.
4. **Prompt.** `DIALOGUE_PLANNER_SYSTEM` states the mode in one or two lines:
   - after delegating, answer the user and end the turn;
   - the session wakes you when a task finishes or runs long;
   - polling a running task ends your turn.

## Contracts (`@mcp-abap-adt/llm-agent`)

- `TaskEvent.kind` adds `'long_running'`.
- `DialogueSignals` adds `'dialogue.wait'` with the payload above. Bump `DIALOGUE_SIGNALS_VERSION` only
  if consumers need it to detect the new signal. Otherwise keep the version and document the addition.
- `DialogueSession` options add `waitTickMs?: number` and `longTaskMs?: number`.
  - Both must be positive integers.
  - `0` disables the respective feature.
  - Validate like `maxCorrections`.

Consumers that switch over `TaskEvent.kind` must handle the new value. Within llm-agent this includes:
- `applyTaskEvent` (no plan change for `long_running`);
- usage summing (terminal kinds only);
- origin recorder lookup.

## Non-goals

- No LLM call on a tick.
- No hub or UI work here. The hub forwards `dialogue.wait` and sets the options in its own change.
- No change to worker budgets or to how tasks run.
- No persistence of timers; after restore the clock restarts from the restored tasks' timestamps.

## Constraints

- Static typing: no `any`, no `unknown` outside narrowed caught errors, no `as unknown as`, no
  silencing casts, no untyped callback params — product code and tests.
- Timers use the session's injectable clock / scheduler if one exists. Otherwise inject one for tests,
  so tests use fake timers and no real waiting.
- A timer never keeps the process alive (`unref` where available).
- Recording, signals and ticks never affect execution: emit failures are caught and logged as today.
- Changesets:
  - minor bump for `@mcp-abap-adt/llm-agent` (contracts);
  - minor bump for `@mcp-abap-adt/llm-agent-libs` (behaviour);
  - the libs dependency range must cover the new llm-agent version.

## Tests (must prove)

- Turn with a delegation followed by two `get_task` polls on a running task:
  - exactly one more planner call after the first poll;
  - the turn ends;
  - the reply is the planner text or the waiting note;
  - no corrective turn.
- Polls separated by a task outcome do not end the turn.
- Reading a finished task never ends the turn.
- Clock:
  - ticks emit `dialogue.wait` with correct elapsed times;
  - no planner calls on ticks;
  - the timer stops when tasks settle and on close.
- Long-running:
  - one `long_running` event at `longTaskMs`;
  - the next one at `2 × longTaskMs`;
  - none after the task settles;
  - the event-turn note text;
  - not counted in `usage.tasks`.
- Options validation; `0` disables each feature.
