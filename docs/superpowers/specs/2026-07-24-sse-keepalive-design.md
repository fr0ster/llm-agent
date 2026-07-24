# Transport-level SSE keep-alive during long tool execution — design

Issue: [#246](https://github.com/fr0ster/llm-agent/issues/246)

## Problem

Under every coordinator pipeline except the flat/plain tool-loop, the client-facing
SSE stream goes **silent** for the whole duration of a long tool-execution phase, so
an idle intermediary (CF gorouter, browser) closes the connection (~22s on a real
deployment: `No response`). The same tool call over the plain tool-loop streams
heartbeats fine.

### Root cause (verified in source)

The only heartbeat generator is the plain tool-loop batch executor
(`pipeline/handlers/tool-loop-core.ts:323-329`), which `yield`s
`{ ok:true, value:{ content:'', heartbeat:{ tool, elapsed } } }` while internal MCP
calls run. It reaches the wire ONLY when the generator that produced it is the one
whose chunks are pushed through `ctx.yield` — i.e. only the flat pipeline, which runs
tools inside the very generator that owns the client stream
(`tool-loop.ts:894-898`). The SSE surface reads it at
`smart-agent/http/chat-route-handler.ts:304`.

Every other pipeline executes tools **below** the `ctx.yield` boundary and surfaces
no keep-alive:

| Pipeline | Tool-exec mechanism | During a long tool call |
|----------|---------------------|-------------------------|
| flat / plain tool-loop | tool-loop directly | **OK** — `value.heartbeat` + content reach the wire |
| linear | `SelfDispatch` own ReAct loop / `SubAgentDispatch` buffered | **silent** |
| DAG | worker `ISubAgent.run()` via interpreter; `interpreterOnPartial` only logs (`dag-coordinator.ts:315-317`) | **silent** |
| controller | own `runStep` loop; `deps.callMcp(...)` bare `await`, no heartbeat | **silent** |
| stepper / deep-stepper | `CyclicReActExecutor` own loop; progress is `mcp-call`/`mcp-result`, never `content` | **silent** |
| cyclic | same stepper handler | **silent** |

Two structural sinks swallow the tool-loop heartbeat when a coordinator runs a
sub-agent: `SmartAgent.process()` (`agent.ts:554-597`) consumes a sub-agent's stream
but reads only `content`/`toolCalls`/`finishReason`/`usage` and drops
`value.heartbeat`; and the `OnPartial` progress channel
(`llm-agent/src/interfaces/streaming.ts`) has no `heartbeat` kind — only its
`kind:'content'` variant is ever forwarded to `ctx.yield`, and the coordinators that
own their tool loop (controller, stepper) emit no heartbeat at all.

## Scope

- **In scope:** a keep-alive that prevents SSE timeout during a long tool-execution
  phase under **any** pipeline. Plus documentation of the DAG coordinator's
  finalizer-is-sole-content-source contract (a distinct, second symptom in the
  issue).
- **Out of scope (tracked as a follow-up issue):** forwarding the DAG interpreter's
  content to the client live (token-by-token) with de-duplication against a
  re-emitting finalizer. The finalizer stays the sole content source; a
  notice-only custom finalizer must re-emit `interpreterOutput` (documented here).

## Approach — one transport-level idle keep-alive, wired into every SSE surface

Keep-alive is a **transport concern**, not a coordinator concern. Rather than wiring a
per-coordinator heartbeat into each of the five broken pipelines (and every future
one), a single reusable idle watchdog wired into the streaming surfaces fixes them all
at once and stays correct for pipelines added later.

There are **two** streaming SSE surfaces, both of which `agent.streamProcess(...)` and
both of which go silent under the broken pipelines — the design must cover BOTH:

- `/v1/chat/completions` (OpenAI shape) — `chat-route-handler.ts:262+` (`for await`
  over the raw agent stream).
- `/v1/messages` (Anthropic shape) — `adapter-route-handler.ts:66-77` (`for await`
  over `adapter.transformStream(agent.streamProcess(...))`).

The watchdog writes an SSE keep-alive comment whenever the client stream has been idle
longer than `heartbeatIntervalMs`; every real chunk/event resets it. It is
pipeline-agnostic — it does not know or care how any coordinator executes tools. The
flat pipeline is unaffected: its `value.heartbeat` chunks arrive every interval and
keep the watchdog reset, so it never fires there and flat behaviour is byte-for-byte
unchanged. SSE `:`-comments are valid on both the OpenAI and Anthropic streams and are
ignored by clients.

This is exactly the interim workaround the reporter applied (an independent SSE
keep-alive at the HTTP handler), moved into the library as a reusable component so no
consumer needs to hand-roll it.

The public `StreamChunk` union, the coordinators, and `SmartAgent.process()` are all
**unchanged**.

## Components

### 1. `createIdleHeartbeat` — reusable idle watchdog

New focused module `packages/llm-agent-server-libs/src/smart-agent/http/sse-heartbeat.ts`.

```ts
export interface IdleHeartbeat {
  /** Re-arm the idle timer. Call on every real chunk written to the client. */
  reset(): void;
  /** Cancel the timer permanently. Idempotent. Call on stream end / disconnect. */
  stop(): void;
}

export interface IdleHeartbeatOptions {
  /** Idle window in ms. Non-finite (NaN/±Infinity) or `<= 0` disables (no-op stub). */
  intervalMs: number;
  /** Invoked once each time the stream stays idle for `intervalMs`. */
  onBeat: () => void;
  /** Timer injection for deterministic tests. Default: global setTimeout/clearTimeout. */
  schedule?: (cb: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createIdleHeartbeat(opts: IdleHeartbeatOptions): IdleHeartbeat;
```

Behaviour: transport-agnostic (writes nothing itself — the caller's `onBeat` does).
After `intervalMs` with no `reset()`, it calls `onBeat()` and re-arms (so a long idle
period yields a beat every `intervalMs`). `reset()` cancels the pending timer and
re-arms. `stop()` cancels and makes further `reset()`/`stop()` no-ops. Timers are
injectable so tests drive it without real time.

**Interval validation (mandatory guard).** The interval originates from
`Number(get(yaml, 'agent', 'heartbeatIntervalMs'))` (`resolve-config-sections.ts:255`),
which does NOT validate — `heartbeatIntervalMs: abc` yields `NaN`, and a bare
`intervalMs <= 0` check does not catch `NaN` (`NaN <= 0` is `false`), while
`setTimeout(cb, NaN)` schedules at the minimum delay. Because the callback re-arms, a
non-finite interval would spin an unbounded write/CPU loop on every streaming request.
The helper therefore guards at its entry:

```ts
if (!Number.isFinite(intervalMs) || intervalMs <= 0) return NOOP_HEARTBEAT;
```

so `NaN`, `Infinity`, `-Infinity`, `0`, and negatives all collapse to a no-op stub
(keep-alive disabled), never a busy loop. (Config resolution MAY additionally reject
non-numeric values as defence-in-depth, but the helper guard is the authority — it
protects every caller regardless of source.)

### 2. A thin SSE binding, consumed by BOTH streaming handlers

To avoid duplicating the wiring across the two surfaces, add a small SSE-specific
binding in the same module:

```ts
/** Wires createIdleHeartbeat to an SSE response: onBeat writes a keep-alive
 *  comment, and res 'close' stops the timer. Returns { reset, stop }. */
export function attachSseKeepAlive(res: ServerResponse, intervalMs: number): IdleHeartbeat;
```

It creates `createIdleHeartbeat({ intervalMs, onBeat: () => res.write(': keep-alive\n\n') })`,
registers `res.on('close', () => hb.stop())` (client disconnect — never write to a dead
socket), and returns the handle. Both handlers use it identically:

- **`chat-route-handler` `if (body.stream)` branch** (`chat-route-handler.ts:262+`):
  read the interval as `cfg.agent?.heartbeatIntervalMs ?? 5000`; `const hb =
  attachSseKeepAlive(res, intervalMs)`; `hb.reset()` before the loop and at the top of
  each `for await` iteration; `hb.stop()` in a `finally`. The existing
  `value.heartbeat` handling (`:304-308`) stays — on the flat path it writes
  `: heartbeat tool=… elapsed=…ms` and, being a chunk, also resets the watchdog, so the
  flat path keeps its richer per-tool comment and the watchdog never fires there.
- **`adapter-route-handler` streaming loop** (`adapter-route-handler.ts:66-77`): same
  pattern around the `for await (event of adapter.transformStream(...))` loop —
  `hb.reset()` per event, `hb.stop()` in `finally`. `handleAdapterRequest` currently
  takes `(req, res, agent, adapter, session)` and has NO `cfg`; add a
  `heartbeatIntervalMs: number` parameter, resolved by the caller in `smart-server.ts`
  as `cfg.agent?.heartbeatIntervalMs ?? 5000` (the same value chat-route uses) and
  passed at the call site.

**Config typing.** `resolveAgentSection` (`resolve-config-sections.ts:253-259`) already
spreads `heartbeatIntervalMs` into `cfg.agent` at runtime, but the
`SmartServerAgentConfig` interface (`smart-server.ts:188`) does not declare it. Add
`heartbeatIntervalMs?: number` to that interface so both reads are type-safe — no new
parsing, just typing a field that is already populated.

The non-streaming (JSON) branches of both handlers are untouched — there is no
connection to keep alive.

## Data flow

Identical shape at both surfaces (`attachSseKeepAlive` wires `onBeat` + `res 'close'`):

```
streaming branch (chat-route OR adapter-route):
  hb = attachSseKeepAlive(res, intervalMs)     // onBeat=": keep-alive"; res 'close' → stop
  hb.reset()                                   // arm
  try {
    for await (const chunk/event of stream) {
      hb.reset()                               // real activity re-arms
      … existing writes (content / heartbeat / tool_calls / [DONE] | adapter event lines) …
    }
  } finally { hb.stop() }

long MCP call under linear/DAG/controller/stepper/cyclic (either endpoint):
  stream idle > interval → onBeat → res.write(": keep-alive\n\n") → connection stays open

flat pipeline:
  value.heartbeat chunk every ~5s → written as ": heartbeat …" AND hb.reset()
  → watchdog never fires → behaviour unchanged

non-finite / <= 0 interval:
  attachSseKeepAlive → createIdleHeartbeat guard → NOOP_HEARTBEAT → never schedules a timer
```

## Error handling / edge cases

- **Client disconnect:** `res.on('close')` → `hb.stop()`; the `finally` also stops it.
  No write occurs after the socket closes.
- **Stream error / normal end:** `finally { hb.stop() }` guarantees the timer is
  cancelled on every exit path.
- **Non-streaming request:** watchdog is created only inside the streaming branch of
  each handler.
- **`heartbeatIntervalMs` unset / invalid:** unset → default 5000; `<= 0` → disabled
  no-op stub (a deployment can turn keep-alive off); **non-finite (`NaN`/`±Infinity`,
  e.g. from `heartbeatIntervalMs: abc` in yaml) → no-op stub, never a zero-delay busy
  loop** (see the mandatory guard in Component 1).
- **Backpressure** (`res.write` returns false): keep-alive comments are a few bytes;
  no flow control needed.
- **Concurrency:** Node is single-threaded; the timer callback's `res.write` runs only
  while the `for await` is parked on the next chunk, so it never interleaves with a
  chunk write.
- **No double keep-alive on the flat path:** its `value.heartbeat` chunks keep the
  watchdog reset, so only the existing `: heartbeat …` comment is written.

## Testing

- **Unit `sse-heartbeat.test.ts`** (injected manual scheduler — deterministic, no real
  time): a beat fires after one idle `intervalMs`; a beat repeats every `intervalMs`
  while idle; `reset()` before the window elapses cancels the pending beat and
  re-arms (no beat when activity < interval); `stop()` prevents any further beat and
  is idempotent. **Invalid-interval cases (must never schedule a timer / never
  beat):** `NaN`, `Infinity`, `-Infinity`, `0`, and a negative value each return the
  no-op stub. `attachSseKeepAlive` on a fake `res` writes `: keep-alive` on a beat and
  stops on `res` `'close'`.
- **Integration — BOTH endpoints** (short real interval e.g. 20ms): for
  `/v1/chat/completions` (`chat-route-handler`) AND `/v1/messages`
  (`adapter-route-handler`): a fake agent stream idle > interval then a chunk/event →
  the SSE output contains a `: keep-alive` line written **before** the first real
  `data:` line; on `res` close mid-idle, no write after close. Plus the flat case
  (chat-route): a stream that yields `value.heartbeat` chunks → output contains
  `: heartbeat tool=…` and **no** `: keep-alive` (watchdog stayed reset).
- **Regression:** existing `chat-route-handler` and `adapter-route-handler` streaming
  tests stay green (content, tool_calls, `[DONE]`, adapter event lines, usage paths
  unchanged).

## Documentation (whole set)

- **CHANGELOG** (Unreleased → folds into v20.9.0): SSE keep-alive during long tool
  execution across all coordinator pipelines (#246); note the DAG
  finalizer-sole-content-source contract.
- **TROUBLESHOOTING:** symptom "SSE connection closes / `No response` after ~22s
  during a long MCP tool call under the linear / DAG / controller / stepper / cyclic
  pipelines (the flat pipeline was unaffected)" → cause (tool execution runs below the
  `ctx.yield` boundary; the tool-loop heartbeat is swallowed) → fix (transport-level
  keep-alive at the SSE surface; tune or disable via `agent.heartbeatIntervalMs`).
- **ARCHITECTURE / streaming:** both SSE surfaces (`/v1/chat/completions` and
  `/v1/messages`) emit an idle keep-alive comment every `heartbeatIntervalMs`,
  independent of pipeline; the flat pipeline additionally emits per-tool
  `: heartbeat …` comments.
- **DAG finalizer contract (the second symptom):** under `withDagCoordinator` the
  finalizer is the sole client-facing **content** source; a notice-only custom
  finalizer must re-emit `interpreterOutput` as content, or the response is empty in
  both streaming and non-streaming modes. Live token-by-token forwarding of interpreter
  content is a separate follow-up (out of scope here).

## Delivery

One PR (folds into the held v20.9.0):

- `smart-agent/http/sse-heartbeat.ts` — `createIdleHeartbeat` (with the non-finite/≤0
  guard) + `attachSseKeepAlive` + types.
- `smart-agent/smart-server.ts` — declare `heartbeatIntervalMs?: number` on
  `SmartServerAgentConfig` (already populated by `resolveAgentSection`); pass the
  resolved interval to `handleAdapterRequest` at its call site.
- `smart-agent/http/chat-route-handler.ts` — consume `attachSseKeepAlive` in the
  streaming branch; `hb.reset()` per chunk; `finally` stop.
- `smart-agent/http/adapter-route-handler.ts` — add a `heartbeatIntervalMs: number`
  parameter; consume `attachSseKeepAlive` around the `transformStream` loop;
  `hb.reset()` per event; `finally` stop.
- `smart-agent/http/__tests__/sse-heartbeat.test.ts` + streaming integration tests for
  BOTH `/v1/chat/completions` and `/v1/messages`.
- CHANGELOG / TROUBLESHOOTING / ARCHITECTURE doc updates.

Additive; no public type or coordinator change. A follow-up issue is filed for live
DAG interpreter-content forwarding.
