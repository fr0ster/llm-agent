# Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** A transport-agnostic usage analytics contract in `@mcp-abap-adt/llm-agent`, with:
- replaceable recorder, transport and sink implementations in new packages;
- complete instrumentation of every physical LLM request, embedding request, MCP dispatch and task end in the library.

**Architecture.**
- **Contract and hooks.** The contract and the instrumentation hooks live in `@mcp-abap-adt/llm-agent`.
- **Who records what.** Providers record at their physical requests, inside their own retry and chunk loops. The MCP client records per internal request. TaskBoard records task ends.
- **Context.** Context and operation metadata travel in call options (`usage`, `usageOp`) and in the worker input (`usage`).
- **Implementations.** `@mcp-abap-adt/llm-usage` holds the recorder, the transports and the simple sinks. `llm-usage-pg`, `llm-usage-hana` and `llm-usage-sqlite` hold the database sinks.

**Tech Stack:** TypeScript monorepo, `node --test` with `tsx` (dialogue tests with `--test-concurrency=1`), Biome, Changesets (independent versions).

**Spec:** `docs/superpowers/specs/2026-10-25-usage-analytics-design.md` (merged, #356). Read it in full; this plan does not restate its rules.

## Global Constraints

- **Additive only:** no breaking change to existing public types. New fields are optional. Without a recorder, behaviour is identical to today.
- **Producer safety:** `record` never throws or awaits. Instrumentation never changes a call's result, error or timing beyond the recording itself.
- **No content in records:** no prompt, message, document, tool argument or result text, and no credentials or tokens.
- **Exactly one record per physical operation**, for every outcome: ok, returned error, thrown error, abort, early stream close.
- **Release:** a changeset per changed package (new packages start at 1.0.0). Versions are bumped in the version PR, not here.
- **Package metadata:** new packages follow the existing package pattern (license files, README with badges, build, clean, publish and typecheck lists, as in `llm-signals`).

## Review Focus

1. **Provider retry closures.** A 429 then success inside `withThrottleRetry` must give two `llm.call` records. Owned by Task 4.
2. **Stream early close.** A consumer that breaks out of the async iterator must still produce a record with `closedEarly: true`. Owned by Task 4.
3. **Concurrent tasks.** Two tasks running at once must not swap `taskId` in their records: no shared mutable context. Owned by Task 5.
4. **Shutdown with hanging transports.** `close(timeoutMs)` must resolve by its deadline. Owned by Task 2.
5. **Content leak via error codes.** `errorCode` must be a code, never a provider message body. Owned by Tasks 4 and 6.

---

### Task 1: Contract, hooks and option fields (`packages/llm-agent`)

**Files:**
- Create: `packages/llm-agent/src/interfaces/usage.ts` (types exactly as the spec's Contract section, plus `UsageOperation` and `UsageDeliveryError`).
- Create: `packages/llm-agent/src/usage/hooks.ts`.
- Modify:
  - `packages/llm-agent/src/interfaces/types.ts`: `CallOptions` gains `usage?: IUsageRecorder; usageOp?: UsageOperation`;
  - `packages/llm-agent/src/types.ts`: the provider-level `LLMCallOptions` gains the same two fields;
  - `packages/llm-agent/src/interfaces/subagent.ts`: `ISubAgentInput` gains `usage?: IUsageRecorder`;
  - the barrels.
- Test: `packages/llm-agent/src/interfaces/__tests__/usage.typecheck.ts` (added to `tsconfig.typecheck.json`) and `packages/llm-agent/src/usage/__tests__/hooks.test.ts`.

**Interfaces (Produces):**
- **The spec's types:** `USAGE_SCHEMA_VERSION`, `UsageContext`, `UsageRecord`, `UsageInput`, `IUsageRecorder`, `IUsageTransport`, `IUsageSink`, `IUsageControl`, `UsageOperation`, `UsageDeliveryError`.
- **`noopUsageRecorder: IUsageRecorder`**, inline, with no dependency.
- **`resolveRecorder(opts?: { usage?: IUsageRecorder }, bound?: IUsageRecorder): IUsageRecorder`.** Precedence: `opts.usage`, else the construction-bound `bound`, else `noopUsageRecorder`. All hooks below take an optional `bound` argument and use this.
- **`startOperation(opts?: CallOptions): UsageOperation`.** It returns `opts.usageOp` if present, else a new operation (fresh `operationId`, a fresh `seq` counter, zeros, `''`).
- **`withOuterAttempt(op, n)`, `withProviderAttempt(op, n)`, `withChunk(op, index, total)`** return copies that share `seq`. `withChunk` appends `"<index+1>/<total>"` to `chunkPath`, with `>` between levels.
- **`reportLlmRequest(opts: CallOptions | undefined, op: UsageOperation, facts): void`.**
  - `facts` = `{ provider, model, stream, outcome, errorCode?, inputTokens?, outputTokens?, cachedInputTokens?, tokensSource, durationMs, firstTokenMs?, throttledMs?, closedEarly?, granularity, retriesVisible }`.
  - It takes `physicalSeq = op.seq.next()` and calls `(opts?.usage ?? noopUsageRecorder).record({ kind: 'llm.call', … })`.
- **`reportEmbeddingRequest(opts, op, facts)`** works the same way for `embedding.call`.
- **`beginLlmRequest(opts, op, base, bound?): LlmRequestHandle`.** The handle is `{ end(facts: Partial<facts> & { outcome }): void; firstToken(): void }`. `end` is idempotent; only the first call records.
  - **Non-streaming** physical attempt: begun and ended inside the retry closure, with `end` in `finally`.
  - **Streaming:**
    - An attempt that fails before the stream is open is begun and ended inside the retry closure (outcome `error`).
    - The successful attempt's handle is returned with the open response and ended by the provider's stream generator in its `finally`: completion → `ok` with the usage the provider accumulated across the stream's events; error → `error`; consumer `return()` → `aborted` with `closedEarly: true`.
  - `errorCode` comes from the error's `code` or `status` only.
- **`beginEmbeddingRequest(opts, op, base, bound?)`:** the same for `embedding.call`.

- [ ] **Step 1: Failing tests.**
  - **Types:** valid inputs per kind compile; a missing kind field or a wrong field fails (`// @ts-expect-error`); `x.*` values reject objects.
  - **Hooks:**
    - `startOperation` reuses `usageOp`;
    - coordinates compose (`withChunk` twice gives `'2/3>1/4'`; copies share `seq`);
    - `beginLlmRequest`: `end` is idempotent; firstToken timing;
    - `resolveRecorder` precedence: per-call override, construction-bound, no-op;
    - `errorCode` never contains the error message;
    - without `opts.usage` nothing throws.
- [ ] **Steps 2–5:** run and see the tests fail → implement → run and see them pass (`npm test -w @mcp-abap-adt/llm-agent`, `npx tsc -p tsconfig.typecheck.json --noEmit`) → commit `feat(usage): contract, hooks and option fields`.

### Task 2: Recorder, transports and simple sinks (`packages/llm-usage`, new)

**Files:**
- Create: the `packages/llm-usage/` package (as `packages/llm-signals`), with `src/recorder.ts`, `src/transports.ts`, `src/sinks.ts`, `src/read.ts`, `src/index.ts` and tests.
- Modify: the root build, clean, publish and typecheck lists; `package-lock.json` via `npm install`.

**Interfaces:**
- **Consumes:** Task 1.
- **`createUsageRecorder(opts): IUsageRecorder & IUsageControl`.**
  - `opts`: `{ transport: IUsageTransport; queueLimit = 10000; batchSize = 200; flushMs = 1000; retryWindowMs = 300000; lossWindowMs = 60000; reservedLossCapacity = 100; maxLossCounters = 1000; now?; idFactory?; instanceId? }`.
  - **Behaviour:** the spec's Rules:
    - snapshots via `structuredClone`;
    - the bounded queue with reserved loss capacity;
    - retries with backoff inside `retryWindowMs`;
    - classification by `UsageDeliveryError.possiblyDelivered`, with unknown errors counted as unconfirmed;
    - loss windows with `affectedFrom` and `affectedTo`, closed-window emission, ids `lost:<instanceId>:<sessionId>:<windowStart>`, an unconfirmed count, and no recursion;
    - `close(timeoutMs)` with a single deadline, returning disjoint `{delivered, unconfirmed, lost}`;
    - `stats()`.
- **`directTransport(sink, { batchSize?, flushMs? })`** and **`httpTransport({ url, headers?, fetch? })`**.
  - The HTTP transport POSTs `{"schema":1,"records":[…]}` and treats a 2xx as written.
  - It classifies failures: connection refused before the body was sent → `possiblyDelivered: false`; anything else → `true`.
- **`signalTransport(emitter: ISignalEmitter<UsageSignals>, source: string)`** and **`signalSource(subscriber, source, sink): Unsubscribe`.**
  - Best effort; one fixed key; documented in the README.
  - `UsageSignals = { 'usage.batch': { records: UsageRecord[] } }`. It depends only on the signal contracts in `@mcp-abap-adt/llm-agent`.
- **`noopRecorder`**, a re-export of `noopUsageRecorder`, and **`httpTransport({ url, headers?, fetch?, batchSize?, flushMs? })`**, matching the design's options.
- **`memorySink({ limit, evict = true })`.** With `evict: false`, a full sink rejects batches with `UsageDeliveryError(..., false)`.
- **`jsonlFileSink({ path, rotateBytes })`** and **`combineSinks(...sinks)`.** `combineSinks` reports a partial write as `possiblyDelivered: true`.
- **Reader contract (exported from `llm-usage`).**
  - `UsageQuery = { from: number; to: number; kinds?: string[]; sessionId?: string }`.
  - `IUsageReader { read(q: UsageQuery): AsyncIterable<UsageRecord> }`.
  - **Selection rule, implemented by every reader:**
    - ordinary records match by `at` in `[from, to)`, `kinds` and `sessionId`;
    - `x.usage.lost` records match when their `affectedFrom`/`affectedTo` range overlaps `[from, to)`, regardless of `kinds` and of their own `at`;
    - with `sessionId`, loss records of that session and of session `''` are both included;
    - results are deduplicated by id.
- **`exportRecords(records: AsyncIterable<UsageRecord>, 'jsonl' | 'csv')`.** CSV gets fixed columns, flattened `values.*` and a `loss_evidence` column.
- **`usageReaderConformance(name, factory)`:** a shared test suite for the selection rule, run by the memory, JSONL and all database readers.

- [ ] **Step 1: Failing tests** (all from the spec's Validation, "Recorder", "Transports" and the memory and JSONL "Sinks" items):
  - `record` never throws, even with a throwing transport;
  - mutation after `record` does not reach the sink;
  - the queue stays bounded;
  - each loss reason yields one `x.usage.lost` with the right session, range and counts, also when its delivery is retried;
  - a late loss across a window boundary has `affectedFrom` in the earlier window;
  - `close` with a never-resolving `send` and sink `close` resolves by its deadline with the right counters;
  - a lost HTTP acknowledgement and a partial `combineSinks` write count as unconfirmed;
  - classification through custom transports and sinks;
  - signal transport round trip and documented loss;
  - memory and JSONL idempotence, reads, CSV columns and rotation;
  - `usageReaderConformance` passes for memory and JSONL: a late loss record outside the window but overlapping it is included; `''` losses are included for a session query; a `kinds` filter does not drop loss evidence.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(llm-usage): recorder, transports and simple sinks`.

### Task 3: Library wrappers, options and propagation (`packages/llm-agent`, `packages/llm-agent-libs`)

**Files:**
- Modify:
  - `packages/llm-agent/src/resilience/retry-embedder.ts`: `RetryEmbedder` and `RetryBatchEmbedder` set `withOuterAttempt`;
  - `packages/llm-agent/src/resilience/batch-chunking-embedder.ts`: `withChunk` per chunk;
  - `packages/llm-agent-libs/src/resilience/retry-llm.ts`: `withOuterAttempt`; streams re-entered per attempt;
  - `packages/llm-agent-libs/src/agent-request-options.ts`: `normalizeRequestOptions` keeps the caller's `usage` and `usageOp`;
  - `packages/llm-agent-libs/src/adapters/llm-adapter.ts`: `LlmAdapter.chat` and `streamChat` copy `usage` and `usageOp` from the incoming `CallOptions` into the `LLMCallOptions` they build for the provider (they currently rebuild the options and would drop them);
  - `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`, `DirectLlmSubAgent` and every other worker adapter: forward `input.usage` into the call options they build;
  - every library component that builds call options for an LLM, embedder or MCP call (RAG indexing and query, tool vectorization, classifier, summarizer, translator, query expander, finalizer, step reviewer, tool loop, coordinator, mixed tool-call handler): pass `usage` on, narrowed with `role` where the component knows it (use the existing `LlmComponent` names).
- **Each wrapper** creates the operation with `startOperation(opts)` when entered, and forwards `{ ...opts, usageOp: <copy with its coordinate> }`.
- Test: `packages/llm-agent-libs/src/__tests__/usage-propagation.test.ts`.

**Interfaces:** consumes Task 1. Produces no new exports.

- [ ] **Step 1: Failing tests:**
  - every listed component forwards `usage`, checked with a recording fake `ILlm`, embedder and MCP client that read `opts.usage`;
  - a call through `LlmAdapter` reaches a real provider package (over mocked HTTP) with `usage` and `usageOp` intact;
  - `normalizeRequestOptions` keeps a caller recorder;
  - the coordinates set by `RetryLlm`, `RetryBatchEmbedder` and `BatchChunkingEmbedder` nest correctly: three outer chunks × two outer attempts, with a fake provider recording the `usageOp` it receives.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): propagate recorder and operation through the library`.

### Task 4: Provider instrumentation (LLM and embedding packages)

**Files:**
- **LLM base:** `packages/llm-agent/src/llm/base-llm-provider.ts`. `withThrottleRetry` gains an optional usage argument `{ opts, op, base, bound }`. For each physical attempt it calls `beginLlmRequest` with `withProviderAttempt(op, n)`. A failed attempt is ended inside the closure. For non-streaming calls the successful attempt is ended there too. For streaming calls the successful attempt's handle is returned with the response, and the provider's stream generator ends it in `finally`.
- **Construction-bound recorder:** each provider's config gains `usage?: IUsageRecorder`, used as `bound`.
- **Stream token accumulation.** Each provider accumulates usage across its stream events, for example Anthropic input tokens in `message_start` and output tokens in `message_delta`. It ends the handle with the accumulated counts. On an error or an early close, the counts known so far are recorded, with `tokensSource: 'provider'` only for counts the provider actually sent.
- **LLM providers:** `packages/openai-llm`, `packages/anthropic-llm`, `packages/sap-aicore-llm`, `packages/deepseek-llm`, `packages/ollama-llm`. Map provider usage to `inputTokens`, `outputTokens` and `cachedInputTokens` with `tokensSource: 'provider'`. Where a provider gets no usage: `'unknown'`. Providers that do not go through `withThrottleRetry` call the hooks directly.
- **Embedders:** `packages/openai-embedder`, `packages/ollama-embedder`, `packages/sap-aicore-embedder` (foundation and orchestration). Record each physical request, inside their chunk and retry loops, with that request's exact provider total.
  - Remove the per-item token allocation from the data that goes into records. Existing return values are unchanged.
- **SDK-delegating paths** (SAP orchestration): disable SDK retries where the SDK allows it; otherwise record per SDK call with `granularity: 'sdk-call'` and `retriesVisible: false`.
- Test: each package's tests with a mocked HTTP layer (`fetch`, or the SDK client stub the package already uses).

**Interfaces:** consumes Tasks 1 and 3.

- [ ] **Step 1: Failing tests per package:**
  - ok with provider usage;
  - a returned error, a thrown error, an abort;
  - a 429 then success: two records with `providerAttempt` 0 and 1 and the same `operationId`;
  - stream ok, stream error, and an early `break` (`closedEarly`);
  - a 429 followed by a successful stream with an early `break`: exactly two records (error, then aborted with `closedEarly`);
  - Anthropic stream with input tokens in `message_start` and output tokens in `message_delta`: the record carries both exact counts; on an early close after `message_start`, the input count is kept and the output count is absent;
  - the construction-bound recorder is used without call options, and a per-call `usage` overrides it;
  - **nested coordinates (OpenAI embedder, real package, mocked HTTP):**
    - `BatchChunkingEmbedder` over 3 outer chunks; `RetryBatchEmbedder` retrying the third chunk once; the provider splitting each outer chunk into 2 requests and getting one 429 on the first request of the last outer attempt;
    - expected: the exact list of records (`chunkPath`, `outerAttempt`, `providerAttempt`, outcome);
    - every `(operationId, physicalSeq)` is unique;
    - the failed last chunk's records carry `outcome: 'error'`;
  - **embeddings:** a batch split by the provider into chunks gives one record per request, with exact totals (5 tokens over 3 items stay 5);
  - `errorCode` without message text;
  - no recorder: unchanged results.
- [ ] **Steps 2–5:** fail → implement → pass (each package's tests) → commit `feat(usage): record physical requests in LLM and embedding providers`.

### Task 5: Tasks, dialogue and worker context (`packages/llm-agent-libs`)

**Files:**
- Modify:
  - `packages/llm-agent-libs/src/coordinator/dialogue/task-board.ts`: at each terminal transition, `record({ kind: 'task', … })` through the board's recorder narrowed with `{ taskId, role: <worker> }`. Pass the narrowed recorder in `ISubAgentInput.usage`;
  - `dialogue-session.ts`: `DialogueSessionOptions.usage?: IUsageRecorder` as the base. Each turn narrows it with `turnId` and passes it in the planner's call options and to TaskBoard.
- Timing and ids follow the spec's rules:
  - stopped while queued: `queuedMs` set, no `runMs`;
  - restore-interrupted: once, `endKnown: false`, id `task:<boardId>:<taskId>:interrupted`, where `boardId` = the dialogue session id;
  - already-terminal restored tasks: not recorded.
- Test: `packages/llm-agent-libs/src/coordinator/dialogue/__tests__/usage.test.ts` (`--test-concurrency=1`).

**Interfaces:** consumes Tasks 1 and 3.

- [ ] **Step 1: Failing tests:**
  - a task record per terminal state (done, failed, stopped while queued, stopped while running);
  - restore-interrupted recorded once, with a stable id, and two sessions with board-local `t1` do not collide;
  - **two concurrent tasks:** each LLM record carries its own `taskId` (fake workers that call an LLM);
  - planner LLM records carry the `turnId`;
  - no `usage` given: unchanged behaviour.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): task records and dialogue context`.

### Task 6: MCP dispatch instrumentation (`packages/llm-agent-mcp`, tool cache)

**Files:**
- Modify:
  - `packages/llm-agent-mcp/src/client.ts`, `MCPClientWrapper`: the existing `callTool(toolCall: ToolCall, signal?: AbortSignal)` gains an optional third parameter `usageOpts?: { usage?: IUsageRecorder }`, and its config gains `usage?` as the construction-bound recorder. Existing calls are unchanged. Record one `tool.call` around each `performCall` request: the first try, after a reconnect, after a session reset. Record around each embedded-handler execution (`embedded: true`). Set `transportOutcome` and `toolOutcome` from `isError`, and byte sizes from the serialized request and response lengths, never their text;
  - `packages/llm-agent-mcp/src/adapter.ts`, `McpClientAdapter`: forward `CallOptions.usage`;
  - the tool-call cache in `packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts`: a cache hit records `dispatched: false`.
- Test: `packages/llm-agent-mcp/src/__tests__/usage.test.ts`, plus a tool-loop test.

**Interfaces:** consumes Task 1.

- [ ] **Step 1: Failing tests:**
  - one record per request, including a reconnect retry (two records);
  - an embedded handler: ok, throw, abort, `isError`;
  - a cache hit gives `dispatched: false`;
  - tool argument and result strings never appear in records;
  - no recorder: unchanged, and existing two-argument `callTool` callers still compile and work;
  - construction-bound versus per-call recorder.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): record MCP dispatches`.

### Task 7: Database sinks (`llm-usage-pg`, `llm-usage-hana`, `llm-usage-sqlite`, new)

**Files:**
- Create three packages, following the pattern of `pg-vector-rag` and `hana-vector-rag` for DDL, connection options and HANA test gating.
  - Each exports `create<Pg|Hana|Sqlite>UsageSink(opts): IUsageSink & IUsageReader & { deleteOlderThan(ms: number): Promise<number> }`. They use the reader contract and selection rule from Task 2 (`llm-usage` as a peer dependency for the types and the conformance suite in tests).
  - Each ships its DDL (`ddl/usage.sql`).
- **Table `USAGE_RECORDS`:**
  - columns `id` (primary key), `schema_version`, `at`, `kind`, `session_id`, `user_id`, `turn_id`, `task_id`, `role`, `destination`, `outcome`, `record_json`;
  - indexes on `at`, `session_id` and `kind`;
  - inserts ignore a duplicate `id`.
- **`autoCreateSchema`:** default on for PG and SQLite, off for HANA.
- **SQLite:**
  - `node:sqlite` in a `worker_threads` worker. The main thread posts batches and awaits acknowledgements.
  - The capability check at construction requires Node ≥ 22.13 and throws `Error('llm-usage-sqlite requires node:sqlite (Node >= 22.13)')` otherwise.
- **Dependencies:** each package depends only on `@mcp-abap-adt/llm-agent` and `@mcp-abap-adt/llm-usage` (peers) and its own driver.

- [ ] **Step 1: Failing tests** (PGlite for pg; SQLite with a temp file; HANA under the existing env gating):
  - idempotent writes;
  - `usageReaderConformance` passes (loss overlap, `''` losses, kinds filter);
  - retention;
  - a missing table with `autoCreateSchema` off gives a clear error;
  - SQLite writes run off the main thread (assert the main thread is not blocked during a large batch);
  - SQLite rejected on an unsupported runtime (inject the capability probe).
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): PostgreSQL, HANA and SQLite sinks`.

### Task 8: Completeness, content and docs

**Files:**
- Create: `packages/llm-agent-libs/src/__tests__/usage-completeness.test.ts`.
  - It enumerates the spec's call paths with real provider packages over mocked HTTP. It asserts exactly one record per physical operation for every outcome case the spec lists.
  - It also injects distinctive prompt, document, argument and result strings and asserts that none appear in any serialized record.
- Modify: package READMEs (contract in llm-agent, how to inject, replace all or part, delivery and loss semantics, the best-effort signal transport); `docs/` overview page linking the spec; changesets (minor for changed packages, new packages at 1.0.0).

- [ ] **Step 1:** Write the completeness and content test and run it. It passes only if Tasks 3–6 covered every path. Fix gaps in the owning package, not in the test.
- [ ] **Step 2:** Docs and changesets. Run `npm run build`, `npx tsc -p tsconfig.typecheck.json --noEmit` and the test scripts of all changed packages. Commit `test(usage): completeness and content; docs and changesets`.
