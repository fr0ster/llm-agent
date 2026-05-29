# DAG Streaming Coordinator — Design Spec

> Target release: **17.0.0** (folded into PR #163 — 17.0.0 ships incomplete without end-to-end streaming through the DAG coordinator path).
> Scope: token streaming through `DagCoordinatorHandler` → `IInterpreter` → `ISubAgent` worker → client SSE.

---

## A. Problem

Today `/v1/chat/completions?stream=true` against a DAG-coordinator server is silent until the entire plan finishes. The worker subagent's `streamChat` does stream internally (the worker pipeline's `tool-loop` consumes an `AsyncIterable<LLMResponse>` from the LLM), but the deltas never leave the worker process boundary:

```
worker.ILlm.streamChat  ✅ streams deltas
  → worker pipeline tool-loop  ✅ consumes the stream
    → ISubAgent.run()  ❌ collapses to final { output, usage }
      → IInterpreter.interpret()  ❌ awaits each node, returns final InterpretResult
        → DagCoordinatorHandler.execute()  ❌ yields once after finalizer
          → /v1/chat/completions SSE  ❌ no `data:` lines until finish
```

For flat (single-LLM) configs streaming works because the SSE-wrapper at the HTTP layer pipes the model's `streamChat` deltas directly to `ctx.yield`. For DAG we lose that path — the user sees nothing for the full duration of a multi-node analysis.

This is a UX regression specific to DAG and a real production concern once 17.0.0 lands: live ABAP analyses with `claude-4.5-haiku` workers take 30–90 s of total silence before the answer materialises in one chunk.

## B. Goal

Forward worker-side token deltas through the interpreter + coordinator boundary so the client sees incremental content immediately, with **no breaking changes** to existing `ISubAgent`/`IInterpreter`/`IFinalizer` consumers.

## C. Architecture — push model with optional `onPartial`

Add an **optional** `onPartial` callback to the input shape of every layer along the path. Each layer wires the callback it received downward; if absent, behaviour is unchanged. This keeps the public Promise-based contract intact (no `AsyncIterable<…>` signatures) and makes adoption strictly additive.

```ts
type StreamChunk =
  | { kind: 'content';   nodeId?: string; delta: string }
  | { kind: 'tool-call'; nodeId?: string; name: string; args?: unknown }
  | { kind: 'node-start';  nodeId: string; goal: string }
  | { kind: 'node-end';    nodeId: string; ok: boolean };

type OnPartial = (chunk: StreamChunk) => void;
```

The contract is fire-and-forget: callbacks never throw back into the caller. `nodeId` is supplied by the interpreter when forwarding (workers don't know which DAG node they are).

### Layers

| Layer | Field added | Behaviour when absent | Behaviour when present |
|---|---|---|---|
| `ISubAgentInput` | `onPartial?: OnPartial` | Worker pipeline does not emit (today's behaviour). | Worker tool-loop stage emits `{ kind:'content', delta }` for each LLM token delta and `{ kind:'tool-call', name, args }` for each tool invocation. |
| `InterpretContext` | `onPartial?: OnPartial` | Interpreter does not annotate or forward. | Interpreter wraps `worker.run({ ..., onPartial: c => onPartial({ ...c, nodeId }) })` and emits `node-start` / `node-end` around each invocation. |
| `FinalizerInput` | `onPartial?: OnPartial` | `LlmFinalizer` calls `llm.chat()` (current). `PassthroughFinalizer`/`TemplateFinalizer` ignore. | `LlmFinalizer` switches to `llm.streamChat()` and emits `{ kind:'content' }` per delta; others still ignore. |
| `DagCoordinatorHandler.execute` | (no signature change) | If `ctx.yield` is the SSE delta sink, the handler wires `onPartial = chunk => chunk.kind === 'content' && ctx.yield({ ok:true, value:{ content: chunk.delta } })` into both `interpret(...)` and `finalizer.finalize(...)`. | Non-content chunks land in trace/log only. |

### Filtering rule

The coordinator yields only `kind:'content'` to the public SSE channel by default. `node-start`/`node-end`/`tool-call` go to the session logger as structured events (already supported by `SessionRequestLogger.logStep`) so observability isn't lost. A future opt-in (`stream_events: ['content','tool-call']` request parameter) can widen this; out of scope here.

## D. Routing details

1. **Worker tool-loop emission point.** The tool-loop handler already iterates over `streamChat`. Add `for (const chunk of stream) { if (chunk.value?.content) input.onPartial?.({ kind:'content', delta: chunk.value.content }); ... }` immediately before accumulating the assistant message. Tool-call events emit when `chunk.toolCalls` is populated.

2. **Interpreter wrap.** In `DagPlanInterpreter.run(node, ...)`, the call site that prepares the worker input gets:
   ```ts
   const onPartial: OnPartial | undefined = ctx.onPartial
     ? c => ctx.onPartial!({ ...c, nodeId: c.nodeId ?? node.id })
     : undefined;
   ctx.onPartial?.({ kind: 'node-start', nodeId: node.id, goal: node.goal });
   const res = await worker.run({ task, sessionId, trace, sessionLogger, onPartial });
   ctx.onPartial?.({ kind: 'node-end', nodeId: node.id, ok: true });
   ```

3. **Coordinator wiring.** `DagCoordinatorHandler.execute(ctx, ...)` builds one `onPartial` that maps content-chunks to `ctx.yield`. The same callback is threaded into `interpret(...)` and into the `finalizer.finalize(...)` call. Final yield with `finishReason:'stop'` + session-usage stays exactly as today — the partial deltas precede it.

4. **LlmFinalizer streaming.** Switch from `llm.chat` to `llm.streamChat`. Accumulate locally (so the returned `FinalizerResult.output` is intact for the logger / executedPlan trail), but emit each delta through `input.onPartial`. This means the SSE channel sees finalizer deltas immediately after the last worker `node-end`. Passthrough/Template finalizers continue to call `onPartial({ kind:'content', delta: interpreterOutput })` ONCE at the end (single shot — preserves today's behaviour byte-for-byte for those modes).

## E. Provability tests

| # | Test | Assertion |
|---|---|---|
| E.1 | Worker with `onPartial` set: streamChat-fed pipeline | Callback fires ≥ 1 with `kind:'content'`; final `run()` resolves with full `output` equal to sum of deltas. |
| E.2 | Worker without `onPartial` | No callback invocations; final result unchanged. |
| E.3 | Interpreter forwards `nodeId` annotation | Stub worker emits `delta:'X'` from inside its `run`; controller's `onPartial` sees `{ nodeId: 'a', delta: 'X' }`. |
| E.4 | Interpreter emits `node-start` + `node-end` around each node | Order: start(a) → content(a)* → end(a) → start(b) → content(b)* → end(b). |
| E.5 | `DagCoordinatorHandler` yields content-only to `ctx.yield` | Spy `ctx.yield` collects `value.content` strings; equals concatenation of every worker delta. |
| E.6 | `DagCoordinatorHandler` final stop-yield still includes usage | Usage block present after all content yields; identical to today's value. |
| E.7 | `LlmFinalizer` with `onPartial` set | Emits ≥ 1 content chunk during synthesis; returned `output` equals concatenated deltas. |
| E.8 | `PassthroughFinalizer` with `onPartial` set | Emits exactly ONE content chunk equal to `interpreterOutput`. |
| E.9 | SSE integration test (live HTTP) | `data:` lines arrive with non-empty content BEFORE the final `[DONE]`; first non-empty `data:` arrives within ≤ 2 s of the worker's first internal delta. |

## F. Logger integration

Every non-`content` chunk is forwarded to the session logger as `logStep('dag_stream', chunk)`. This gives the existing per-trace JSON log (under `logDir/sessions/<sid>/req_<...>/`) a full event timeline without changing `byComponent` token math — `onPartial` carries no usage, only deltas. Token accounting stays exactly where it is: each layer's `streamChat` stamps usage on its terminal chunk; `SessionRequestLogger` rolls it up under the role's component name (`tool-loop`, `finalizer`, …).

## G. Backward compatibility

Every new field is optional. Callers that omit `onPartial` see identical behaviour and identical SSE output (one yield after finalize). No existing test should change semantics. No public type narrows. Existing examples (`01-all-sonnet.yaml`, `02-hybrid-sonnet-haiku.yaml`, `03-full-roles.yaml`) get streaming for free without yaml changes.

## H. Out of scope

- Reviewer streaming (reviewer answers are bounded JSON; latency cost is negligible).
- Oracle streaming (`IStateOracle.query` returns one sentence; one-shot is fine).
- Bidirectional protocol (client → server cancel mid-stream beyond `AbortSignal`).
- Multiplex stream-events selection (`stream_events: [...]` request param) — future opt-in.
- Token-by-token deltas across the reviewer-replan loop boundary (replan is rare and bounded).

## I. Acceptance

Running `docs/examples/dag-coordinator/stream-test.sh 4016 hybrid '…'` against a 17.1.0 build of `02-hybrid-sonnet-haiku.yaml` prints content deltas as the worker generates them. `/v1/usage.byComponent` totals match the previous (one-shot) build for the same prompt within ±1% (no double-counting introduced).
