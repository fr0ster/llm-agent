# @mcp-abap-adt/llm-usage-pg

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

Append-only usage analytics storage with idempotent inserts by `id`, a complete
JSON record and indexed common columns in `USAGE_RECORDS`.

```ts
import { createPgUsageSink } from '@mcp-abap-adt/llm-usage-pg';
import { exportRecords } from '@mcp-abap-adt/llm-usage';

const sink = createPgUsageSink({'path: 'usage.sqlite'' if db=='sqlite' else '/* connection options */'});
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

Options extend `pg.PoolConfig` (host, port, database, user, password callback, SSL, connectionString, pool limits and timeouts). `schema` selects an existing schema (default public). `autoCreateSchema` defaults to true and creates the table/indexes, not the database schema. An injected `client` with `query`/`end` can replace the owned pool; it is closed by the sink. Idle pool errors are consumed; `onPoolError` optionally observes them. Tests use PGlite 0.5.10 from the integration lockfile.
