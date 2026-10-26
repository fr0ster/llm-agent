# Usage analytics: contract first, replaceable transport and storage

Date: 2026-10-25. Status: implemented (1.0.0); revision 5 adds the request shape of `llm.call`.

## Intent

Consumers of llm-agent need to know what their work really costs: LLM and embedding calls, tool calls, task work and, on the consumer side, sessions, storage and process resources.

The first consumer, cloud-llm-hub, collects raw per-session statistics now and decides later which analysis to run (Python first, maybe Grafana), in order to answer from measured data which subaccount parameters N users need.

The library stays agnostic: it records facts in its own terms and does not know where they go.

## Goals

- **Contract.** A contract in `@mcp-abap-adt/llm-agent` for recording usage, independent of transport and storage.
- **Completeness.** Every physical LLM call, embedding request, MCP tool dispatch and task end the library causes produces exactly one record, whatever the outcome: success, returned error, thrown error, cancellation, early stream close. A missing record is a defect.
  - The one stated exception: an SDK that retries internally and cannot be told not to is recorded per SDK call (`granularity: 'sdk-call'`, `retriesVisible: false`).
- **Replaceable implementations.** A recorder, transports and per-database sinks live in separate llm-agent packages. A consumer can replace any of them.
- **Raw records.** Raw, append-only records, rich enough for any later aggregation.

## Non-goals

- Forecast models, sizing calculators, dashboards, billing, quotas, real-time reactions. Real-time reactions are what signals are for.
- Durable buffering inside the producer process. Durability starts at the sink.

## Anti-goals

- Totals that are silently low: an unrecorded path, or a loss that is not accounted for.
- A visible cost to the producer, or unbounded memory.
- Content in records: conversation text, prompts, tool arguments or results, documents, credentials, tokens.

## Relation to signals and to `IRequestLogger`

**Signals** (`@mcp-abap-adt/llm-signals`) are a one-way information bus for current state. **Analytics** is an append-only journal for later analysis, a level above any transport. The two contracts are separate.

**`IRequestLogger`** stays as it is, as the diagnostic and request-summary logger. It is not the analytics source.

- It lacks facts records need: provider, stream flag, outcome, inputs, physical attempts. Its wrappers also log only on success.
- Analytics records are produced by dedicated boundary instrumentation (below).
- Existing logger call sites are not converted, so nothing is counted twice.

## Contract (`@mcp-abap-adt/llm-agent`, `src/interfaces/usage.ts`)

```ts
export const USAGE_SCHEMA_VERSION = 1;

/** Who and where. Identifiers and labels only, never content. */
export interface UsageContext {
  sessionId?: string; userId?: string; turnId?: string; taskId?: string;
  requestId?: string; traceId?: string;
  role?: string;            // the existing LlmComponent names where they apply: planner, executor, classifier, …
  destination?: string;
  [label: string]: string | undefined;   // additional consumer labels
}

interface Base {
  schema: typeof USAGE_SCHEMA_VERSION;
  id: string;              // unique; stable across retries of delivery
  at: number;              // ms since epoch, end of the operation
  context: UsageContext;
  outcome: 'ok' | 'error' | 'aborted';
  errorCode?: string;      // a code, never a provider body
}

type LlmCall = Base & { kind: 'llm.call';
  operationId: string; physicalSeq: number;         // 0,1,2… unique per physical request within the operation
  outerAttempt: number; providerAttempt: number;    // library retry attempt, provider-internal retry attempt
  granularity: 'request' | 'sdk-call'; retriesVisible: boolean;   // sdk-call: one SDK call that may hide retries
  provider: string; model: string; stream: boolean;
  inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
  tokensSource: 'provider' | 'estimate' | 'unknown';
  durationMs: number; firstTokenMs?: number; throttledMs?: number;
  closedEarly?: boolean;                              // stream consumer stopped before the end
  // Request shape (revision 5): sizes of what the request carried, never the content.
  inputMessages?: number;                           // messages in the request
  inputChars?: number;                              // characters of all messages: systemChars + userChars + assistantChars + toolChars
  systemChars?: number; userChars?: number; assistantChars?: number; toolChars?: number;
  toolDefs?: number; toolDefsChars?: number };      // tool definitions offered, and the length of their JSON
type EmbeddingCall = Base & { kind: 'embedding.call';
  operationId: string; physicalSeq: number; outerAttempt: number; providerAttempt: number;
  chunkPath: string;                                // e.g. '2/3>1/4': outer chunk 2 of 3, provider chunk 1 of 4
  granularity: 'request' | 'sdk-call'; retriesVisible: boolean;
  provider: string; model: string; inputs: number; inputChars: number;
  inputTokens?: number; tokensSource: 'provider' | 'estimate' | 'unknown';   // exact provider total of this request
  durationMs: number };
type ToolCall = Base & { kind: 'tool.call';
  server?: string; tool: string; dispatched: boolean;        // false: served from cache, no MCP request
  embedded: boolean;                                          // true: an embedded handler, no network request
  transportOutcome: 'ok' | 'error' | 'aborted';              // the MCP request
  toolOutcome?: 'ok' | 'error';                              // isError of the tool result
  durationMs: number; requestBytes?: number; responseBytes?: number };
type TaskEnd = Base & { kind: 'task';
  taskId: string; worker: string; state: TaskState;
  queuedMs?: number; runMs?: number; endKnown: boolean;      // false: interrupted by a crash, end time unknown
  toolCalls?: number; budgetExhausted?: boolean };
type Extension = Base & { kind: `x.${string}`; values: Record<string, number | string | boolean> };

export type UsageRecord = LlmCall | EmbeddingCall | ToolCall | TaskEnd | Extension;

/** Distributive: each variant keeps its own required fields. */
export type UsageInput = UsageRecord extends infer R
  ? R extends UsageRecord ? Omit<R, 'schema' | 'id' | 'at'> & Partial<Pick<R, 'id' | 'at'>> : never : never;

/** Producer side. */
export interface IUsageRecorder {
  record(input: UsageInput): void;          // never throws, never awaits
  with(context: UsageContext): IUsageRecorder;
}

/** Delivery between recorder and sink. `send` resolves only when the sink has written the batch. */
export interface IUsageTransport {
  send(batch: readonly UsageRecord[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * A failed send or write rejects with this error when it knows whether the batch may have
 * reached storage. Any other rejection is treated conservatively as `possiblyDelivered: true`.
 */
export class UsageDeliveryError extends Error {
  constructor(message: string, readonly possiblyDelivered: boolean, readonly code?: string) { super(message); }
}

/** Storage. `write` is idempotent by `id`: writing a record twice stores it once. */
export interface IUsageSink {
  write(batch: readonly UsageRecord[]): Promise<void>;
  close?(): Promise<void>;
}

/** Lifecycle and health of a running recorder implementation (not needed by producers). */
export interface IUsageControl {
  flush(timeoutMs: number): Promise<void>;
  close(timeoutMs: number): Promise<{ delivered: number; lost: number; unconfirmed: number }>;
  stats(): { buffered: number; delivered: number; lost: Record<string, number>; lastErrorCode?: string };
}
```

### Rules

- **Snapshots.**
  - `record` and `with` copy their inputs (`structuredClone`). Later mutation by the caller changes nothing already recorded.
  - Values are plain data only.
  - The recorder fills in `schema`, `id` and `at`.
- **Producer safety.** `record` never throws or awaits. A failing transport or sink never affects the producer.
- **Delivery (precise).** A record is *accepted* when `record` returns and it is in the recorder's bounded queue. It is *delivered* when a `send` that carried it resolved, which means the sink wrote it. Accepted records are delivered at least once while the process lives and the sink becomes writable within the retry window. Sinks are idempotent by `id`, so retries do not inflate totals.
- **Loss accounting (best effort, stated plainly).** A record is *lost* when the queue overflows, the retry window expires, or a close times out.
  - Losses are counted per `(sessionId or '', kind)` in fixed windows (`lossWindowMs`).
  - When a window closes, the recorder emits one `x.usage.lost` record per session with losses in it. Its id is `lost:<recorderInstanceId>:<sessionId>:<windowStart>`, so a retried emission is stored once.
  - Its values hold the counts per kind and `affectedFrom` / `affectedTo`: the minimum and maximum `at` of the lost records. A loss recognized after midnight for a request that ended before midnight therefore still points at the request's time.
  - Readers select loss records whose affected range overlaps the period they analyse.
  - Losses after a window closed belong to the next window. At close, the open window is closed early and emitted.
  - A loss record that itself cannot be delivered is not re-reported as a loss (no recursion). It is counted only in `stats().lost` and in the close result.
  - Loss counters live in a bounded map. On overflow, the oldest session counters merge into a session `''` counter.
  - **How readers use them.** A session-filtered analysis must also consult `''` loss records whose affected range overlaps. They mark that some session's data in that range is incomplete, without saying which.
  - **Crashes.** A crash loses accepted records without any loss record. Consumers detect it from their own lifecycle records, for example a session without a close record.
  - **The guarantee is therefore:** delivered records are exact, and losses are reported when the reporting path works. It is not a guarantee that every loss is visible in the data.
- **Shutdown.**
  - `IUsageControl.close(timeoutMs)` has one deadline for the whole shutdown:
    1. stop accepting;
    2. close the open loss window;
    3. drain the queue through the transport;
    4. close the transport, then the sinks.
  - Every await is raced against the same deadline, so `close` always resolves by it, even with a `send` or `close` that never resolves.
  - It resolves to disjoint counters:
    - `delivered`: sends that resolved;
    - `unconfirmed`: records whose delivery is ambiguous. That is a send still pending at the deadline, or a send that rejected after it may have reached the sink: an HTTP failure after the request body was sent, or a `combineSinks` batch where some sinks wrote. A record stays unconfirmed even after an earlier rejected attempt, until a later send of it resolves;
    - `lost`: records never sent, or rejected before any sink could have received them (for example a connection refused).
  - **Classification.**
    - Transports and sinks reject with `UsageDeliveryError`. Use `possiblyDelivered: false` only when the batch certainly did not reach storage, for example a connection refused before the request was sent or a validation failure before the write.
    - `combineSinks` rejects with `possiblyDelivered: true` as soon as any sink may have written.
    - Transports pass on a sink's classification, or `true` when they cannot know.
    - The recorder classifies any other error as `possiblyDelivered: true`. Unknown failures are therefore unconfirmed, never lost.
  - Acknowledgements that arrive after the deadline are ignored and not recounted.
  - Unconfirmed records are reported in `x.usage.lost` under a separate `unconfirmed` count, with the same affected range, so readers know the data may contain them or not.
  - The consumer logs an incomplete shutdown.
  - `flush` drains without closing.
- **Content.** No content, and only the listed fields. `x.*` values are numbers, labels and flags, never text taken from content.
- **Evolution.** The schema only grows: new kinds and optional fields may be added, and readers ignore unknown ones.
- **Request shape** (`llm.call`).
  - Measured by a shared core helper `requestShape(messages, tools)` on the messages and tool definitions the provider received for that request, before provider-specific encoding. Every provider passes it into the request's base facts, so each physical request, including each retry, carries it.
  - Characters are UTF-16 code units (`string.length`). A message counts its `content`; an assistant message also counts the `name` and `arguments` of its `tool_calls`. Messages are attributed by their `role`. `toolDefsChars` is the length of `JSON.stringify` of the tool definitions, cached per tools array so a repeated array is not serialized again.
  - The fields are present whenever the provider knows its messages, independent of `tokensSource`: the context size is visible for providers that report no tokens.
  - Sizes only. They count, never copy.
- **Tokens.**
  - `'provider'` only for counts the provider reported for that physical request, unmodified. Embedding batch totals are never split into per-item estimates.
  - Otherwise `'estimate'`, or `'unknown'`.

## Instrumentation (where the library records)

There is one owner per operation: a boundary decorator. Nothing else records that operation.

| Operation | Owner (boundary) | Record |
|---|---|---|
| LLM call | each provider package, at its physical request: inside its own retry closures (for example `withThrottleRetry` in the OpenAI and SAP providers), through a shared hook `reportLlmRequest(op, facts)` from `@mcp-abap-adt/llm-agent` | one `llm.call` per physical HTTP or SDK request, recorded in `finally`, so a returned error, a throw, an abort or an early stream close (`closedEarly`) all produce a record. For SDK-delegating providers whose SDK retries internally, the SDK retries are disabled where the SDK allows it (then `granularity: 'request'`); otherwise the SDK call is one record with `granularity: 'sdk-call'`, `retriesVisible: false` |
| Embedding request | each embedder provider package, at its physical request (inside its own chunk and retry loops), through `reportEmbeddingRequest(op, facts)` | one `embedding.call` per physical request, with that request's exact provider token total, or `unknown` when the provider reports none; SDK-delegating embedders follow the same `granularity` rule as LLM providers |
| MCP tool dispatch | `McpClientWrapper`, around each internal request (`performCall`): the first try, after a reconnect, after a session reset; and around each embedded-handler execution (`embedded: true`), including thrown errors, cancellation and a returned `isError` | one `tool.call` per request, with `transportOutcome` and `toolOutcome` from `isError`; cache hits are recorded by the tool-call cache as `dispatched: false` |
| Task end | `TaskBoard` | one `task` at the terminal transition |

Per-path rules:
- **Tasks:**
  - a queued task stopped before start has `queuedMs` = finish − created and no `runMs`;
  - tasks converted to `interrupted` by `restore` are recorded once at restore, with `endKnown: false` and no `runMs`. Their id is stable and globally unique: `task:<boardId>:<taskId>:interrupted`, where `boardId` is the persisted owner identity of the board (the dialogue session id), so two sessions restoring the same board-local `t1` do not collide;
  - already-terminal restored tasks are not recorded again.
- **Direct calls to an injected LLM** (for example `HistorySummarizer`) are covered because the physical request is recorded inside the provider.

**The completeness test** enumerates the library's call paths with fake providers and asserts one record per physical operation for each outcome:
- ok, returned error, thrown error, abort, early stream close;
- a retry with three attempts;
- a batch split into three chunks with a failure in the last;
- nested outer chunking plus inner provider retries;
- provider-internal throttle retries (a 429, then success: two records);
- an MCP dispatch retried after a reconnect (two records);
- an embedded tool handler: ok, a thrown error, cancellation and a returned `isError`;
- shutdown with a `send` and a sink `close` that never resolve: `close` resolves by its deadline with the right counters;
- shutdown after an HTTP send whose acknowledgement is lost, and after a `combineSinks` batch where one of two sinks wrote: those records count as `unconfirmed`, not as `lost`;
- classification through the public contracts: a custom transport rejecting with a plain `Error` (unconfirmed), with `UsageDeliveryError(possiblyDelivered: false)` (lost), and a custom sink inside `combineSinks` (propagated);
- two concurrent TaskBoard tasks: each record carries its own `taskId`.

Real provider packages are exercised with a mocked HTTP layer, not fake `ILlm`s only. The paths it covers:
- SmartAgent and the planner, executor and checker workers;
- the classifier, summarizer, translator, query expander, finalizer and step reviewer;
- RAG indexing and query, and tool vectorization;
- tool-loop dispatch, the coordinator's tool calls and the mixed tool-call handler.

### Operation metadata

A logical LLM call or embedding operation is described by a `UsageOperation`. It travels in call options (`CallOptions.usageOp`), next to the recorder:

```ts
export interface UsageOperation {
  operationId: string;
  seq: { next(): number };     // shared by reference across copies; allocates physicalSeq
  outerAttempt: number;        // 0 unless a library retry wrapper set it
  providerAttempt: number;     // 0 unless a provider loop set it
  chunkPath: string;           // '' at the top
}
```

A provider called directly, with no library wrapper above it, finds no `usageOp`. It creates one itself (new `operationId`, a fresh counter, zeros, `''`), so direct calls are recorded the same way. The retry and chunking decorators replace the operation in the options they forward, with a copy carrying their coordinate; they do not forward the caller's object unchanged.

- **Who sets what.**
  - The outermost library wrapper of a logical call creates the operation: `operationId`, plus a shared counter object that allocates `physicalSeq`.
  - Library retry wrappers (`RetryLlm`, `RetryEmbedder`, `RetryBatchEmbedder`) set `outerAttempt`.
  - `BatchChunkingEmbedder` appends its coordinate to `chunkPath`.
  - A provider's own internal loops set `providerAttempt` and append their chunk coordinate to `chunkPath`. They work on a copy that shares the counter, so they never overwrite outer coordinates.
- **What the hook records.** Each physical request takes the next `physicalSeq` from the shared counter.
- **Uniqueness.** `(operationId, physicalSeq)` is unique. The other fields say where in the nesting the request sits.
- **Test.** Nested outer chunking plus outer and provider retries, asserting the exact coordinate values.

### Context propagation

- **Call options.** `CallOptions` gains `usage?: IUsageRecorder`, an additive field.
  - Every library component passes it down unchanged, or narrowed with `with(...)`.
  - `normalizeRequestOptions` keeps a caller-provided recorder instead of replacing it.
- **Turns and tasks.**
  - The dialogue session narrows it with `turnId` for each turn.
  - `TaskBoard` narrows it with `taskId` and the worker role, and passes it in a new additive worker-input field `ISubAgentInput.usage`. Every worker adapter (`SmartAgentSubAgent` and the others) forwards it into the call options it builds.
  - Workers pass it on to their LLM and tool calls.
- **MCP calls.** `McpClientAdapter` forwards `CallOptions.usage` to `McpClientWrapper.callTool` through an additive options parameter (next to the signal).
- **Boundary instrumentation** takes the recorder from the call options. If none is given they use the recorder bound at construction. If that is missing too, they use a no-op, so behaviour without a recorder is unchanged.

## Packages

**`@mcp-abap-adt/llm-usage`** (no database drivers):
- **Recorder:** `createUsageRecorder({ transport, queueLimit, retryWindowMs, lossWindowMs, now?, idFactory? })` returns `IUsageRecorder & IUsageControl`; plus `noopRecorder`.
- **Transports:**
  - `directTransport(sink, { batchSize, flushMs })`: acknowledged by the sink write;
  - `httpTransport({ url, headers, batchSize, flushMs })`: acknowledged by the collector's 2xx after it wrote the batch, with a documented request/response format;
  - `signalTransport` (best effort):
    - it is *not acknowledged*;
    - it publishes each batch under one fixed key, so the bus retains only the latest batch and receivers must consume live;
    - its records count as delivered when emitted;
    - meant for in-process fan-out where loss is acceptable, and documented as such.
- **Sinks:**
  - `memorySink({ limit })` and `jsonlFileSink({ path, rotateBytes })`;
  - reading and export deduplicate by `id`;
  - `combineSinks(...)` acknowledges only when every sink wrote, and a failing sink fails the batch, which is retried and is idempotent.
- **Reading:** `read({ from, to, kinds, sessionId? })` and `export('jsonl' | 'csv')` helpers, shared by all sinks. The CSV has one column per record field, the request-shape fields included (`inputChars` is shared with `embedding.call`).

**Database sinks**, one package per database, each depending only on the contract and its own driver:
- **`@mcp-abap-adt/llm-usage-pg`.**
- **`@mcp-abap-adt/llm-usage-hana`** (`@sap/hana-client`).
- **`@mcp-abap-adt/llm-usage-sqlite`** (`node:sqlite`).
  - Requires Node ≥ 22.13 and checks the capability at construction, failing with a clear error otherwise.
  - Writes run in a worker thread so the synchronous API does not block the event loop.
- **What all three share:**
  - one append-only table with the common columns and the kind payload as JSON;
  - primary key `id`, inserts that ignore duplicates;
  - indexes on `at`, `session_id` and `kind`;
  - `read(...)` and `deleteOlderThan(ms)`;
  - DDL shipped in the package, with `autoCreateSchema` on by default for PostgreSQL and SQLite and off for HANA (an operator applies the DDL to the HDI container, as with the vector stores).

## Validation

- **Types.**
  - Valid producer inputs per kind compile.
  - A missing kind field or a wrong field fails to compile.
  - `x.*` values reject objects.
- **Recorder.**
  - `record` never throws, even with a throwing transport.
  - Inputs are snapshots: mutation after `record` does not reach the sink.
  - The queue stays bounded.
  - Every loss reason (overflow, retry window, close timeout) yields `x.usage.lost` for the right session and window, emitted once even when its delivery is retried.
  - Shutdown order works.
- **Transports.**
  - Direct and HTTP: a batch is acknowledged only after the write; a lost acknowledgement causes a retry without a duplicate stored.
  - Signal transport: the documented best-effort behaviour.
- **Sinks.**
  - Memory, JSONL, PGlite, SQLite and, under the existing HANA test gating, HANA: idempotent writes, reads by window, kind and session, CSV columns, retention.
  - SQLite: rejected on an unsupported Node; writes run off the main thread.
- **Request shape:** `requestShape` counts each role, tool-call arguments and tool definitions exactly; every provider's `llm.call` carries the shape, including on retries and errors.
- **Completeness:** the test above.
- **Content:** distinctive prompt, document, argument and result strings never appear in any record.
- **No recorder given:** behaviour is identical to today.
