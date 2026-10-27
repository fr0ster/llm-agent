# Pipelines

A **pipeline** decides which agent the server builds. It is selected by name in
YAML and resolved from a plugin registry. The server ships six built-in
pipelines; deployments can add their own as plugins.

```yaml
# smart-server.yaml
pipeline:
  name: stepper            # flat | linear | dag | stepper | controller | controller-weak | <plugin name>
  config:                  # the dialect of the chosen pipeline (see below)
    mode: planned-react
```

`pipeline: flat` (a bare string) is shorthand for `pipeline: { name: flat }`.
Omitting `pipeline:` defaults to `flat`.

> **Clean break (v19+).** The old `coordinator:` block and the legacy
> `pipeline: { mcp | rag | stages | llm }` overrides were removed; a config using
> them now fails loud at startup with a migration message. Top-level `llm:`,
> `mcp:`, `rag:`, `subagents:` are unchanged. Pin a version ≤ 18 for the old form.

## Built-in pipelines

Each built-in wraps the existing coordinator components; the `config:` block is
that variant's dialect.

| `name` | What it builds | `config:` keys |
|---|---|---|
| `flat` | Single ReAct tool-loop agent, no coordinator | *(none)* |
| `linear` | Ordered plan → dispatch coordinator | `planning` (`one-shot`/`replan-on-error`/`skill-steps`), `dispatch` (`self`/`subagent`/`hybrid`), `maxSteps`, `maxRetriesPerStep`, `failPolicy` |
| `dag` ⚠️ | _(legacy — see note below)_ Planner → parallel workers → finalizer | `planner`, `reviewer`, `finalizer`, `errorStrategy`, `stateOracle`, `maxRoundTrips` |
| `stepper` ⚠️ | _(legacy — see note below)_ Composition flow (planner/executor/evaluator/reviewer/finalizer) | `mode` (`cyclic-react`/`planned-react`/`deep-stepper`), `flow`, `knowledgeSeed`, `maxParallelSteps`, `maxDepth`, `evaluator`, `reviewer` |
| `controller` | Deterministic coordinator + three opaque subagent roles (evaluator/planner/executor); plan-first step loop, durable per-session bundle, stateless suspend/resume | `subagents.{evaluator,planner,executor}`, `targetState`, `sessionMemory`, `budgets` |
| `controller-weak` | Same as `controller` but with the **weak-executor** planner (fine-grained steps — one action per step); for smaller executor models that cannot self-expand | same as `controller` |

Stepper's `knowledgeSeed` (deployment-supplied tool guidance, seeded into a new
session's knowledge store) lives under `pipeline.config.knowledgeSeed`.

> **⚠️ `dag` and `stepper` are deprecated (legacy).** They keep running on their
> own legacy step-interpreter and remain selectable for backward compatibility,
> but they are no longer the active development path and will not receive the
> newer planner/replan/metering work. The `controller` pipeline (and its
> `controller-weak` variant) is the maintained interpreter and the
> recommended choice for new deployments. The newer controller interpreter was
> **not** designed to drive the legacy DAG/stepper flows — do not migrate a
> `dag`/`stepper` config onto it; pick `controller` directly instead. These two
> pipelines may be removed in a future major version.

### `controller` config

```yaml
llm:
  main:                               # the role's own default when a subagent names no llm key
    provider: sap-ai-sdk
    model: anthropic--claude-4.6-sonnet

pipeline:
  name: controller
  config:
    subagents:                       # three roles, each names a key of the top-level llm: map
      evaluator: {}                   # {} = the role's own name (llm.evaluator), else main
      planner:   {}                   # formulates the plan; {} = llm.planner, else main
      executor:  {}                   # carries out a step; emits tool calls
        # optionally: { hint: <operational steering> }  — mainly for weaker models
    targetState:                     # how the goal is confirmed
      strategy: auto                 # auto | semantic-distance | consumer-confirm
      distanceThreshold: 0.7         # (semantic-distance/auto) larger ⇒ ask to confirm
    sessionMemory: { collection: session-memory }
    budgets: { maxSteps: 20, maxRetries: 3, maxRewinds: 5, maxToolCalls: 10 }
```

**Budget fields** — all optional except the three required ones:

| Field | Required | Default | Description |
|---|---|---|---|
| `maxSteps` | ✅ | — | Maximum number of plan steps |
| `maxRetries` | ✅ | — | Maximum step-level retries |
| `maxRewinds` | ✅ | — | Maximum number of plan rewinds |
| `maxToolCalls` | — | unlimited | Total tool calls per run |
| `perStepTimeoutMs` | — | none | Per-step wall-clock limit in ms; exceeded → `ControlFailure.reason = 'step-timeout'` and replan. **Absent means a single step can run indefinitely — set this to prevent livelock.** |
| `maxStepAttempts` | — | unlimited | Fresh-attempt cap per step (durable) |
| `maxStepResumes` | — | unlimited | Crash-replay cap per step |
| `maxPlannerResumes` | — | unlimited | Cap on planner resume cycles |
| `maxEvalResumes` | — | unlimited | Cap on evaluator resume cycles |
| `maxFinalizeRetries` | — | unlimited | Finalizer retry cap |
| `maxReviewRetries` | — | unlimited | In-process re-ask budget for the reviewer |
| `maxDigestChars` | — | unlimited | Board digest render budget (chars) |
| `maxIntentChars` | — | unlimited | Goal/intent field length cap (chars) |
| `maxBoardChars` | — | unlimited | Live board render size cap (chars) |
| `maxActiveSteps` | — | unlimited | Concurrent in-flight steps cap |
| `keepRecentDigests` | — | unlimited | How many recent digests to keep on the board |

**Capability is preset-encoded — there is no `planner:` config key.** Select the
pairing by pipeline name:

- `pipeline: { name: controller }` → **smart-executor** planner (coarse steps; the
  capable executor self-expands a step in its tool-loop, control returns to the
  reviewer after each coarse step). The default controller preset.
- `pipeline: { name: controller-weak }` → **weak-executor** planner (fine-grained
  steps — exactly one action per step; for smaller executor models that cannot be
  trusted to self-expand).

A `planner:` key in the controller config is rejected fail-loud (migration: use the
preset name, or pass the kind to `new ControllerFactory().build(config, deps, 'weak-executor')`
when composing in code — `ControllerFactory` is the public controller export).

- Each subagent names a key of the top-level `llm:` map (`{ llm: <key>, hint? }`); an omitted `llm`
  means the role's own name, then `main`; an absent `reviewer`/`finalizer` uses the planner's key.
  Different roles can name different entries — e.g. a heavy planner + a light executor. The executor
  must be a **tool-capable** model the backend accepts (OpenAI function format) — on SAP AI Core,
  e.g. `gpt-4o-mini` or `anthropic--claude-4.5-haiku` (`anthropic--claude-3-haiku` could not call
  tools there, and AWS has since retired it).
- **Per-role hints (operational scaffolding for weaker models).** The engine's
  role system prompts are agnostic and concise. An optional `subagents.<role>.hint`
  is appended to that role's system prompt to give it extra **operational
  guidance** — how to build the plan, how to execute a step, what to be strict
  about. Its main purpose is to **scaffold weaker models**: a capable model
  (Opus / Sonnet) usually needs none, while a smaller executor/planner model
  (e.g. `gpt-4o-mini`) may need the steering. A hint is **not** a domain
  description and must **not** name tools — the self-describing tool catalog and
  the agnostic prompt cover those, and richer per-situation procedures belong to
  the **skills RAG** (a separate, dynamic mechanism, not wired via `hint`).
  `controller-mixed.yaml` carries an executor hint as a worked example.
- The **skills RAG** is provided by the **skill plugin-host** (`skillPlugins:`
  server config) — a domain-agnostic host that materializes consumer-supplied
  skills into a grouped, durable skills-RAG. Assembler pipelines (`flat`,
  `linear`, `dag`) recall it implicitly under a "Relevant Skills" block; the
  `controller` planner recalls the configured `controllerSkillGroup`, and the finalizer
  honors any output/delivery/formatting directives the skills specify. This keeps
  the engine free of bundled domain knowledge while gnosticizing any model at
  runtime. Config + examples: [EXAMPLES.md](EXAMPLES.md#skill-plugin-host-skillplugins--runtime-gnostification).
- Internal (MCP) tools are surfaced to the executor by **semantic top-K** from
  the vectorized tool catalog (`toolsRag`); a distance-based `targetState`
  strategy therefore needs an embedder (`consumer-confirm` does not).
- **Auxiliary tools (`IAuxiliaryMcpTools`).** The controller executor receives a small set of
  in-process auxiliary tools by default (currently: `wait` — lets the executor pause before
  retrying a tool call). These are supplied by `DefaultAuxiliaryMcpTools` and are transparent
  to consumers. To suppress them entirely (e.g. if a domain tool is also named `wait`), inject
  `new DefaultAuxiliaryMcpTools([])` via `BuildAgentDeps.auxiliaryMcpTools`. Collision between
  an auxiliary tool name and a domain MCP tool name fails loud at build time.
- **Tool-loop context strategy (`IToolLoopContextStrategy`).** Controls how the executor's
  context window grows across tool-loop iterations. The controller uses `RagRecall` (recall
  relevant past turns from the session knowledge store), which bounds token growth per step.
  The flat/server default is `Window` (sliding window); the bare builder default is `Legacy`
  (append-only). Override via `BuildAgentDeps.toolLoopContextStrategy`.
- `DEBUG_CONTROLLER=1` logs (stderr) the step instructions the planner delegates
  and per-role/total token spend. The HTTP response always carries total `usage`.
- Ready-to-run examples: [`pipelines/controller.yaml`](../pipelines/controller.yaml)
  (all-sonnet, `name: controller` — smart-executor) and
  [`pipelines/controller-mixed.yaml`](../pipelines/controller-mixed.yaml)
  (`name: controller-weak` — sonnet deciders + light `gpt-4o-mini` executor, with
  an executor hint that scaffolds the smaller model).

### `linear` planning/dispatch behaviour & guidance

`linear` is a **plan → dispatch** coordinator. The plan is built ONCE by the
`planning` strategy; each step is run by the `dispatch` strategy. Pick the
combination to match the task:

- **`planning`**: `one-shot` (plan once, never replan) · `replan-on-error`
  (delegates the initial plan to one-shot; rebuilds the remaining plan ONLY when a
  step fails) · `skill-steps` (plan comes from a skill's `steps:` block, no planner
  LLM). None of them feed step RESULTS back to the planner — the plan is static
  (one-shot) or reactive-on-failure (replan-on-error), never result-adaptive.
- **`dispatch`**: `self` (the coordinator's own LLM runs each step) · `subagent`
  (delegate the step to a named worker from `subagents:`) · `hybrid` (subagent,
  fall back to self).

**Known characteristics (so you choose the right config):**
- **The planner is tool-blind** — it sees only the request, the `subagents:` list,
  and selected skills, NOT the live system. For a task that needs material fetched
  first (e.g. "review program X"), `planning: one-shot` + `dispatch: self` may
  return a **clarification asking you to supply the material** instead of planning a
  fetch step. For such tasks use `dispatch: subagent`/`hybrid` with a tool-capable
  worker (which fetches the material itself), as in
  [`coordinator-orchestration.yaml`](examples/coordinator-orchestration.yaml).
- **Subagent dispatch is stateless across steps** — each step's worker is a fresh
  full agent run with no carried-over context, so a multi-step plan re-fetches the
  same material per step (additive latency, redundant work). For **result-aware,
  context-accumulating** planning, use the `controller` pipeline instead.

## Adaptive plan coordinator

`AdaptiveCoordinatorHandler` is an optional code-level coordinator in
`@mcp-abap-adt/llm-agent-libs`. It sits beside the `controller` pipeline; it does
not replace it. It has its own sequential interpreter and is not built on the
deprecated DAG/stepper interpreters. It uses the existing
`withStepperCoordinator` builder slot and shares the DAG handler's `terminalUsage`
helper. It is not a built-in YAML pipeline name.

One LLM controller plans per request and sizes the plan: its default prompt asks
for a literal answer for small talk, one work step plus an answer for simple
requests, and a spec and multiple steps when useful for complex/declarative tasks.
Checks, reactions to verdicts, revisions and questions are steps of that plan.
`LlmAdaptiveController` takes an `ILlm` instance; it selects no model itself.
Planning makes one LLM call; self-checks, revisions and stop reports make additional
calls when reached.

### Plan and execution

An `AdaptivePlan` contains `steps`, `createdAt` and an optional `ITaskSpec` (`spec`).
The handler sets `spec.raw` to the current request. Every step has a unique `id`
and a `kind`:

| Kind | Fields besides `id` and `kind` | Behaviour |
|---|---|---|
| `work` | `goal`, `worker`, optional `context`, `maxRuns` | Runs the named worker. |
| `check` | `goal`, `worker`, `targets`, `onPass`, `onFail`, optional `onPartial`, `context`, `maxRuns` | Gets a `{ verdict: 'pass' \| 'fail' \| 'partial', reason }` from a worker, or from the controller with `worker: 'self'`, and branches. |
| `ask` | `question` | Ends the turn with the question. |
| `revise` | `reason`, optional `maxRuns` | Asks the controller to replace all remaining steps; replacement steps are validated and cannot reuse retained ids. |
| `answer` | Exactly one of `from` or `text` | Answers with the latest successful result of `from`, or literal `text`. |

Execution is sequential. Only a check can jump: a branch target is `next` (the
following step), `end` (finish the plan), or an existing step id, including a
backward jump. `next` and `end` are reserved and cannot be step ids. A partial
verdict uses `onPartial ?? onFail`. The verdict reason is passed to the worker
at the branch destination. Ending without an answer produces a stop report.

The parser accepts integer `maxRuns` values from 1 through `MAX_RUNS_CAP` (5)
for work, check and revise. Defaults are 1 for work/revise and 3 for check;
ask/answer run once and have no `maxRuns` field. A repeated work step needs an
explicit allowance. Exceeding a step's run limit stops execution with a report.
An unparsable worker verdict counts as failure. A failed work step continues
only if a later check lists it in `targets`; otherwise it stops with a report.

Work/check steps can select a `context` object:

| Field | Meaning |
|---|---|
| `spec?: boolean` | Include the rendered spec by default; `false` omits it. |
| `history?: 'none' \| 'last-turn' \| 'all'` | `none` passes no messages; `last-turn` passes the last user message and a following assistant message if both exist; `all` (default) passes the last 20 messages. |
| `results?: string[]` | Include selected latest results, in plan order. Checks also include their targets, deduplicated. Each output is limited to 8000 characters with an omission note. |
| `note?: string` | Append a step-specific instruction. |

The request and step goal always reach a worker. Truncated `all` history adds
an omission note to the task. `worker: 'self'` checks receive the request, spec,
check step and latest target records through `controller.check`, plus the same
composed `task` and selected `history` as a check worker (including the JSON
instruction). Selected results outside targets are included; `context.spec: false`
omits the spec from both the task and the direct spec field. The default controller
includes the task and history in its check prompt.

The default request budget is `{ maxSteps: 20, maxRevisions: 3,
maxDurationMs: 300000 }`; override individual fields with `budget` in the handler
dependencies. Step/time limits are checked before each step, so the duration
limit does not interrupt an in-flight call. A stop calls `controller.report`;
if reporting fails, deterministic text lists the stop reason and step records.
Cancellation during reporting propagates, including when the report resolves after
the signal aborts; it never produces a successful terminal chunk.

If planning throws (including an invalid response parsed by
`LlmAdaptiveController`), the handler logs `adaptive_plan_fallback` and uses a
one-work-step fallback plan: `exec` runs the request with `history: 'all'`, then
`answer` reads `exec`. The default fallback worker is `executor`, configurable
with `fallbackWorker`; that worker must be registered. An `AbortError` from
planning is propagated instead of falling back.

### History and run records

The handler removes a trailing user message equal to the current request from
`ctx.history` before planning or composing worker input. Selected messages reach
workers through optional `ISubAgentInput.history`. `SmartAgentSubAgent` passes
non-empty history to `agent.process` as those messages followed by the current
user prompt; with empty/no history it keeps the string-prompt call.

A `RunRecord` holds `runId`, request, final plan, step records, outcome, optional
stop reason and `finishedAt`. Each `StepRecord` holds step id/kind, run number,
status, output, optional verdict/error and duration. Outcomes are `answered`,
`asked`, `stopped` and `awaiting-external`.

Supply `IRunRecordStore` (`load(sessionId)`, `save(sessionId, record)`) and a
session id to persist runs. `InMemoryRunRecordStore` keeps only the latest record
per session in a process-local map. The handler loads it as `previousRun` for the
next planning call and saves the result before finalization, including questions
and pending external calls. Store errors are logged as
`adaptive_record_load_failed` / `adaptive_record_save_failed` and do not fail the
request. This is context for a fresh plan, not automatic cursor resumption.
`LlmAdaptiveController` includes the previous request, plan, outcome, stop reason
and records (outputs capped at 500 characters); planning history is capped at
20 messages and 1000 characters per message.

### Streaming, finalization and external tools

The interpreter forwards content only from a worker named by an answer's `from`
in the current plan, and only on that worker step's first run. The handler forwards
it live when there is no finalizer or when `finalizer.streamsInterpreterContent`
is true. A re-run does not stream again. `ephemeral: true` content keeps its flag
and does not count toward the streamed final answer; non-streaming accumulation
also excludes it.

Progress chunks use `LlmStreamChunk.status` (`StepStatus`): `stepId`, `kind`,
`state` (`started`, `done`, `failed`), optional `goal` and check `verdict`. They
carry `content: ''`, so they add no text to non-streaming results. An ordinary
failing verdict can have state `done`; `failed` describes a failed step execution.

Only an `answered` outcome invokes the optional finalizer, with request as
`prompt`, `spec.objective ?? request` as `objective`, `interpreterOutput` and an
execution trace of `{ nodeId, goal, output }`. An opted-in finalizer receives
`interpreterContentStreamed`: true only when the answer source ran once and its
non-ephemeral streamed text ends with the complete trimmed, non-empty answer
(trailing stream whitespace ignored). It may skip re-emission only then; false
requires emitting the final text even if earlier partial text was visible.
Finalizers must emit content through `onPartial`; this handler does not emit
`FinalizerResult.output`. Without a finalizer it emits the answer unless already
fully streamed. Questions and stop reports bypass the finalizer.

Workers receive `externalTools` and `externalResults`. A worker returning
`status: 'awaiting-external'` ends the run, saves its record when configured,
surfaces pending calls as indexed `toolCalls` with JSON-stringified arguments,
and ends with `finishReason: 'tool_calls'`, bypassing the finalizer. Other outcomes
end with `finishReason: 'stop'`; terminal chunks include usage when available.

Worker usage accounting defaults to DAG ownership: workers log their own calls
and the handler does not log their returned usage again. Set
`AdaptiveCoordinatorDeps.logWorkerUsage` to the names of workers that delegate
accounting to the coordinator. The interpreter exposes `workerUsage` per executed
worker step, including usage attached to thrown errors. The handler logs only
listed workers, once per step, under `executor` (the logger has no `worker`
component), using the returned `metadata.model` when present, otherwise `unknown`.
Unlisted workers retain ownership, including in mixed runs. Controller
plan/check/revise parse errors retain response usage: the handler logs it once
under planner or reviewer even on fallback.

A work or check worker returning `errorClass: 'epicfail'` terminates immediately:
no check branch, retry, report, finalizer, or successful terminal chunk follows.
The step is recorded as failed. An `AdaptiveEpicFailError` (an `OrchestratorError`
with code `COORDINATOR_STEP_FAILED`) preserves the worker's `epicFailTrace`
unchanged and carries the stopped run. When configured, the handler saves that
run with outcome `stopped` and stop reason `step <id> epicfail` before surfacing
the error through `ctx.error`. Returned usage is accounted for using the same
ownership rules even on this fatal path.

For semantic history, `ctx.assistantText` holds the finalizer's returned output
when finalized, otherwise the answer, question, or stop report. Awaiting external
calls leave this field untouched, matching DAG.

### Embedding

Provide an `ILlm`, a configured builder, named `ISubAgent` workers and an optional
`IFinalizer`. For example, with an `executor` registered in `workers`:

```ts
import {
  AdaptiveCoordinatorHandler,
  InMemoryRunRecordStore,
  LlmAdaptiveController,
} from '@mcp-abap-adt/llm-agent-libs';

const runRecords = new InMemoryRunRecordStore();
const handle = await builder.withStepperCoordinator(new AdaptiveCoordinatorHandler({
  controller: new LlmAdaptiveController(llm), workers, finalizer, runRecords,
})).build();
// Supply the same sessionId on subsequent requests to load previousRun.
```

## Dialogue planner

The dialogue planner is a set of code-level building blocks in
`@mcp-abap-adt/llm-agent-libs`, beside the adaptive coordinator. It is not a YAML
pipeline. The consumer supplies the planner's `ILlm` and worker `ISubAgent`s.

### Wait mode

`DialogueSession.open` accepts non-negative integer `waitTickMs` (default 30,000)
and `longTaskMs` (default 300,000); zero disables each independently. A second
active-task status read (`get_task` or `list_tasks`) in one turn, with no outcome
between reads, returns its tool result and ends the planner loop through a
turn-owned cooperative `stopSignal`. The caller's `stopSignal` is combined with
it; hard cancellation via `signal` is preserved. No further model call or
correction runs. The reply retains planner text or lists active task ids/workers
in a waiting note. Finished-task reads never count. The actions record includes
`wait (turn ended: tasks running)`.

While tasks are queued or running, ticks emit catalog v1 `dialogue.wait`:
`{ tasks: Array<{ id; worker; goal; state: 'queued' | 'running'; elapsedMs;
toolCalls?; maxToolCalls? }> }`. Elapsed time uses `startedAt`, else `createdAt`.
Ticks make no planner calls. Running tasks generate a `long_running` event at
`longTaskMs` and again after each further interval. Its task-event note asks the
planner to check and keep waiting, stop, or re-delegate, and includes elapsed
time and known tool counts. These events carry no usage, do not change plans,
and do not contribute to `PlannerMessage.usage.tasks`; `NO_MESSAGE` is allowed.
Events for tasks that settled before consumption are dropped.

Timers stop on settlement and close, never keep the process alive, and are not
persisted. Restore interrupts active tasks, so it starts no wait clock for them.
Tests can inject `now` and `scheduleTimer(callback, delayMs)`, which returns a
cancellation function. Signal failures are caught and logged without affecting work.
`DIALOGUE_SIGNALS_VERSION` remains 1 because this catalog addition is additive.

### Parts and rules

- **Cooperative stop:** optional `stopSignal` reaches the tool loop through agent
  call options and `ISubAgentInput`. After the first iteration, the loop checks it
  between iterations, returns partial output with `stopped: true` and the normal
  `stopReason: 'stop'`, and emits a terminal `finishReason: 'stop'`. It does not abort an in-flight LLM or
  tool call. `signal` retains hard-abort behavior. `SmartAgentSubAgent` forwards
  the signal and maps the result to `status: 'complete', stopped: true`.
- **`TaskBoard` + `SemaphorePool`:** `start()` returns a task record without
  awaiting the worker. Defaults are `maxConcurrent: 3` and `maxTasks: 50` per
  board; both must be positive integers. The task cap includes completed and
  restored records. Unknown workers and exceeding the task cap return errors
  (`unknown worker <name>` / `task limit <n> reached`), surfaced as tool errors
  to the planner. Tasks queue FIFO and run only after acquiring both a board
  slot and an optional shared pool slot. A board slot can be held while waiting
  for the shared pool. Default ids are `t1`, `t2`, ...; `newId` can override them.
  States are `queued`, `running`, `done`, `failed`, `stopped`, `interrupted`.
  A thrown worker error or `errorClass: 'epicfail'` fails the task;
  `awaiting-external` fails with
  `external tool calls are not supported in background tasks`. A worker result
  with `stopped: true` becomes `stopped`; other successful results become
  `done`. Stopping a queued task marks it stopped immediately; stopping a running
  task requests cooperation, and its eventual result determines the outcome.
  Stored output keeps the first `TASK_OUTPUT_CHAR_LIMIT` (4000) characters plus
  a `[cut: <n> characters omitted]` note, so events and `get_task` see bounded
  output. Error strings from thrown exceptions are not cut by this limit.
  The board emits `started`, `done`, `failed`, `stopped` events synchronously;
  observer exceptions do not affect execution.
- **`PlannerToolsClient` + planner scope:** an in-process `IMcpClient` exposes
  `delegate_task`, `stop_task`, `get_task`, `list_tasks`, `update_plan`.
  `runInPlannerScope` uses AsyncLocalStorage to bind the current board, plan and
  history; `DialogueSession` establishes that scope for each planner turn.
  Listing tools inside the scope includes worker names in `delegate_task`'s
  schema. Tool calls outside it return an `isError` result (`no planner session`);
  tool validation and board errors also become `isError` results.
  Delegation history defaults to `none`; `last-turn` selects the last user
  message and a following assistant message if present; `all` selects the last
  20 messages. These are selected from the planner conversation, including event
  notes, rather than a separate user-only history.
- **`DialogueSession` + `IDialogueStateStore` / `InMemoryDialogueStateStore`:**
  open one actor per user session. It serializes planner turns; `send()` resolves
  with the reply to that user's own queued message. Queued user turns run FIFO
  before the next event turn. Outcomes (`done`, `failed`, `stopped`) and non-terminal `long_running` events
  wake the planner; `started` does not. Buffered outcomes coalesce in arrival order into
  one user-role `[task events]` note listing task id, worker, kind, goal and error
  or output. Events arriving during a turn wait for a later event turn.
  An event reply whose trimmed text equals `NO_MESSAGE` stays in conversation
  history but is not delivered. Other event replies enter `pending` and invoke
  `onMessage`; `takePending()` returns and clears that queue. User replies are
  never suppressed by `NO_MESSAGE`.
  Conversation history is capped at `DIALOGUE_HISTORY_LIMIT` (200 messages) on
  restore and after each appended message. `snapshot()` contains conversation,
  plan, task records, pending messages and `savedAt`. When a store is supplied,
  each turn attempts a save, including failed turns, unless closing; save errors
  are swallowed and reported through the optional logger. The in-memory store
  clones state on load/save and is process-local. `open()` restores queued and
  running tasks as `interrupted`, without rerunning them. The next turn's input
  is prefixed with `[restart] interrupted tasks: <ids>` and a note that their
  real state is unknown and must be checked before continuing.
  `close()` rejects queued and future sends, prevents new turns, requests stops,
  waits for the active turn and tasks to settle, then stops any tasks delegated
  by that settling turn. It clears pending messages and deletes stored state;
  it does not retain a final snapshot. Repeated calls share the close promise.
- **`DIALOGUE_PLANNER_SYSTEM`:** prompt guidance covers dialogue, planning,
  delegation and control: state goals rather than implementation details,
  establish a specification for complex declarative requests, record/revise
  plans, track task identities, react to results and answer in the user's
  language. It asks the planner to delegate and answer without waiting, run only
  independent work in parallel, sequence work sharing objects/locks/transports
  or dependencies, use `NO_MESSAGE` for silent event turns, and discuss checks
  after a restart. These are model instructions; the board enforces the numeric
  limits, not dependency or resource-conflict detection.

### Embedding example

The resource scope below is consumer-supplied (for example, an AsyncLocalStorage
connection scope read by the workers). `wrapRun` surrounds each actual worker run
and releases its resources in `finally`.

```ts
import type { ILlm, ISubAgent, TaskRecord } from '@mcp-abap-adt/llm-agent';
import {
  DIALOGUE_PLANNER_SYSTEM,
  DialogueSession,
  InMemoryDialogueStateStore,
  PlannerToolsClient,
  SemaphorePool,
  SmartAgentBuilder,
} from '@mcp-abap-adt/llm-agent-libs';

declare const plannerLlm: ILlm;
declare const workers: ReadonlyMap<string, ISubAgent>;
declare function openTaskResources(task: TaskRecord): Promise<{
  scope<T>(run: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

// Shared across all user sessions in this process.
const pool = new SemaphorePool(6);
const store = new InMemoryDialogueStateStore();

async function openUserSession(id: string) {
  const handle = await new SmartAgentBuilder({
    prompts: { system: DIALOGUE_PLANNER_SYSTEM },
  })
    .withMode('hard') // Offer every MCP control tool without RAG selection.
    .withMainLlm(plannerLlm)
    .withMcpClients([new PlannerToolsClient()])
    .build(); // handle.agent is the planner SmartAgent

  const session = await DialogueSession.open({
    id,
    planner: handle.agent,
    store,
    board: {
      workers,
      maxConcurrent: 3,
      maxTasks: 50,
      pool,
      baseInput: () => ({ sessionId: id }),
      wrapRun: async (task, run) => {
        const resources = await openTaskResources(task);
        try {
          return await resources.scope(run);
        } finally {
          await resources.close();
        }
      },
    },
  });
  return {
    session,
    async close() {
      try {
        await session.close();
      } finally {
        await handle.close();
      }
    },
  };
}

// Retain this object for this user session; do not reopen it per message.
const userSession = await openUserSession('session-1');
const reply = await userSession.session.send('Inspect the requested changes.');
console.log(reply.text);
// On later requests, also drain event replies, or supply onMessage for a push channel.
console.log(userSession.session.takePending());
// At session end (close deletes persisted dialogue state):
await userSession.close();
```

## Adding a custom pipeline (plugin)

A pipeline is an `IPipelinePlugin` (from `@mcp-abap-adt/llm-agent`): it names itself and builds
from `ctx`; its settings arrive in its constructor, and it builds an `IPipelineInstance` (`{ agent,
close }`). Server-side plugins receive an `IServerPipelineContext` (from
`@mcp-abap-adt/llm-agent-server-libs`) whose `createAgentBuilder()` returns a
builder pre-wired with all shared infra (RAG/MCP/embedder/adapters/subagents) —
the plugin only registers its coordinator and builds.

Load custom pipelines into the server by module specifier:

```yaml
plugins:
  - '@acme/superpuper-pipeline'   # npm package exporting PluginExports.pipelinePlugins
pipeline:
  name: superpuper
  config: { ... }
```

The package exports its plugins via the standard plugin surface:

```ts
// @acme/superpuper-pipeline
export const pipelinePluginFactories = {
  superpuper: (raw: unknown) => new SuperPuperPipelinePlugin(parse(raw)),
};
```

A plugin that needs no settings keeps a plain `pipelinePlugins` instance export instead. A plugin's
`name` must equal its export key; the loader reports a mismatch in `errors`.

Specifiers resolve against the user's `cwd`. The host merges each module's full
`PluginExports` (so a pipeline package may also ship `embedderFactories`,
`mcpClients`, etc.). Duplicate pipeline names across sources fail fast.

## Embedding in code (no YAML)

Consumers embedding the runtime build agents directly from components. The old
coordinator components remain available under `legacy/*` subpath exports:

```ts
import { DagCoordinatorHandler } from '@mcp-abap-adt/llm-agent-server-libs/legacy/dag';
import { DagPipelinePlugin }    from '@mcp-abap-adt/llm-agent-server-libs/dag';
```

Each built-in plugin has a subpath export (`./flat`, `./linear`, `./dag`,
`./stepper`, `./controller`). Two ways to use a pipeline without YAML:

```ts
// (a) Use the plugin programmatically — parse the section with the server's own
//     parser, construct the plugin with the typed settings, and build against a
//     server pipeline context (createServerPipelineContext wires the infra). A
//     plugin reads no configuration: parsing is the caller's job, same as the
//     server's registry does it.
import { parseControllerSettings } from '@mcp-abap-adt/llm-agent-server-libs';
import { ControllerPipelinePlugin } from '@mcp-abap-adt/llm-agent-server-libs/controller';
const settings = parseControllerSettings({ subagents: { evaluator, planner, executor } });
const plugin = new ControllerPipelinePlugin('controller', 'smart-executor', settings);
const { agent, close } = await plugin.build(serverCtx);

// (b) Compose the coordinator onto your own SmartAgentBuilder via the
//     ControllerFactory — an IPipelineFactory (kind 'controller'), the
//     code-level counterpart to the Stepper *Factory classes. It resolves the
//     three role LLMs via makeRoleLlm, wraps them as subagent clients, validates
//     the embedder requirement, and returns { handler }.
import { ControllerFactory } from '@mcp-abap-adt/llm-agent-server-libs/controller';

// You construct each role's ILlm yourself (see MIGRATION-v27.md item 2) and hand
// in the instances — the factory resolves no config and reads no credential.
declare const llms: Record<'evaluator' | 'planner' | 'executor', ILlm>;

const { handler } = await new ControllerFactory().build(config, {
  makeRoleLlm: async (role) => llms[role as 'evaluator' | 'planner' | 'executor'],
  callMcp, backend, knowledgeRagFor, embedder, selectTools,
  // model ids for usage attribution are derived from the resolved LLMs.
});
const handle = await builder.withStepperCoordinator(handler).build();
// (The lower-level `ControllerCoordinatorHandler` is also re-exported from the
//  same subpath if you prefer to construct it directly with `config` inline.)
```

See `docs/ARCHITECTURE.md` for the layered design and `docs/QUICK_START.md` for
end-to-end setup.
