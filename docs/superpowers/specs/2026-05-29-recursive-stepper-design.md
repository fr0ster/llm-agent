# Recursive Stepper Architecture — Design Spec

> **Target release:** 18.0.0
> **Predecessor:** 17.0.0 (DAG coordinator + per-role LLM map + streaming) — currently in `main`.
> **Vision input:** `docs/superpowers/specs/2026-05-29-recursive-stepper-vision.md` — the brainstorm conversation that produced this spec. The vision doc and this design doc are both temporary per `feedback_no_specs` — both will be deleted after the implementation lands in `main`.

## A. Goal

Replace the flat DAG coordinator with a **recursive Stepper hierarchy** over a per-session shared knowledge-RAG. Plans are shallow at each level; decomposition is deferred to child Steppers spawned at runtime; data flows through the knowledge-RAG instead of through return values; one root finalizer composes the answer from the accumulated RAG. The architecture supports three configurable execution modes (cyclic-react / deep-stepper / planned-react), read-only and mutating interactions, session persistence + resume, and progress-event streaming.

## B. Architecture

### B.1 The Stepper

The single recursive unit. Every coordinator, worker, and subagent in the runtime is a Stepper. The hierarchy is parent-child by depth in the tree of recursive dispatches; there is no type-level distinction between "coordinator" and "worker" — they are all Steppers, only their position differs.

Stepper composition:

```
Stepper {
  planner       // emits a shallow plan from prompt + knowledge-RAG queries
  reviewer      // validates the plan against the parent task and RAG state (depth-conditional, see C.3)
  interpreter   // dispatches plan steps → child Steppers OR the executor
  executor      // bottom: MCP-tool call OR terminal LLM call; writes artefacts to knowledge-RAG
}
```

**Finalizer is NOT part of the Stepper.** It exists once, at the coordinator boundary above the root Stepper. It is the single text producer for the consumer.

### B.2 Knowledge-RAG

A single per-session vector collection (the "blackboard"). Two operations:

- **`write(entry)`** — executors append step artefacts (source code, MCP results, intermediate analyses) as embeddings keyed by session_id.
- **`query(text, k?)`** — planners retrieve relevant prior facts before authoring a plan.

Scope = per-session. Backed by any persistent vector store (`qdrant` / `hana-vector` / `pg-vector`) or the in-memory store for stateless deployments. No LRU / TTL / explicit reset in v1 (deferred until operational pressure surfaces). Cross-session ("user-scoped") memory is an auth-enabled downstream concern, out of scope.

### B.3 Tools-RAG

Existing 17.0 surface unchanged. Indexes MCP-tool descriptions plus consumer-passed-through tools. Planners and the `INeedResolver` (D.4) query it to discover capabilities.

### B.4 Root finalizer

Lives at the coordinator boundary, NOT inside any Stepper. After the root Stepper's interpreter completes, the coordinator invokes the finalizer with:

- the original consumer prompt;
- a read handle to the session's knowledge-RAG.

The finalizer either composes the final answer text or raises an `InsufficientSignal` carrying `missing[]` upward. The coordinator on insufficient either returns the message to the consumer or (if budget allows) triggers a root replan with `missing[]` as a hint.

### B.5 Sufficiency mechanism

Layered, no LLM-driven sufficiency oracle in v1:

1. **Depth + token budget.** Each Stepper inherits a budget from its parent; budget is decremented as it spawns children or makes LLM calls.
2. **INCOMPLETE bubble.** A Stepper that cannot complete its work returns `{ status: 'incomplete', missing: [...] }`. Parent decides — add a step to obtain `missing`, or escalate up.
3. **Budget-extension clarify.** On budget exhaustion the Stepper raises a `ClarifySignal` upward: *"Budget exhausted at depth N / X tokens used. Continue with extended budget, or stop with what we have?"* Consumer answers `continue` → coordinator extends budget and restarts at root from the saturated knowledge-RAG (no checkpoint-based resume in v1). Consumer answers `stop` → return partial.

### B.6 Cycle prevention

No hash-based detector. Cycles are prevented by construction:

1. **RAG-first planning.** Every planner queries the knowledge-RAG before authoring its plan; existing facts are reused, not re-fetched.
2. **`PLANNER_SYSTEM` "decompose to concrete leaves" directive.** If a task is achievable by one tool call, emit that call as the single plan step — do not re-emit the parent's task verbatim.
3. **Depth budget** (B.5) as bottom-floor insurance.

## C. Components and contracts

### C.1 New TypeScript interfaces

```ts
// @mcp-abap-adt/llm-agent

export interface IStepperInput {
  prompt: string;
  knowledgeRag: IKnowledgeRagHandle;
  toolsRag: IToolsRagHandle;
  budget: { depthRemaining: number; tokensRemaining: number };
  signal?: AbortSignal;
  sessionLogger?: ISessionLogger;
  trace?: { traceId: string };
  onProgress?: (event: StreamChunk) => void;
}

export interface IStepperResult {
  status: 'ok' | 'incomplete' | 'budget-exhausted';
  missing?: string[];
  usage: LlmUsage;
}

export interface IStepper {
  readonly name: string;
  run(input: IStepperInput): Promise<IStepperResult>;
}

export interface IStepperPlanner {
  readonly name: string;
  plan(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    parentPath: string[];
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<DagPlan>;
}

export interface IStepperInterpreter {
  readonly name: string;
  interpret(
    plan: DagPlan,
    ctx: {
      prompt: string;
      knowledgeRag: IKnowledgeRagHandle;
      toolsRag: IToolsRagHandle;
      childSteppers: ReadonlyMap<string, IStepper>;
      executor: IExecutor;
      budget: { depthRemaining: number; tokensRemaining: number };
      maxParallelSteps: number;
      signal?: AbortSignal;
      onProgress?: (event: StreamChunk) => void;
    },
  ): Promise<IStepperResult>;
}

export interface IExecutor {
  readonly name: string;
  execute(input: {
    prompt: string;
    tools: readonly Tool[];
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    needResolver?: INeedResolver;
    signal?: AbortSignal;
    onProgress?: (event: StreamChunk) => void;
  }): Promise<{ status: 'ok' | 'incomplete'; missing?: string[]; usage: LlmUsage }>;
}

export interface IKnowledgeRagHandle {
  query(text: string, k?: number): Promise<readonly KnowledgeEntry[]>;
  write(entry: { content: string; metadata?: Record<string, unknown> }): Promise<void>;
  fingerprint(): string;  // cheap snapshot id, for B.6 diagnostic only
}

export interface IToolsRagHandle {
  query(text: string, k?: number): Promise<readonly Tool[]>;
  lookup(name: string): Tool | undefined;
}

export interface INeedResolver {
  resolve(llmResponse: string): Promise<{
    queryToolsRag?: string;
    queryKnowledgeRag?: string;
    injectTools?: string[];
  } | undefined>;
}

export class InsufficientSignal extends Error {
  readonly missing: string[];
  readonly usage?: LlmUsage;
  constructor(missing: string[], usage?: LlmUsage) { super('insufficient'); this.missing = missing; this.usage = usage; }
}
```

### C.2 StreamChunk extension

Additive to the 17.0 union. The existing `content` variant is preserved (used by the root finalizer). All progress variants carry `source` (Stepper name, for debug) and optionally `parent` (so a UI can build a topology view).

```ts
export type StreamChunk =
  // 17.0 — root finalizer's sequential text output
  | { kind: 'content'; delta: string }
  // 18.0 progress events
  | { kind: 'stepper-spawned'; source: string; goal: string; parent?: string }
  | { kind: 'stepper-done';    source: string; ok: boolean }
  | { kind: 'mcp-call';        source: string; tool: string; args?: unknown }
  | { kind: 'mcp-result';      source: string; tool: string; durationMs: number; bytes?: number }
  | { kind: 'tokens-used';     source: string; component: LlmComponent; delta: LlmUsage }
  | { kind: 'llm-call-start';  source: string; component: LlmComponent; model: string }
  | { kind: 'llm-call-end';    source: string; component: LlmComponent; durationMs: number };
```

The 17.0 progress variants from PR #163 (`node-start`, `node-end`, `tool-call` flat) are renamed/folded into the new shape: `stepper-spawned` subsumes `node-start`; `stepper-done` subsumes `node-end`; `mcp-call` + `mcp-result` replace the flat `tool-call`. 17.0-flavoured clients receive the new `kind` values; old `node-*` are no longer emitted (breaking, see J).

### C.3 Reviewer depth policy

`coordinator.stepper.reviewer.atDepths` (yaml) controls which depths run a reviewer between `planner.plan()` and `interpreter.interpret()`. Default: `[0, 1]` — reviewer ON at depths 0 and 1, OFF at deeper levels. Override with explicit list or `'all'`. The reviewer type (`IReviewStrategy` from 17.0) is reused unchanged.

### C.4 Mutate tool annotation

MCP-tool descriptions gain an optional `mutating: boolean` field. Coordinator policy:

- `mutating: false | undefined` → executor calls without confirmation.
- `mutating: true` → executor raises `ClarifySignal('about to call <tool>(<args>), proceed?')` before the call, unless `coordinator.mutationPolicy: trusted` is configured for the session.

Tools that ship without the field default to non-mutating. Tool authors must opt in to confirmation by marking `mutating: true`.

### C.5 Three modes wiring

Yaml mode selector at the coordinator block:

```yaml
coordinator:
  mode: planned-react        # default; planner + cyclic-react workers
  # mode: cyclic-react       # single Stepper with INeedResolver
  # mode: deep-stepper       # full recursive hierarchy
```

Internally one Stepper contract; modes differ only by the wiring of planner / executor / recursion policy applied by `buildStepperRoot()` (analogous to PR #163's `buildDagCoordinatorDeps`).

### C.6 maxParallelSteps

`coordinator.stepper.maxParallelSteps` — one global yaml value, locally enforced per Stepper (each parent caps concurrent children with its own pool of N). Default 4. `0` or `1` forces sequential. No cross-tree semaphore in v1.

## D. Components — concrete implementations

### D.1 `Stepper` (libs)

`packages/llm-agent-libs/src/coordinator/stepper/stepper.ts` — `class Stepper implements IStepper`. Composes `planner`, optional `reviewer`, `interpreter`, `executor`. Implements the run loop:

1. `planner.plan(...)` with knowledge-RAG query in scope.
2. (If reviewer enabled at this depth) `reviewer.review(...)`.
3. `interpreter.interpret(plan, ctx)` — recursive dispatch.
4. Return `IStepperResult`.

### D.2 `LlmStepperPlanner`

`packages/llm-agent-libs/src/coordinator/stepper/llm-stepper-planner.ts` — `class LlmStepperPlanner implements IStepperPlanner`. Adapts the existing `LlmDagPlanner` shape to read knowledge-RAG before planning and to receive `parentPath` for the `PLANNER_SYSTEM` directive (B.6.2). System prompt updated to: (a) require RAG-first reasoning, (b) emit concrete-leaf steps, (c) re-iterate cost-of-decomposition language from PR #163 Task 15.

### D.3 `StepperInterpreter`

`packages/llm-agent-libs/src/coordinator/stepper/stepper-interpreter.ts` — `class StepperInterpreter implements IStepperInterpreter`. Reuses 17.0's wave-based ready-node execution from `DagPlanInterpreter`, but per ready node:

- if `node.agent` references a registered subagent — dispatch as a recursive child `Stepper.run(...)` with budget halved per depth (configurable);
- else dispatch the node to the local `executor`.

Emits `stepper-spawned` / `stepper-done` events.

### D.4 `CyclicReActExecutor` (with `INeedResolver`)

`packages/llm-agent-libs/src/coordinator/stepper/cyclic-react-executor.ts` — leaf executor implementing the context-augmenting ReAct loop:

```
loop until clean answer OR budget exhausted:
  call LLM with current tools + knowledge-RAG snippet
  classify the response:
    clean final answer  → knowledgeRag.write(...) → return ok
    tool call           → execute MCP, knowledgeRag.write(result), append to message history, loop
    "I need X" signal   → needResolver.resolve(response)
                          → inject candidate tools / RAG snippets into next call's context
                          → loop
```

Emits `mcp-call` / `mcp-result` / `tokens-used` / `llm-call-start/end` events.

### D.5 `RegexNeedResolver` and `LlmNeedResolver`

`packages/llm-agent-libs/src/coordinator/stepper/need-resolver.ts` — two implementations of `INeedResolver`:

- `RegexNeedResolver` — pattern-matches phrasings like "I can't", "I need", "I lack", etc. Cheap, deterministic. Default.
- `LlmNeedResolver` — small classifier LLM call: "is this utterance a need signal? if yes, what capability is being asked for?". Opt-in.

### D.6 `KnowledgeRag`

`packages/llm-agent-libs/src/rag/knowledge-rag.ts` — wraps any 17.0 `IRag` backend (in-memory / qdrant / hana / pg) with the read+write+fingerprint surface. Per-session keyed.

### D.7 `RootFinalizer`

`packages/llm-agent-libs/src/coordinator/stepper/root-finalizer.ts` — coordinator-boundary component (not a Stepper). Takes the consumer prompt + knowledge-RAG read handle, runs one LLM call with a system prompt that instructs: "compose the final answer from the provided knowledge entries; if any required fact is missing, return `{insufficient: missing[]}` instead". Streams its text output as `kind: 'content'` chunks.

### D.8 `buildStepperRoot`

`packages/llm-agent-server/src/smart-agent/build-stepper-root.ts` — analogous to 17.0's `buildDagCoordinatorDeps`. Pure async factory that assembles `{ rootStepper, finalizer, budget, maxParallelSteps, mutationPolicy }` from the yaml coord block + registered subagents + per-role LLM map.

## E. Data flow — worked example

User prompt: "Review ABAP program `ZDMS_UPLOAD_FILES` for security, performance, clean core, maintainability."

```
coordinator (root finalizer not yet involved)
└── Root Stepper
    ├── planner queries knowledge-RAG("program ZDMS_UPLOAD_FILES") → empty
    ├── planner emits plan:
    │     [ "read source of ZDMS_UPLOAD_FILES",
    │       "code-review ZDMS_UPLOAD_FILES" ]   (dependsOn: code-review on read-source)
    ├── reviewer (depth 0, enabled) accepts plan
    └── interpreter
        ├── Step "read source" → Child A Stepper
        │   ├── planner queries RAG → empty
        │   ├── planner emits ONE-STEP plan: "call GetProgFullCode(ZDMS_UPLOAD_FILES)"
        │   │   (PLANNER_SYSTEM "decompose to concrete leaves" prevents re-decomposition)
        │   ├── interpreter dispatches to executor
        │   └── CyclicReActExecutor:
        │         calls LLM → tool-call GetProgFullCode
        │         executes MCP, writes source to knowledge-RAG
        │         LLM emits clean confirmation → return ok
        └── Step "code-review" → Child B Stepper (depth 1)
            ├── planner queries RAG → finds source (Child A wrote it)
            ├── planner emits plan:
            │     [ "security review", "performance review", "clean core review", "maintainability review" ]
            │     (no dependsOn — planner asserts they are orthogonal)
            ├── reviewer (depth 1, enabled) accepts plan
            └── interpreter with maxParallelSteps=4 fans out concurrently:
                ├── Grandchild B.1 "security review" (depth 2, reviewer OFF)
                │   ├── planner queries RAG → source present; security patterns absent
                │   ├── planner emits ONE-STEP plan: "scan source for security patterns"
                │   └── executor (CyclicReAct):
                │         calls LLM with source + tools-RAG-injected SearchSource
                │         tool calls → results written to knowledge-RAG
                │         LLM final → return ok
                ├── B.2 performance review — parallel, same shape
                ├── B.3 clean core review — parallel
                └── B.4 maintainability review — parallel
                     (all four write findings to the shared knowledge-RAG)

coordinator → root finalizer
  reads original prompt + accumulated knowledge-RAG
  composes final answer as 'content' StreamChunks
  → consumer
```

During execution the consumer's SSE channel carries progress events:
`stepper-spawned (root)`, `stepper-spawned (read-source, parent=root)`, `mcp-call (GetProgFullCode)`, `mcp-result`, `tokens-used`, `stepper-done (read-source)`, `stepper-spawned (code-review)`, four `stepper-spawned` for the parallel children, interleaved `mcp-call`/`mcp-result`/`tokens-used` from concurrent siblings, `stepper-done` for each, then the root finalizer's `content` stream, ending with a terminal `tokens-used` aggregate.

## F. Error and signal contracts

| Signal | Origin | Handler | Effect |
|---|---|---|---|
| `ClarifySignal` | Executor before mutating tool call; root finalizer on insufficient; budget-extension prompt | Coordinator | Pauses, emits to consumer, awaits answer, resumes the Stepper with the answer fed back as a synthetic message |
| `NeedInfoSignal` | Existing 17.0 — Stepper.planner needs a reality fact | Coordinator | Routes to `IStateOracle` (17.0 surface preserved) |
| `InsufficientSignal` (new) | Root finalizer when knowledge-RAG is too sparse | Coordinator | Either returns to consumer or triggers root replan with `missing[]` |
| `IStepperResult.status: 'incomplete'` | Any Stepper exhausting its sub-budget | Parent Stepper | Parent decides — add a follow-up step or bubble up |
| `IStepperResult.status: 'budget-exhausted'` | Stepper hit hard cap | Parent Stepper | Bubbles to root; coordinator raises `ClarifySignal` (B.5.3) to consumer for budget-extension choice |

## G. Session persistence

### G.1 Stable session_id

Cookie identity continues to be the per-request authentication mechanism (17.0). Behind it, a `session_id` (UUID) is minted on first request and persists in a metadata store. Cookie → session_id mapping is one-to-many (a session can be resumed from a different cookie if the consumer authenticates).

### G.2 Metadata store

```sql
CREATE TABLE session_meta (
  session_id TEXT PRIMARY KEY,
  user_identity TEXT NOT NULL,          -- nullable in non-auth builds, becomes user_id downstream
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,                 -- idle | in-progress | drained
  prompt_count INT NOT NULL DEFAULT 0
);
```

Default backend: Postgres. The same `pg-vector` dependency suffices.

### G.3 Message history

Append-only JSONL per session at `logDir/sessions/<session_id>/messages.jsonl` (matches 17.0's session log directory layout). Each turn appends one record `{ts, role, content, …}`.

### G.4 API surface

- `GET /v1/sessions` → list `{ session_id, title, last_used_at, status }[]` for the authenticated identity.
- `POST /v1/sessions/<id>/resume` → claim ownership (sets cookie), reloads knowledge-RAG (already persistent) and message history; returns 200 with session metadata.
- `DELETE /v1/sessions/<id>` → drops metadata row, evicts vector entries keyed by session_id, deletes JSONL.

### G.5 Mid-plan resume after crash

v1 answer = RAG-replay resume (not transactional checkpointing):

- On startup, coordinator scans sessions with `status: in-progress`.
- For each, sets `status: idle`. No automatic replay.
- Next consumer prompt against that session sees the saturated knowledge-RAG; root replan naturally reuses the prior work.
- Full transactional plan-state checkpoint is deferred to 19.x.

## H. Testing strategy — provability claims

| # | Test | Assertion |
|---|---|---|
| H.1 | Mode A — single Stepper with stub `INeedResolver` | LLM emits "I lack tool X" → resolver returns `injectTools: [X]` → next LLM call has X in tool list → final answer produced. |
| H.2 | Mode B — three-level recursion, root + child + grandchild | Grandchild planner queries knowledge-RAG and reads the entry written by an earlier sibling, does NOT re-fetch. Cycle of identical task-recurrence is avoided by RAG hit. |
| H.3 | Mode C — 4 ortho parallel children with `maxParallelSteps: 2` | Observe at most 2 concurrent `stepper-spawned` events; queue drains as `stepper-done` arrives. |
| H.4 | Sufficiency mechanism — budget exhaustion | Stepper exceeds depth budget → INCOMPLETE bubbles to root → root finalizer raises `ClarifySignal('extend budget?')` → consumer `continue` → root replan from saturated RAG completes. |
| H.5 | Mutate tool annotation | Tool with `mutating: true` triggers `ClarifySignal` before MCP call; tool without it executes silently. |
| H.6 | Root finalizer insufficient path | Knowledge-RAG empty after run → finalizer returns `InsufficientSignal(missing: ['source code'])`; coordinator returns the signal to consumer. |
| H.7 | Streaming events | Progress events (`stepper-spawned`, `mcp-call`, `tokens-used`) emitted with correct `source` and `parent` for a 3-level tree; root finalizer text arrives as `content` chunks; no `node-start`/`node-end` legacy chunks emitted. |
| H.8 | Session persistence + resume | New session, prompt → answer; close; reopen; `POST /v1/sessions/<id>/resume`; second prompt sees prior knowledge-RAG entries via planner.query. |
| H.9 | Cycle prevention by RAG-first | Planner with task identical to its parent's task but knowledge-RAG already populated emits a leaf step (use-the-fact), not a re-fetch. |
| H.10 | maxParallelSteps locally enforced | Two-level tree with maxN=2 at each level: peak observed concurrency ≤ 4 (2×2), not bounded by a global semaphore. |

## I. Backward compatibility

- **17.0 `IFinalizer`** → becomes the root-finalizer component (unchanged interface; relocated outside the Stepper). `PassthroughFinalizer` / `LlmFinalizer` / `TemplateFinalizer` implementations continue to work as root-finalizer choices.
- **17.0 `IStateOracle`** → preserved verbatim; `NeedInfoSignal` round-trips still go through it.
- **17.0 `IPlanner` / `IReviewStrategy` / `IInterpreter` / `IErrorStrategy`** → preserved as interfaces. 18.0 introduces new `IStepperPlanner` / `IStepperInterpreter` / `IExecutor`; 17.0's `LlmDagPlanner` / `DagPlanInterpreter` / `LlmReviewStrategy` are shimmed into the new shape for the `cyclic-react` default and the `planned-react` planner role.
- **17.0 `DagCoordinatorHandler`** → deprecated. New `StepperCoordinatorHandler` replaces it. The yaml `coordinator.planner` shape is mapped to `coordinator.mode: planned-react` with the planner role unchanged.
- **17.0 StreamChunk variants `node-start` / `node-end` / `tool-call`** → REMOVED. Replaced by 18.0 progress events (`stepper-spawned`/`stepper-done`/`mcp-call`/`mcp-result`/`tokens-used`/`llm-call-start`/`llm-call-end`). **Breaking change for SSE clients.** `content` variant preserved.
- **17.0 per-role LLM map** → preserved; new role keys: `planner` / `reviewer` / `finalizer` / `executor` / `oracle` / `needResolver` / `main`.

## J. Out of scope

- **Mid-plan transactional checkpointing.** Failure recovery is RAG-replay only.
- **Cross-session user-scoped memory.** Auth-enabled downstream concern.
- **Semantic-similarity cycle detection.** B.6 layered prevention is sufficient.
- **Async reviewer** (review in parallel with execution).
- **Global cross-tree concurrency semaphore.** maxParallelSteps is local-only.
- **Append-to-plan / cancel-and-replan for mid-execution consumer input.** v1 queues the new prompt for the next logical iteration.
- **Replay-vs-RAG-only resume policy switch.** Always RAG-only in v1; replay deferred.
- **`mutating` tool field auto-detection.** Tool authors must explicitly opt in.

## K. Migration strategy

- 18.0 ships the new `StepperCoordinatorHandler` alongside the deprecated `DagCoordinatorHandler` for one minor release.
- Existing 17.0 yaml configs with `coordinator.planner` and `subagents:` are auto-mapped: planner role becomes the `planned-react` mode's root planner; subagents become Steppers registered for dispatch.
- 18.0 CHANGELOG flags the SSE event-shape change as breaking.
- 18.1: `DagCoordinatorHandler` emits a deprecation warning on construction.
- 19.0: `DagCoordinatorHandler` removed.

## L. Implementation footprint estimate

| Package | New files (approx) | Modified files | LOC est. |
|---|---|---|---|
| `@mcp-abap-adt/llm-agent` (contracts) | 6 (`stepper.ts`, `stepper-planner.ts`, `stepper-interpreter.ts`, `executor.ts`, `knowledge-rag.ts`, `need-resolver.ts`) | `streaming.ts`, `index.ts` barrels | ~400 |
| `@mcp-abap-adt/llm-agent-libs` | 8 (`stepper.ts`, `llm-stepper-planner.ts`, `stepper-interpreter.ts`, `cyclic-react-executor.ts`, `need-resolver.ts` × 2, `knowledge-rag.ts`, `root-finalizer.ts`) | `dag-coordinator.ts` (deprecation), `passthrough-finalizer.ts` / `llm-finalizer.ts` / `template-finalizer.ts` (root-finalizer reuse) | ~1500 |
| `@mcp-abap-adt/llm-agent-server` | 3 (`build-stepper-root.ts`, `stepper-coordinator-handler.ts`, `session-meta-store.ts`) | `smart-server.ts` (mode routing), `config.ts` (yaml parsing) | ~800 |
| Tests | ~25 new test files across packages | several existing dag-coordinator tests retained but marked legacy | ~1200 |

Total estimate ~4000 LOC, ~25 test files. Comparable in size to PR #163.
