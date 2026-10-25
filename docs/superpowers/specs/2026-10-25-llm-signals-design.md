# Signals: contracts first, replaceable implementation

Date: 2026-10-25. Status: draft for review.

## Purpose

Library components report facts about their own state, for example that a dialogue turn has settled or that a task changed state. Consumers build their own exchange schemes on those facts: a chat server that holds a response open, an MCP subagent that reports progress, a CLI spinner, a metrics bridge. The library stays agnostic to these schemes.

Three rules follow:

1. **Contracts first.** Producers and consumers depend only on interfaces in `@mcp-abap-adt/llm-agent`, never on an implementation.
2. **Replaceable.** A consumer can replace the whole signal implementation, or a part of it (wrap, fan out, filter), without changing any producer.
3. **No consumer-specific signals.** A signal states a fact of the producing component in the component's own terms. Nothing names a transport, a protocol, a UI or a particular consumer.

## Contracts (`@mcp-abap-adt/llm-agent`, `src/interfaces/signals.ts`)

```ts
/** A catalog maps signal names to payload types. */
export type SignalCatalog = Record<string, unknown>;
export type SignalName<C extends SignalCatalog> = Extract<keyof C, string>;

export interface Signal<C extends SignalCatalog, K extends SignalName<C> = SignalName<C>> {
  name: K;
  payload: C[K];
  /** Producer instance, e.g. the dialogue session id. */
  source: string;
  /** Emission time, ms since epoch. */
  at: number;
}
export type SignalHandler<C extends SignalCatalog, K extends SignalName<C> = SignalName<C>> =
  (signal: Signal<C, K>) => void | Promise<void>;
export type Unsubscribe = () => void;

/** Producer side: the only thing a producer depends on. */
export interface ISignalEmitter<C extends SignalCatalog> {
  emit<K extends SignalName<C>>(name: K, payload: C[K], source: string): void;
  /** The producer instance has ended; implementations may drop its retained state. */
  retire?(source: string): void;
}

/** Consumer side. */
export interface ISignalSubscriber<C extends SignalCatalog> {
  on<K extends SignalName<C>>(name: K, handler: SignalHandler<C, K>, filter?: { source?: string }): Unsubscribe;
  onAny(handler: SignalHandler<C>, filter?: { source?: string }): Unsubscribe;
  /** The last signal of this name from this source, if retained. */
  last<K extends SignalName<C>>(name: K, source: string): Signal<C, K> | undefined;
  /** The last retained signal of every name from this source, in emission order: a resync point. */
  lastAll(source: string): Signal<C>[];
}

export interface ISignalBus<C extends SignalCatalog> extends ISignalEmitter<C>, ISignalSubscriber<C> {}
```

### Semantics every implementation must keep

- **The producer is never affected.**
  - `emit` never throws and never awaits.
  - A handler that throws, or returns a rejected promise, affects neither the producer nor other handlers. Implementations report it to their own error sink.
- **Order.**
  - Per bus, handlers see signals in emission order.
  - A signal emitted from inside a handler is dispatched after the current dispatch finishes, so the order is still emission order.
- **Delivery.**
  - Dispatch is synchronous within `emit`, unless an implementation documents otherwise; a deferring implementation must still keep the order.
  - Handlers must not do blocking work; they hand it off.
- **Retention.**
  - `last()` returns the latest signal per `(name, source)`.
  - `retire(source)` lets an implementation drop the retained signals of that source.
  - Retention is what lets state-like signals (see `dialogue.activity`) be read on demand without a separate query API.
- **No delivery guarantee across processes.** A bus is in-process. Bridges to other systems are consumer implementations of `ISignalEmitter`.

### Names, catalogs and conflicts

- **Name format.** Names are `<namespace>.<topic>[.<event>]`.
  - Library-owned namespaces are reserved: `dialogue.`, and later ones such as `agent.` and `rag.`.
  - Consumers use their own namespace (for example `hub.`).
- **Catalog evolution.** Each producer publishes its catalog as a type. Consumers combine catalogs by intersection (`DialogueSignals & MySignals`); disjoint namespaces make conflicts impossible by construction.
- **Additive only within a major version.**
  - New signals may be added. New payload fields may be added only as optional.
  - No field is removed or changes meaning.
  - A change that is not additive uses a new name; the old name is deprecated and kept until the next major.
- **Catalog version.** Each catalog exports a version constant (`DIALOGUE_SIGNALS_VERSION = 1`) that increases with each additive release, for consumers that want to assert a minimum.

### Direction, queries and external clients

- **One way by design.** Signals flow from producer to consumers only; the bus has no request channel into a producer.
- **Queries.** A question about current state is answered from retained signals (`last`, `lastAll`) or the producer's own state API (for example `DialogueSession.snapshot()`), never by asking the producer through the bus.
- **Commands.** Requests that change something (stop a task, send a message) stay the producer's ordinary methods and tools. They are not signals.
- **External clients.** Clients outside the process never see the bus. A consumer in the process bridges it to the client's transport: SSE, MCP notifications such as `notifications/progress`, a webhook, OpenTelemetry. The bridge is an `ISignalEmitter` (push), or an `ISignalSubscriber` user (subscribe and forward).
  - **Its own transport.** It owns everything about that transport: ids, ordering across reconnects, acknowledgements, retries.
  - **Client questions.** When a client asks "what is the state now?", the bridge answers from `last` / `lastAll`.
  - **Reconnects.** A client that reconnects is resynced from `lastAll(source)` before live signals continue.
  - **Same contract.** The contract is therefore enough for external clients without a two-way bus; two-way exchange is the bridge's protocol, not the library's.

## Implementation (`@mcp-abap-adt/llm-signals`, new package)

The package has no dependencies other than the contracts. Every part is optional and replaceable:

- `createSignalBus<C>(opts?: { onHandlerError?: (error: unknown, signal: Signal<C>) => void; retain?: boolean }): ISignalBus<C>` is the in-process bus with the semantics above. `retain` defaults to true.
- `combineEmitters<C>(...emitters: ISignalEmitter<C>[]): ISignalEmitter<C>` fans out to several emitters, for example the default bus plus a metrics bridge. One emitter failing does not stop the others.
- `filterEmitter<C>(emitter, predicate: (name, payload, source) => boolean): ISignalEmitter<C>` passes on only the signals that match.
- `noopEmitter: ISignalEmitter<any>` drops everything; it is the producers' default.

Replacing everything means passing one's own `ISignalEmitter` / `ISignalBus`. Replacing a part means composing these helpers with one's own emitters.

## Producers (`@mcp-abap-adt/llm-agent-libs`)

- **Injection.** `DialogueSessionOptions.signals?: ISignalEmitter<DialogueSignals>`. When it is absent, the producers use a no-op emitter. `llm-agent-libs` therefore does not depend on `llm-signals`.
- **TaskBoard.** It receives the same emitter from DialogueSession. The source is the session id (`DialogueSessionOptions.id`).
- **Existing callbacks stay.** `onMessage`, the board's internal `onEvent` and the store keep working; signals are additive. No version-breaking change.

### Dialogue catalog v1 (`src/interfaces/dialogue-signals.ts` in `@mcp-abap-adt/llm-agent`)

| Name | Payload | When |
|---|---|---|
| `dialogue.turn.started` | `{ trigger: 'user' \| 'event' }` | A library turn begins (before its first planner call). |
| `dialogue.turn.settled` | `{ trigger: 'user' \| 'event'; messageId?: string; status?: 'active' \| 'waiting_user' \| 'done' }` | After the correction loop, status recomputation and the turn's final persistence; for an event turn also after `onMessage`. Saves triggered by `takePending()` emit nothing. |
| `dialogue.task.state` | `{ task: TaskRecord; previous?: TaskState }` | When a TaskBoard record is created (`queued`) and after every state change, including the cancellation of a queued task. |
| `dialogue.activity` | `{ turnActive: boolean; queuedInputs: number; running: number; ready: number }` | Whenever a field changes. `running` counts `queued` and `running` tasks; `ready` is the number of plan steps ready to start. Read the current value with `last('dialogue.activity', sessionId)`. |
| `dialogue.plan.changed` | `{ status: 'active' \| 'waiting_user' \| 'done'; total: number; done: number }` | When the plan's status or the number of done steps changes. |
| `dialogue.session.closed` | `{ reason?: string }` | On `close()`; the session then calls `retire(sessionId)`. |

`DIALOGUE_SIGNALS_VERSION = 1`.

## Example consumers (non-normative)

- **A chat server** ends an open response when `dialogue.turn.settled` reports `done` or `waiting_user`, or when `last('dialogue.activity')` shows nothing active, queued, running or ready. It keeps the session alive while `running > 0`.
- **An MCP subagent** reports progress from `dialogue.plan.changed` and returns when a settled turn reports `done`.
- **A metrics bridge** passes a `combineEmitters(bus, otelEmitter)` to the session.

## Validation

- **Contracts:** type tests that catalogs compose by intersection, and that `on` / `last` / `emit` are typed per name.
- **Bus:**
  - a throwing or rejecting handler isolates the failure;
  - re-entrant emits keep the order;
  - `last` per source;
  - `lastAll` returns one signal per name, in emission order;
  - `retire` drops the source's retained signals;
  - a filter by source.
- **Helpers:** `combineEmitters` keeps going when one emitter throws; `filterEmitter`.
- **Producers, against the real `DialogueSession`:**
  - `turn.settled` once per turn, after the final persistence, and not for `takePending` saves;
  - an event turn's `turn.settled` comes after `onMessage`;
  - `task.state` reports `queued` at creation for a task blocked on the pool;
  - `activity.ready` is still counted after `maxCorrections` is exhausted;
  - `session.closed` followed by `retire`;
  - with no emitter given, behaviour is identical to today.
