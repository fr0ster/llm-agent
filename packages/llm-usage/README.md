# @mcp-abap-adt/llm-usage

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

Transport-independent usage recording, bounded buffering, loss evidence, memory
and JSONL storage. Contracts come from `@mcp-abap-adt/llm-agent`; no database or
signal bus implementation is required.

```ts
import { createUsageRecorder, directTransport, memorySink } from '@mcp-abap-adt/llm-usage';

const sink = memorySink({ limit: 10000 });
const usage = createUsageRecorder({ transport: directTransport(sink) });
const sessionUsage = usage.with({ sessionId: 'session-1' });
sessionUsage.record({
  kind: 'x.session', context: {}, outcome: 'ok', values: { opened: true },
});
await usage.flush(1000);
for await (const record of sink.read({ from: 0, to: Date.now() + 1 })) {
  console.log(record);
}
const result = await usage.close(1000);
// Inspect result.lost and result.unconfirmed for incomplete delivery.
```

`record` takes a structured clone and never awaits or throws. `with` snapshots
context; explicit record context overrides inherited labels. Record only metadata
and numeric measurements, never prompts, documents, tool arguments or credentials.
`noopRecorder` disables collection.

The recorder defaults to 10,000 ordinary queue slots plus 100 reserved loss slots,
200 records per batch, a 1,000 ms flush interval, a 300,000 ms retry window,
60,000 ms loss windows and at most 1,000 session loss counters. In-flight records
occupy queue slots. Retries use capped exponential backoff and stable record ids.
`stats()` reports buffered records, confirmed deliveries, loss counts by reason
and the last delivery error code. A successful retry clears delivery ambiguity.

Loss evidence uses `x.usage.lost`, one record per session and closed loss window,
with counts by kind, a separate `unconfirmed` count and inclusive affected time
endpoints. Overflowing session counters merge into session `''`. Evidence cannot
report its own loss recursively. Crashes can lose the queue and its evidence.
`close(timeoutMs)` stops acceptance and applies one deadline to draining and
transport shutdown, including hanging writes and sink closes. Its disjoint
counters include generated evidence records. Acknowledgements after the deadline
are ignored. Evidence generated at the deadline may itself be undeliverable.

`directTransport(sink, { batchSize?, flushMs? })` acknowledges only sink writes.
`httpTransport({ url, headers?, fetch?, batchSize?, flushMs? })` POSTs
`{ "schema": 1, "records": [...] }` with JSON content type. The collector must
write idempotently by id before returning 2xx; no response body is required.
Connection refusal is a definite failure; other HTTP failures are conservatively
ambiguous. Transport batch sizes cap each write/request. The recorder controls
flush scheduling; transport `flushMs` optionally delays an outgoing batch before
writing (default: no additional delay).
Custom delivery implementations should reject with `UsageDeliveryError` from
`llm-agent`, using `possiblyDelivered: false` only when storage was never reached.
Unknown errors are ambiguous. `combineSinks(...sinks)` acknowledges all sinks and
classifies a partial write as possibly delivered.

`signalTransport(emitter, source)` and `signalSource(subscriber, source, sink)`
provide **best effort** live fan-out using only signal contracts. The fixed name
is `usage.batch`, and its fixed key is `''`: only the latest batch is retained.
Emission counts as delivery without acknowledging sink completion. Receivers
must subscribe live; missed batches and handler failures are not retried by this
transport. Unsubscribe the source bridge when done.

`memorySink({ limit, evict: true })` evicts oldest entries. With `evict: false`,
an overflowing batch rejects atomically as definitely unwritten. Eviction is a
storage policy, not a recorder delivery failure.
`jsonlFileSink({ path, rotateBytes })` serializes appends, rotates to
`<path>.<timestamp>.<counter>` before a record would cross the byte limit, and
reads all rotations. One record may exceed the limit. Parent directories must
exist. Use one writer per path. Reopening scans existing ids; retained ids consume
memory. Malformed JSON lines are skipped; `sink.stats().skippedLines` counts those
found during the initial scan (available after an operation completes). Appends
separate an unterminated final line from new records. Initialization I/O failures
are retained: reads and close reject with the original error, and writes reject
with `UsageDeliveryError` (`possiblyDelivered: false`, original error in `cause`).
Neither sink implements a durable producer queue.

Readers deduplicate by id. Ordinary records match `[from, to)`, `kinds` and
`sessionId`. Loss records match overlapping affected ranges regardless of their
own timestamp or `kinds`; session queries also include session `''` evidence.
`exportRecords(reader.read(query), 'jsonl' | 'csv')` yields text chunks. CSV uses
fixed columns, flattened common `values.*` loss fields, a JSON cell with all
flattened extension values, and `loss_evidence`.

Custom readers can share the selection helper `selectUsage` and register the
test suite with `await usageReaderConformance(name, factory)`, where the factory
returns a fresh sink implementing `IUsageReader`. The test runner is loaded only
when this helper is called.
