# Usage analytics: contract first, replaceable transport and storage

Date: 2026-10-25. Status: draft for review.

## Intent

Consumers of llm-agent need to know what their work really costs: LLM and embedding tokens, tool calls, task work, and, on the consumer side, sessions, storage and process resources.

The first consumer, cloud-llm-hub, collects raw per-session statistics now and decides later which analysis to run, starting with Python and maybe Grafana. The aim is to answer, from measured data, "which subaccount parameters does a customer need for N users". The library stays agnostic: it records facts in its own terms and does not know where they go.

## Goals

- A contract in `@mcp-abap-adt/llm-agent` for recording usage, independent of transport and storage.
- Library components record every usage they cause: every LLM call, embedding call, tool call and task. A missing record is a defect.
- Replaceable implementations in separate llm-agent packages: a recorder, transports and sinks. A consumer can replace any of them with its own.
- Raw, append-only records rich enough for any later aggregation.

## Non-goals

- Forecast models, sizing calculators and dashboards.
- Billing or quotas.
- Real-time reactions; that is what signals are for.

## Anti-goals (failure even if it works)

- **Incomplete records.** An LLM or embedding call path that records nothing, so totals are silently low.
- **A visible cost to the producer.** Recording that slows down or breaks the producer, or grows without bound.
- **Sensitive content in records.** Conversation text, prompts, tool arguments or results, credentials or tokens.

## Relation to signals

Signals (`@mcp-abap-adt/llm-signals`) are a one-way information bus: current state, retained latest values, subscriptions.

Analytics is a level above any transport. It is an append-only journal of usage records, kept for later analysis, where completeness matters. It may be implemented over different transports: in-process, the signal bus, REST, OpenTelemetry. The two contracts are separate, and analytics does not depend on signals.

## Layers

1. **Contract** (`@mcp-abap-adt/llm-agent`, `src/interfaces/usage.ts`): what a usage record is, and how a producer records one (`IUsageRecorder`). Library components and consumers depend only on this.
2. **Transport**: how a record reaches storage. Implementations are replaceable: direct in-process, over a signal bus, HTTP to a collector, OpenTelemetry later.
3. **Storage and export** (`IUsageSink`): where records are kept and how they are read back for analysis.

## Contract

```ts
export const USAGE_SCHEMA_VERSION = 1;

/** Who and where. Only identifiers and labels, never content. */
export interface UsageContext {
  sessionId?: string;
  userId?: string;          // consumer-defined identifier; consumers may hash it
  turnId?: string;          // one planner turn or one request
  taskId?: string;
  role?: string;            // e.g. 'planner', 'executor', 'checker', 'classifier', 'embedder'
  destination?: string;
  traceId?: string;
  [label: string]: string | undefined;   // further consumer labels (additive)
}

interface UsageRecordBase {
  schema: typeof USAGE_SCHEMA_VERSION;
  id: string;               // unique per record (for dedupe across retries)
  at: number;               // ms since epoch, end of the measured operation
  context: UsageContext;
  outcome: 'ok' | 'error' | 'aborted';
  errorCode?: string;       // a code, never a provider error body
}

export type UsageRecord =
  | (UsageRecordBase & { kind: 'llm.call'; provider: string; model: string; stream: boolean;
      inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
      tokensSource: 'provider' | 'estimate' | 'unknown';
      durationMs: number; firstTokenMs?: number; retries?: number; throttledMs?: number })
  | (UsageRecordBase & { kind: 'embedding.call'; provider: string; model: string;
      inputs: number; inputChars: number; inputTokens?: number;
      tokensSource: 'provider' | 'estimate' | 'unknown'; durationMs: number })
  | (UsageRecordBase & { kind: 'tool.call'; server?: string; tool: string;
      durationMs: number; requestBytes?: number; responseBytes?: number })
  | (UsageRecordBase & { kind: 'task'; worker: string; state: TaskState;
      queuedMs: number; runMs: number; toolCalls?: number; budgetExhausted?: boolean })
  | (UsageRecordBase & { kind: `x.${string}`; values: Record<string, number | string | boolean> });

/** Producer side: the only thing a producer depends on. */
export interface IUsageRecorder {
  record(record: Omit<UsageRecord, 'schema' | 'id' | 'at'> & Partial<Pick<UsageRecordBase, 'id' | 'at'>>): void;
  /** A recorder whose records carry this context merged over the parent's. */
  with(context: UsageContext): IUsageRecorder;
}

/** Storage side. */
export interface IUsageSink {
  write(records: readonly UsageRecord[]): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}
```

### Rules every implementation keeps

- **Producer safety.** `record` never throws, never awaits and returns at once. A failing transport or sink never affects the producer.
- **Bounded memory.** Buffering is bounded. When records are dropped, the drop is itself recorded: a `x.usage.dropped` record with counts per kind, emitted when possible. This way losses are visible in the data instead of silently lowering totals.
- **Delivery.** Records go to a sink at least once; the record `id` lets the sink deduplicate. A graceful shutdown flushes.
- **Content.** No content of any kind, and only the listed fields. `x.*` kinds are for consumer measurements and carry only numbers, labels and flags, never text taken from content.
- **Evolution.** The schema is additive within a version: new kinds and optional fields may be added. Readers ignore unknown kinds and fields.
- **Token counts.**
  - Provider-reported counts are recorded as such (`tokensSource: 'provider'`).
  - When a provider reports none, the producer records `'unknown'`, or an estimate marked `'estimate'`. It never records a guessed count as if the provider had reported it.

### Relation to the existing `IRequestLogger`

The library already calls `IRequestLogger` (`logLlmCall`, `logRagQuery`, `logToolCall`) at about two dozen places. Each call carries a `component` (planner, executor, classifier, embedding, …), the tokens with an `estimated` flag, and the duration. Those call sites are the choke points; the new contract adds no second set. *(My call: no double counting, no breaking change.)*

- **Adapter.** `@mcp-abap-adt/llm-usage` ships `usageRequestLogger(recorder, inner?)`, an `IRequestLogger` that turns each call into a usage record and optionally forwards it to an inner logger.
  - LLM calls become `llm.call`, with `role` set to the existing `LlmComponent` name.
  - Embedding entries become `embedding.call`.
  - Tool calls become `tool.call`.
  - RAG queries become `x.rag.query` with counts and duration only. The query text is dropped (no-content rule).
  - `estimated: true` maps to `tokensSource: 'estimate'`.
- **Gaps.** Where the completeness test finds an LLM, embedding or tool path that does not reach `IRequestLogger`, the fix is to make it reach the logger; the path does not call the recorder directly.
- **Context.** Context that `IRequestLogger` entries lack (`sessionId`, `turnId`, `taskId`) comes from the recorder bound by the consumer (`with`). Library components narrow it where they know more.
- **Tasks.** Task records (`task`) come from TaskBoard directly, because it has no `IRequestLogger` path.
- **Unchanged.** `IRequestLogger` itself and `llm-agent-server-libs` usage logging stay as they are.

### Where the library records

- **LLM calls.** Every `ILlm` chat and stream call made by library components, whatever the caller: SmartAgent, planner, executor, checker, classifier, summarizer, translator, query expander, finalizer, step reviewer. The record carries the role. The builder chooses the single choke point, or points, that guarantee this. A test enumerates the library's LLM call paths and fails when one does not record.
- **Embedding calls.** Every embedding call made through library embedders and RAG components (indexing and query).
- **Tool calls.** Every MCP tool call the library dispatches.
- **Tasks.** Every TaskBoard task, at its terminal state, including stopped and interrupted tasks.

**Context.** Context flows from the consumer. A consumer passes a recorder that is already bound to its context (`recorder.with({ sessionId, userId, … })`). Library components narrow it further (`with({ role, turnId, taskId })`) where they know more. Components get the recorder through their existing options or constructors. When none is given they use an inline no-op, so behaviour without a recorder is unchanged.

## Packages (implementations)

- **`@mcp-abap-adt/llm-usage`** (new):
  - `createUsageRecorder({ transport, now?, idFactory?, bufferLimit? })`: the default recorder, with bounded buffering and drop accounting;
  - `usageRequestLogger(recorder, inner?)`: the `IRequestLogger` adapter described above;
  - `noopRecorder`;
  - `combineSinks(...sinks)`: fan-out; one failing sink does not stop the others;
  - transports:
    - `directTransport(sink, { batchSize, flushMs })`: in-process;
    - `httpTransport({ url, headers, batchSize, flushMs, retry })`: POSTs JSON batches to a collector;
    - `signalTransport(emitter)`: publishes records over an `ISignalEmitter`, with a matching `signalSource(subscriber, sink)` on the receiving side;
  - simple sinks:
    - `memorySink({ limit })` with `read({ from?, to?, kinds? })` and `export('jsonl' | 'csv')`;
    - `jsonlFileSink({ path, rotateBytes })`.
- **`@mcp-abap-adt/llm-usage-sql`** (new): table sinks for PostgreSQL, HANA and SQLite.
  - It follows the store pattern of the existing `pg-vector-rag` / `hana-vector-rag` packages.
  - One append-only table, holding the common columns plus the kind-specific payload as JSON.
  - Indexes on `at`, `session_id` and `kind`.
  - A read API `read({ from, to, kinds, sessionId? })` for export, and retention by age (`deleteOlderThan(ms)`).
  - SQLite is for consumers without a database server, for example a single container without persistence. It uses Node's built-in `node:sqlite` where available, so the package carries no native dependency. *(My call.)*
  - The DDL ships with the package for all three databases. Creating the table at runtime is `autoCreateSchema`: on by default for PostgreSQL and SQLite, off for HANA, where an operator applies the DDL to the HDI container, as with the vector stores.

A consumer may replace any of these with its own transport or sink: the contract is all that the library depends on.

## Validation

- **Contract type tests:** kinds narrow by `kind`; `x.*` records accept only number, string and boolean values.
- **Recorder:**
  - `record` never throws, even with a throwing transport;
  - buffering stays bounded;
  - drops produce a `x.usage.dropped` record;
  - `with` merges context;
  - ids are unique.
- **Transports:**
  - direct batching and flush;
  - HTTP retry with dedupe ids;
  - signal transport round-trip.
- **Sinks:**
  - memory and JSONL read/export, including CSV columns;
  - SQL sinks on PGlite, SQLite and, under the existing HANA test gating, HANA: append, read by window and kind, retention.
- **Completeness (library):** every LLM call path, embedding path, tool dispatch and task end records exactly once, with the right role. Records hold no content: a test feeds distinctive prompt, tool and argument strings and asserts that none appear in any record.
- **No recorder given:** behaviour is identical to today.
