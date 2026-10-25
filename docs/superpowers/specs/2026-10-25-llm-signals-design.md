# Signals: contracts first, replaceable implementation

Date: 2026-10-25. Status: draft for review.

## Purpose

Library components report facts about their own state, for example that a dialogue turn has settled or that a task changed state. Consumers build their own exchange schemes on those facts: a chat server that holds a response open, an MCP subagent that reports progress, a CLI spinner, a metrics bridge. The library stays agnostic to these schemes.

The design follows three rules:

1. **Contracts first.** Producers and consumers depend only on interfaces in `@mcp-abap-adt/llm-agent`, never on an implementation.
2. **Replaceable.** A consumer can replace the whole signal implementation, or a part of it (wrap, fan out, filter), without changing any producer.
3. **No consumer-specific signals.** A signal states a fact of the producing component in that component's own terms. Nothing names a transport, a protocol, a UI or a particular consumer.

## Contracts (`@mcp-abap-adt/llm-agent`, `src/interfaces/signals.ts`)

```ts
/** A catalog is any object type mapping signal names to payload types; interfaces work, no index signature needed. */
export type SignalName<C extends object> = Extract<keyof C, string>;

export interface Signal<C extends object, K extends SignalName<C>> {
  name: K;
  payload: Readonly<C[K]>;
  /** Producer instance, e.g. the dialogue session id. */
  source: string;
  /** Entity within the source for retention, e.g. a task id; '' when the signal is about the source itself. */
  key: string;
  /** Emission time, ms since epoch. */
  at: number;
}
/** Any signal of the catalog, as a discriminated union on `name` (narrowing `name` narrows `payload`). */
export type AnySignal<C extends object> = { [K in SignalName<C>]: Signal<C, K> }[SignalName<C>];

export type Unsubscribe = () => void;

/** Producer side: the only thing a producer depends on. */
export interface ISignalEmitter<C extends object> {
  emit<K extends SignalName<C>>(name: K, payload: C[K], source: string, key?: string): void;
  /** The producer instance has ended. */
  retire(source: string): void;
}

/** Consumer side. */
export interface ISignalSubscriber<C extends object> {
  on<K extends SignalName<C>>(name: K, handler: (s: Signal<C, K>) => void | Promise<void>, filter?: { source?: string }): Unsubscribe;
  /** Wildcard handlers must ignore names they do not know: new names are added within a major. */
  onAny(handler: (s: AnySignal<C>) => void | Promise<void>, filter?: { source?: string }): Unsubscribe;
  /** The latest retained signal for (name, source, key). */
  last<K extends SignalName<C>>(name: K, source: string, key?: string): Signal<C, K> | undefined;
  /** Every retained signal of the source, one per (name, key), in emission order. */
  lastAll(source: string): AnySignal<C>[];
}

export interface ISignalBus<C extends object> extends ISignalEmitter<C>, ISignalSubscriber<C> {}

/** Compile-time guard: resolves to `never` when two catalogs share a name. */
export type DisjointCatalogs<A extends object, B extends object> =
  Extract<keyof A, keyof B> extends never ? A & B : never;
```

### Semantics every implementation must keep

- **The producer is never affected.**
  - `emit` and `retire` never throw and never await.
  - A handler that throws, or returns a rejected promise, affects neither the producer nor other handlers. Implementations report it to their own error sink.
- **Payloads are immutable snapshots.**
  - Producers emit a fresh copy (`structuredClone` of internal state), never a live reference.
  - Implementations hand the same payload object to every handler and to `last` / `lastAll`.
  - Handlers must not mutate it. The default bus deep-freezes it.
- **Order.** Signals and retirements go through one queue per bus, in emission order.
  - The outermost `emit` (or `retire`) drains the queue before it returns. A call made from inside a handler only enqueues and returns at once; its entry is processed after the current dispatch finishes, still within the outermost call.
  - Retention for a signal is updated when that signal reaches dispatch, just before its handlers run. A handler that calls `last` therefore sees its own signal, and later queued signals have not been applied yet.
- **Retention is part of the contract.** `last` / `lastAll` return the latest signal per `(name, source, key)`.
  - An implementation that cannot retain (for example a pure bridge) implements only `ISignalEmitter`; it is not an `ISignalSubscriber`.
- **`retire(source)`** is processed at its position in the queue. Every signal of that source queued before it has been dispatched, so handlers of a final signal (for example `dialogue.session.closed`) can still read the retained state. The source's retained signals are then dropped.
  - A signal of the same source queued after the retirement starts a new generation: it is retained afresh, with nothing carried over from the retired one. A closed session id can thus be opened again on the same bus.
- **Delivery is synchronous within the outermost `emit`** unless an implementation documents otherwise; a deferring implementation must keep the order and the retire rule.
  - Handlers must not do blocking work; they hand it off.
- **No cross-process guarantee.** A bus is in-process; reaching other processes is the job of bridges.

### Direction, queries and external clients

- **One way by design.** Signals flow from producer to consumers only. The bus has no request channel into a producer.
- **Queries.** A question about current state is answered from retained signals (`last`, `lastAll`). A complete picture comes from the producer's own state API, for example `DialogueSession.snapshot()`.
- **Commands.** Requests that change something (stop a task, send a message) stay the producer's ordinary methods and tools. They are not signals.
- **External clients.** Clients outside the process never see the bus. A consumer in the process bridges it to the client's transport: SSE, MCP notifications such as `notifications/progress`, a webhook, OpenTelemetry.
  - **What the bridge owns:** ids, ordering across reconnects, acknowledgements and retries.
  - **A client that reconnects** is resynced from `lastAll(source)`. Retention per `(name, source, key)` keeps one latest state per entity, for example per task. Alternatively, the bridge seeds the client from the producer's state API.
  - **Live signals** continue after the resync.
  - **Two-way exchange** is the bridge's protocol, not the library's.

### Names, ownership and evolution

- **Name format.** Names are `<namespace>.<topic>[.<event>]`.
- **Ownership.** Each namespace is owned by exactly one package, which publishes its catalog:
  - `dialogue.` → `@mcp-abap-adt/llm-agent-libs`, catalog type in `@mcp-abap-adt/llm-agent`;
  - later ones such as `agent.` and `rag.` are registered in this document;
  - consumers use a namespace of their own (for example `hub.`) and never emit names in a library namespace.
- **Combining catalogs:** `DisjointCatalogs<A, B>`, which fails to compile when two catalogs share a name.
- **Additive only within a major version.**
  - New signals may be added. New payload fields may be added only as optional.
  - No field is removed or changes meaning.
  - A change that is not additive uses a new name; the old name is deprecated and kept until the next major.
  - Because names may be added, wildcard handlers must have a default branch.
- **Catalog version.** Each catalog exports a version constant (`DIALOGUE_SIGNALS_VERSION = 1`). It increases with each additive release, for consumers that want to assert a minimum.

## Implementation (`@mcp-abap-adt/llm-signals`, new package)

The package depends only on the contracts. Every part is optional and replaceable:

- `createSignalBus<C extends object>(opts?: { onHandlerError?: (error: unknown, signal: AnySignal<C>) => void }): ISignalBus<C>` is the in-process bus with the semantics above, including retention and the deep freeze.
- `combineEmitters<C extends object>(...emitters: ISignalEmitter<C>[]): ISignalEmitter<C>` fans out `emit` and `retire`, for example to the default bus plus a metrics bridge. One emitter failing does not stop the others.
- `filterEmitter<C extends object>(emitter: ISignalEmitter<C>, predicate: (name: SignalName<C>, source: string) => boolean): ISignalEmitter<C>` passes on only the signals that match; `retire` always passes.

Replacing everything means passing one's own `ISignalEmitter` / `ISignalBus`. Replacing a part means composing these helpers with one's own emitters.

**Build.** The package joins the monorepo's explicit root build, clean and publish lists. The contracts are exported through the existing `interfaces/index.ts` barrel.

## Producers (`@mcp-abap-adt/llm-agent-libs`)

- **Injection.** `DialogueSessionOptions.signals?: ISignalEmitter<DialogueSignals>`. When it is absent, the producers use an inline no-op emitter. `llm-agent-libs` therefore does not depend on `llm-signals`.
- **TaskBoard.** It receives the same emitter from DialogueSession. The source is the session id (`DialogueSessionOptions.id`).
- **Existing callbacks stay.** `onMessage`, the board's internal `onEvent` and the store keep working; signals are additive, with no version-breaking change.

### Dialogue catalog v1 (`src/interfaces/dialogue-signals.ts` in `@mcp-abap-adt/llm-agent`)

| Name | Key | Payload | When |
|---|---|---|---|
| `dialogue.turn.started` | `''` | `{ trigger: 'user' \| 'event' }` | A library turn begins, before its first planner call. |
| `dialogue.turn.settled` | `''` | `{ trigger: 'user' \| 'event'; outcome: 'ok' \| 'failed'; messageId?: string; status?: 'active' \| 'waiting_user' \| 'done' }` | See "When `dialogue.turn.settled` is emitted" below. |
| `dialogue.task.state` | task id | `{ task: TaskRecord; previous?: TaskState }` | Once after `open()` for every restored record (unchanged terminal ones and those converted to `interrupted`, without `previous`), before the initial `activity`; when `TaskBoard.start()` creates a record (`queued`, before `execute()`); and after every later state change, including the cancellation of a queued task. |
| `dialogue.activity` | `''` | `{ turnActive: boolean; queuedInputs: number; running: number; ready: number }` | Once after `open()` (after restoration and status recomputation), then whenever a field changes. |
| `dialogue.plan.changed` | `''` | `{ status: 'active' \| 'waiting_user' \| 'done'; total: number; done: number }` | Once after `open()` when a plan exists, then whenever status, `total` or `done` changes. |
| `dialogue.session.closed` | `''` | `{ reason?: string }` | On `close()`; the session then calls `retire(sessionId)`. |

`dialogue.activity` fields:
- `turnActive`: a library turn is in progress, corrections included.
- `queuedInputs`: waiting user sends plus waiting task events. A restart note is not counted on its own; it is prepended to the next input.
- `running`: tasks in state `queued` or `running`.
- `ready`: `readySteps(plan).length`, whether or not the correction loop may still act on them.

When `dialogue.turn.settled` is emitted:
- **Placement.** It is emitted at the turn boundary in `drain()` after `turn()` returned or threw, never inside `persist()`. Saves made by `takePending()` therefore emit nothing.
- **Persistence.** "After persistence" means after the turn's final persistence attempt has resolved; the store may have failed, which `persist()` already logs.
- **Event turns.** When an event turn invokes `onMessage` (not for `NO_MESSAGE`, not for a failed planner call), that call has run before the settled signal.
- **Outcome.**
  - A turn whose planner call failed settles with `outcome: 'failed'` and no `messageId`.
  - A turn cut by `close()` emits no settled signal; `dialogue.session.closed` follows instead.

`DIALOGUE_SIGNALS_VERSION = 1`.

## Example consumers (non-normative)

- **A chat server** keeps a response open while work goes on. It ends the response when `dialogue.turn.settled` reports `done` or `waiting_user`, or when `last('dialogue.activity', id)` shows nothing active, queued, running or ready. It keeps the session alive while `running > 0`.
- **An MCP subagent** reports progress from `dialogue.plan.changed` and returns when a settled turn reports `done`.
- **A metrics bridge** passes `combineEmitters(bus, otelEmitter)` to the session.

## Validation

- **Contracts (type tests).**
  - Interface catalogs and intersected catalogs both satisfy the constraint.
  - `AnySignal` narrows `payload` by `name`.
  - A mismatched name and payload does not compile.
  - `DisjointCatalogs` fails on a shared name.
- **Bus.**
  - A throwing or rejecting handler isolates the failure.
  - Re-entrant emits keep the order, and retention is updated before dispatch.
  - `last` works per `(name, source, key)`; `lastAll` returns one signal per `(name, key)` in emission order.
  - Payloads are frozen.
  - `retire` drops retention only after the queued signals of the source are dispatched, and a final-signal handler still reads the state.
  - Signals after a retire start a fresh generation (close, then reopen with the same id).
  - A nested emit only enqueues; the outermost call drains the queue, and retention is updated at dispatch.
  - The source filter works.
- **Helpers.** `combineEmitters` keeps going when one emitter throws and fans out `retire`; `filterEmitter`.
- **Producers, against the real `DialogueSession`.**
  - Initial `task.state` for every restored record, then `activity` and `plan.changed`, after `open()` and after a restore.
  - `turn.settled` comes once per turn after its final persistence attempt, with `outcome: 'failed'` for a failed planner call, none for a turn cut by `close()`, and none for `takePending` saves.
  - An event turn's `turn.settled` comes after `onMessage` when the turn invokes it; a `NO_MESSAGE` event turn still settles.
  - `task.state` reports `queued` at creation for a task blocked on the pool, keyed by task id. Two tasks are both retained.
  - `activity.ready` is still counted after `maxCorrections` is exhausted.
  - `plan.changed` fires when only `total` changes.
  - A payload mutation by a handler does not reach the producer.
  - `session.closed` is followed by `retire`.
  - With no emitter given, behaviour is identical to today.
