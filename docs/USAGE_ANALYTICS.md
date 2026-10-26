# Usage analytics

Usage analytics records metadata for physical LLM requests, embedding requests,
MCP dispatches (including embedded handlers and cache hits), and terminal tasks.
The [design](superpowers/specs/2026-10-25-usage-analytics-design.md) defines the
contract, completeness requirements and delivery semantics.

```ts
import { createUsageRecorder, directTransport, memorySink } from '@mcp-abap-adt/llm-usage';

const sink = memorySink({ limit: 10000 });
const usage = createUsageRecorder({ transport: directTransport(sink) });
const scoped = usage.with({ sessionId: 'session-1', userId: 'user-1' });
await agent.process('Hello', { usage: scoped });
const shutdown = await usage.close(1000);
if (shutdown.lost || shutdown.unconfirmed) console.error('Incomplete usage delivery', shutdown);
```

Pass `usage` in call options, worker input or dialogue-session options. Providers
and the MCP wrapper also accept a construction-bound recorder. Per-call recorders
take precedence; omitting both uses a no-op. Task and turn labels are scoped with
`with(context)`, so concurrent workers retain their own identities.

The dependency-free contract lives in
[`llm-agent`](../packages/llm-agent/README.md). Replace the entire recorder by
implementing `IUsageRecorder`, or keep
[`llm-usage`](../packages/llm-usage/README.md) and replace only its
`IUsageTransport` or `IUsageSink`. Built-in sinks include memory, JSONL,
[`PostgreSQL`](../packages/llm-usage-pg/README.md),
[`HANA`](../packages/llm-usage-hana/README.md) and
[`SQLite`](../packages/llm-usage-sqlite/README.md). Use `directTransport(sink)`
to wire any sink into the recorder; use `httpTransport` for a collector that
writes idempotently before returning 2xx. `combineSinks` requires every sink to
acknowledge the write.

Each retry is a separate physical record. `operationId` and `physicalSeq`
identify requests; outer/provider attempts and `chunkPath` describe nesting.
Provider token counts remain exact request totals. Unknown usage stays unknown.
Streams record completion, failure, cancellation and early consumer close.
SDK calls with hidden retries use `granularity: 'sdk-call'` and
`retriesVisible: false`; supported SAP orchestration paths disable SDK retries.

Delivery is at least once while the process lives and storage recovers within
the retry window. Sinks deduplicate by record id. The bounded queue reports
overflow, retry expiry and shutdown losses as `x.usage.lost` when possible.
Loss evidence can itself be lost, and crashes can lose both queued records and
evidence. Delivered records are exact; a missing loss record cannot prove
completeness. `close(timeoutMs)` has one deadline and returns disjoint delivered,
lost and unconfirmed counts. Unknown delivery errors, lost acknowledgements and
partial fan-out writes are unconfirmed until a successful retry resolves them.
`stats().unconfirmed` counts both buffered ambiguous records and records given
up while ambiguous; after `close()` it equals the returned `unconfirmed`.
Custom implementations use `UsageDeliveryError(..., false)` only for a batch
known never to have reached storage.

Signal transport is best effort: it emits `usage.batch` under one fixed key,
retains only the latest batch, and counts emission as delivery without waiting
for storage. Subscribers must consume live; it is suitable when loss is acceptable.

Readers select ordinary records in `[from, to)` and always include overlapping
loss evidence, even with a kind filter. Session queries include global session
`''` loss evidence. Exports deduplicate by id and support JSONL and CSV.

Records contain only the listed metadata, timings and counts. Prompts, documents,
tool arguments, results, credentials and provider error bodies are excluded.
Custom labels and extension values must also remain free of content.

The [completeness suite](../packages/llm-agent-libs/src/__tests__/usage-completeness.test.ts)
uses real OpenAI LLM and embedding packages over mocked HTTP, real library
components and MCP boundaries, and distinctive content sentinels. Run it with
`node --import tsx/esm --test --test-concurrency=1 packages/llm-agent-libs/src/__tests__/usage-completeness.test.ts`.

Each `llm.call` records its request shape: message counts and character counts per role,
plus total `inputMessages` and `inputChars`, and `toolDefs` and `toolDefsChars` for the
tool definitions actually sent. Providers measure after their payload filtering, including
assistant tool-call names and arguments only when sent. Characters use UTF-16
`string.length`; tool definition characters use `JSON.stringify(tools).length`.
These sizes are present on retries, errors and early stream closes, independently of
token availability. No message content or tool definitions are stored in usage records.
