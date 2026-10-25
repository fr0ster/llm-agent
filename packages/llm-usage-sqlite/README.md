# @mcp-abap-adt/llm-usage-sqlite

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

Append-only usage analytics storage with idempotent inserts by `id`, a complete
JSON record and indexed common columns in `USAGE_RECORDS`.

```ts
import { createSqliteUsageSink } from '@mcp-abap-adt/llm-usage-sqlite';
import { exportRecords } from '@mcp-abap-adt/llm-usage';

const sink = createSqliteUsageSink({ path: 'usage.sqlite' });
await sink.write(records);
for await (const line of exportRecords(sink.read({ from, to, sessionId }), 'csv')) {
  process.stdout.write(line);
}
await sink.deleteOlderThan(cutoffMs);
await sink.close();
```

`read` uses `[from, to)`, optional `kinds` and `sessionId`. Loss evidence is included
by affected-range overlap regardless of its own timestamp or the kinds filter;
global losses are included for session queries. `deleteOlderThan(ms)` deletes by
record timestamp strictly below the epoch-millisecond cutoff and returns the count.
Retention also removes loss evidence at that cutoff; export it first if needed.
Apply `ddl/usage.sql` before use when `autoCreateSchema: false`.
Failed batches may have partially written; retries are safe by id.

Options: required `path` (or `:memory:`), `autoCreateSchema` (default true). Requires Node >= 22.13 with `node:sqlite`; construction fails clearly otherwise. Database opening, DDL, reads, inserts, retention and close all run in a worker thread. Operations are serialized and acknowledged after completion. `capabilityProbe` is a test seam for unsupported runtimes.
