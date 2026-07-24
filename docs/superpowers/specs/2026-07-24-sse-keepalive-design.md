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
- **In scope (config-semantics coherence):** a single `heartbeatIntervalMs`
  normalization applied to BOTH the new transport watchdog AND the existing flat
  tool-loop heartbeat. The flat tool-loop (`tool-loop-core.ts:315`,
  `setTimeout(…, heartbeatMs)`) currently consumes the same key with no validation, so
  `0` / negative / `NaN` busy-loops the flat pipeline **today**. Fixing only the new
  watchdog would leave that pre-existing footgun and make the "invalid disables
  keep-alive" claim false. One normalizer, both call sites.
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
pipeline-agnostic — it does not know or care how any coordinator executes tools. SSE
`:`-comments are valid on both the OpenAI and Anthropic streams and are ignored by
clients, so an extra one is always harmless.

**Flat-path contract (explicit — the two timers are independent).** The watchdog and
the tool-loop's own `value.heartbeat` share the `heartbeatIntervalMs` value but NOT a
clock: the watchdog arms on the last progress chunk, whereas the tool-loop arms its
timer only later, once the generator reaches `executeToolBatchWithHeartbeat`. So the
watchdog deadline typically elapses slightly BEFORE the first tool heartbeat, and on
the flat path the client MAY see a `: keep-alive` shortly before the richer
`: heartbeat tool=… elapsed=…ms` (which then resets the watchdog). This is accepted by
design: both are transparent comments, and correctness never depends on the two timers'
relative order. We therefore do NOT claim "flat is byte-for-byte unchanged" and do NOT
assert the absence of `: keep-alive` on the flat path — only that the richer
`: heartbeat` is still present. (Rejected alternatives: a `2 × interval` watchdog grace
would let a higher configured interval, e.g. 15 s → 30 s, exceed the ~22 s intermediary
timeout it exists to beat; centralising both timers is out-of-scope over-engineering.)

This is exactly the interim workaround the reporter applied (an independent SSE
keep-alive at the HTTP handler), moved into the library as a reusable component so no
consumer needs to hand-roll it.

The public `StreamChunk` union, the coordinators, and `SmartAgent.process()` are all
**unchanged**.

## Components

### 0. `normalizeHeartbeatMs` — the single config-semantics authority

New tiny exported helper in `@mcp-abap-adt/llm-agent-libs` (so BOTH the flat tool-loop,
which lives there, and the server's transport watchdog, which depends on it, import the
same rule). It is the ONE definition of what a raw `heartbeatIntervalMs` means:

```ts
/** `null` = keep-alive disabled (no timer); otherwise a finite positive interval. */
export function normalizeHeartbeatMs(raw: number | undefined): number | null;
```

No configurable default parameter: a caller-supplied `defaultMs` could itself be
`0`/`NaN`/`Infinity` and would be returned unchecked, breaking the "finite positive or
null" return contract. The default is a fixed internal `5000`; no caller needs another.

Rule (one place, applied at every call site) — the return is ALWAYS a finite positive
number or `null`, nothing else:

- `undefined` (not configured) → `5000` (the fixed default).
- finite and `> 0` → the value.
- anything else — `<= 0`, `NaN`, `Infinity`, `-Infinity` → `null` (disabled).

A **present but invalid** value disables keep-alive rather than guessing a default, and
never yields a near-zero timer. `resolve-config-sections.ts:255` (`Number(...)`) should
additionally log a warning when a configured value normalizes to `null` (defence in
depth + observability), but the normalizer is the safety authority — it protects every
caller regardless of source.

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
  /** Raw configured interval (may be undefined). Normalized internally via
   *  normalizeHeartbeatMs: undefined → 5000; non-finite / `<= 0` → disabled (no-op). */
  intervalMs: number | undefined;
  /** Invoked once each time the stream stays idle for the normalized interval. */
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
`createIdleHeartbeat` therefore normalizes at its entry via the shared authority
(Component 0):

```ts
const ms = normalizeHeartbeatMs(intervalMs);
if (ms === null) return NOOP_HEARTBEAT;   // <= 0 / NaN / ±Infinity → disabled
// … use `ms` (finite positive) as the timer interval …
```

so `NaN`, `Infinity`, `-Infinity`, `0`, and negatives all collapse to a no-op stub
(keep-alive disabled), never a busy loop — the SAME rule the flat tool-loop now applies
(Component 3).

### 2. A thin SSE binding, consumed by BOTH streaming handlers

To avoid duplicating the wiring across the two surfaces, add a small SSE-specific
binding in the same module:

```ts
/** Wires createIdleHeartbeat to an SSE response: onBeat writes a keep-alive
 *  comment, and res 'close' stops the timer. `intervalMs` is the RAW configured
 *  value (may be undefined) — normalization happens inside. Returns { reset, stop }. */
export function attachSseKeepAlive(
  res: ServerResponse,
  intervalMs: number | undefined,
): IdleHeartbeat;
```

It creates `createIdleHeartbeat({ intervalMs, onBeat: () => res.write(': keep-alive\n\n') })`,
registers `res.on('close', () => hb.stop())` (client disconnect — never write to a dead
socket), and returns the handle. Both handlers use it identically:

Both handlers pass the RAW `cfg.agent?.heartbeatIntervalMs` (possibly `undefined`);
`attachSseKeepAlive` → `createIdleHeartbeat` → `normalizeHeartbeatMs` owns the default
and the disabled case, so no call site repeats `?? 5000` or any validation.

- **`chat-route-handler` `if (body.stream)` branch** (`chat-route-handler.ts:262+`):
  `const hb = attachSseKeepAlive(res, cfg.agent?.heartbeatIntervalMs)`; `hb.reset()`
  before the loop and at the top of each `for await` iteration; `hb.stop()` in a
  `finally`. The existing `value.heartbeat` handling (`:304-308`) stays — on the flat
  path it writes `: heartbeat tool=… elapsed=…ms` and, being a chunk, resets the
  watchdog, so the flat path keeps its richer per-tool comment (possibly preceded by a
  `: keep-alive` per the flat-path contract above).
- **`adapter-route-handler` streaming loop** (`adapter-route-handler.ts:66-77`): same
  pattern around the `for await (event of adapter.transformStream(...))` loop —
  `hb.reset()` per event, `hb.stop()` in `finally`. `handleAdapterRequest` currently
  takes `(req, res, agent, adapter, session)` and has NO `cfg`; add a
  `heartbeatIntervalMs: number | undefined` parameter, passed by the caller in
  `smart-server.ts` as `cfg.agent?.heartbeatIntervalMs` (raw, unnormalized).

**Config typing.** `resolveAgentSection` (`resolve-config-sections.ts:253-259`) already
spreads `heartbeatIntervalMs` into `cfg.agent` at runtime, but the
`SmartServerAgentConfig` interface (`smart-server.ts:188`) does not declare it. Add
`heartbeatIntervalMs?: number` to that interface so both reads are type-safe — no new
parsing, just typing a field that is already populated.

### 3. BOTH flat tool-loop callers apply the SAME normalizer (fixes the pre-existing busy loop)

`executeToolBatchWithHeartbeat` (`tool-loop-core.ts:311-332`) races `allDone` against
`setTimeout(…, heartbeatMs)` in a `while` loop — so `0` / negative / `NaN` makes the
tick win immediately and busy-loops heartbeat yields until the batch settles. It has
**two** production callers, both of which resolve `heartbeatMs` with no validation and
BOTH must normalize:

- **Pipeline `ToolLoopHandler`** — `tool-loop.ts:119-122` (`config.heartbeatIntervalMs
  ?? ctx.config.heartbeatIntervalMs ?? 5000`), call at `tool-loop.ts:840`.
- **Direct `SmartAgent.streamProcess`** — `agent.ts:1346`
  (`this.config.heartbeatIntervalMs ?? 5000`), call at `agent.ts:1360`. This is the
  plain SmartAgent flat tool-loop named in the root cause.

The change:

- `tool-loop.ts`: `const heartbeatMs = normalizeHeartbeatMs(config.heartbeatIntervalMs
  ?? ctx.config.heartbeatIntervalMs)` → `number | null`.
- `agent.ts:1346`: `const heartbeatMs = normalizeHeartbeatMs(this.config.heartbeatIntervalMs)`
  → `number | null` (drop the `?? 5000`; the normalizer owns the default).
- `tool-loop-core.ts`: the batch executor's `heartbeatMs` param becomes
  `number | null`. When `null` (disabled), it awaits **only** `allDone` — no timer, no
  tick branch, no heartbeat yields. When a finite positive number, the existing race is
  unchanged.

**Note — the compiler will NOT catch a missed caller.** `number` is assignable to
`number | null`, so a call site still passing a bare `?? 5000` compiles clean and keeps
the bug. Both call sites (`tool-loop.ts`, `agent.ts`) must be updated explicitly; the
regression tests below exercise each production caller so a missed one fails a test, not
just review.

This removes the latent busy loop AND makes `<= 0` a real "disable heartbeats" switch on
BOTH flat paths, matching the transport watchdog.

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

flat pipeline (two independent timers, same interval):
  watchdog armed on last chunk (t) → may write ": keep-alive" at t+interval,
  then tool-loop ": heartbeat tool=…" arrives (t+ε+interval) and resets the watchdog
  → both are transparent comments; order is not relied upon

non-finite / <= 0 interval (BOTH paths, one normalizer):
  transport: attachSseKeepAlive → createIdleHeartbeat → normalizeHeartbeatMs → null → NOOP
  flat:      tool-loop → normalizeHeartbeatMs → null → executor awaits allDone, no timer
  → neither path ever schedules a near-zero timer
```

## Error handling / edge cases

- **Client disconnect:** `res.on('close')` → `hb.stop()`; the `finally` also stops it.
  No write occurs after the socket closes.
- **Stream error / normal end:** `finally { hb.stop() }` guarantees the timer is
  cancelled on every exit path.
- **Non-streaming request:** watchdog is created only inside the streaming branch of
  each handler.
- **`heartbeatIntervalMs` unset / invalid (BOTH paths, via `normalizeHeartbeatMs`):**
  unset → default 5000; `<= 0` → disabled (a deployment can turn keep-alive off);
  non-finite (`NaN`/`±Infinity`, e.g. from `heartbeatIntervalMs: abc` in yaml) →
  disabled — never a zero-delay busy loop. This holds identically for the transport
  watchdog **and** the flat tool-loop (Component 3), so the pre-existing flat busy loop
  on `0`/`NaN` is fixed too.
- **Backpressure** (`res.write` returns false): keep-alive comments are a few bytes;
  no flow control needed.
- **Concurrency:** Node is single-threaded; the timer callback's `res.write` runs only
  while the `for await` is parked on the next chunk, so it never interleaves with a
  chunk write.
- **Flat-path redundant comment is accepted:** because the watchdog and the tool-loop
  heartbeat run on independent timers (same interval, different start), the flat path
  MAY emit a `: keep-alive` just before a `: heartbeat …`. Both are transparent SSE
  comments; the client ignores them. The design does not rely on their order and does
  not promise "flat unchanged" (see the flat-path contract in Approach).

## Testing

- **Unit `normalize-heartbeat-ms.test.ts`** (`llm-agent-libs`): `undefined` → 5000;
  finite positive → itself; `0`, negative, `NaN`, `Infinity`, `-Infinity` → `null`
  (disabled). This is the single-authority test the two consumers rely on.
- **Unit `sse-heartbeat.test.ts`** (injected manual scheduler — deterministic, no real
  time): a beat fires after one idle `intervalMs`; a beat repeats every `intervalMs`
  while idle; `reset()` before the window elapses cancels the pending beat and
  re-arms (no beat when activity < interval); `stop()` prevents any further beat and
  is idempotent. **Invalid-interval cases (must never schedule a timer / never
  beat):** `NaN`, `Infinity`, `-Infinity`, `0`, and a negative value each return the
  no-op stub. `attachSseKeepAlive` on a fake `res` writes `: keep-alive` on a beat and
  stops on `res` `'close'`.
- **Regression `tool-loop-core` heartbeat (`llm-agent-libs`):** with the batch
  executor given a disabled interval (`null`, from normalizing `0` / negative / `NaN` /
  `±Infinity`), a batch whose tools resolve after a delay **completes**, yields **no**
  heartbeat chunk, and schedules **no** timer (no busy loop); with a finite positive
  interval it still yields `value.heartbeat` while a tool is pending (unchanged).
- **Both production callers normalize (matrix):** exercise the disabled interval via
  EACH caller so a missed call site fails a test — (a) the pipeline `ToolLoopHandler`
  (`tool-loop.ts`) and (b) the direct `SmartAgent.streamProcess` (`agent.ts`) path.
  With `heartbeatIntervalMs: 0` (or `NaN`) each runs a slow-tool batch to completion
  with no heartbeat chunk and no busy loop.
- **Integration — BOTH endpoints** (short real interval e.g. 20ms): for
  `/v1/chat/completions` (`chat-route-handler`) AND `/v1/messages`
  (`adapter-route-handler`): a fake agent stream idle > interval then a chunk/event →
  the SSE output contains a `: keep-alive` line written **before** the first real
  `data:` line; on `res` close mid-idle, no write after close. Plus the flat case
  (chat-route): a stream that yields `value.heartbeat` chunks → output contains
  `: heartbeat tool=…`. This test asserts the rich heartbeat is **present**; it does
  NOT assert the absence of `: keep-alive` (the two timers are independent — asserting
  absence would be flaky, per the flat-path contract).
- **Regression:** existing `chat-route-handler` and `adapter-route-handler` streaming
  tests stay green (content, tool_calls, `[DONE]`, adapter event lines, usage paths
  unchanged).

## Documentation (whole set)

- **CHANGELOG** (Unreleased → folds into v20.9.0): SSE keep-alive during long tool
  execution across all coordinator pipelines (#246); a single `heartbeatIntervalMs`
  normalization (`<= 0`/invalid disables, no busy loop) applied to both the transport
  keep-alive and the flat tool-loop; note the DAG finalizer-sole-content-source
  contract.
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

**`@mcp-abap-adt/llm-agent-libs`:**
- `normalizeHeartbeatMs` — the single config-semantics helper (+ unit test).
- `pipeline/handlers/tool-loop-core.ts` — batch executor `heartbeatMs` param becomes
  `number | null`; when `null`, await only `allDone` (no timer) (+ regression test).
- `pipeline/handlers/tool-loop.ts` — caller #1 (pipeline `ToolLoopHandler`): normalize
  via `normalizeHeartbeatMs`; pass `number | null`.
- `agent.ts` (~1346) — caller #2 (direct `SmartAgent.streamProcess`): normalize via
  `normalizeHeartbeatMs`, dropping `?? 5000` (+ a streamProcess disabled-interval test).

**`@mcp-abap-adt/llm-agent-server-libs`:**
- `smart-agent/http/sse-heartbeat.ts` — `createIdleHeartbeat` (normalizes via
  `normalizeHeartbeatMs`) + `attachSseKeepAlive` + types.
- `smart-agent/smart-server.ts` — declare `heartbeatIntervalMs?: number` on
  `SmartServerAgentConfig` (already populated by `resolveAgentSection`); pass the raw
  `cfg.agent?.heartbeatIntervalMs` to `handleAdapterRequest` at its call site.
- `smart-agent/http/chat-route-handler.ts` — consume `attachSseKeepAlive` in the
  streaming branch; `hb.reset()` per chunk; `finally` stop.
- `smart-agent/http/adapter-route-handler.ts` — add a `heartbeatIntervalMs: number |
  undefined` parameter; consume `attachSseKeepAlive` around the `transformStream` loop;
  `hb.reset()` per event; `finally` stop.
- `smart-agent/http/__tests__/sse-heartbeat.test.ts` + streaming integration tests for
  BOTH `/v1/chat/completions` and `/v1/messages`.
- `resolve-config-sections.ts` — optionally warn when a configured `heartbeatIntervalMs`
  normalizes to disabled (observability; non-blocking).

**Docs:** CHANGELOG / TROUBLESHOOTING / ARCHITECTURE updates.

Additive; no public type or coordinator change (the flat tool-loop internal param
widening to `number | null` is internal). A follow-up issue is filed for live DAG
interpreter-content forwarding.
