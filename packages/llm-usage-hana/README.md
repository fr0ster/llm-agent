# @mcp-abap-adt/llm-usage-hana

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

Append-only usage analytics storage with idempotent inserts by `id`, a complete
JSON record and indexed common columns in `USAGE_RECORDS`.

```ts
import { createHanaUsageSink } from '@mcp-abap-adt/llm-usage-hana';
import { exportRecords } from '@mcp-abap-adt/llm-usage';

const sink = createHanaUsageSink({
  host: 'hana.example.com',
  port: 443,
  credential: {
    principal: 'ANALYTICS',
    secret: () => process.env.HANA_PASSWORD ?? '',
  },
});
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

Options: `host`/`port` (443), or an address-only `connectionString` (`hdbsql://host:port`); required `credential: { principal, secret() }`, optional `schema`, `connectTimeout` (30000 ms). TLS and certificate validation are enabled. Credentials resolve at connection time. `autoCreateSchema` defaults to false for HDI deployments; an operator applies the shipped DDL. Setting it to true creates missing tables/indexes with DDL privileges. An injected `client` supports `exec`/`close` and is closed by the sink. Live tests run only with a `VCAP_SERVICES` hana binding, as in the SQL shared-table integration runner; use a dedicated test schema with DDL privileges.

## Wiring and replacement

Connect a sink to producers with
`createUsageRecorder({ transport: directTransport(sink) })` from
`@mcp-abap-adt/llm-usage`, then pass `{ usage: recorder }` in call options.
Keep the recorder and replace its transport or sink, or implement
`IUsageRecorder` to replace collection completely. Close the recorder once at
shutdown and inspect its delivered/lost/unconfirmed counters. A signal transport
is best effort and does not acknowledge storage writes. See the
[usage overview](../../docs/USAGE_ANALYTICS.md) and linked design for guarantees,
loss evidence, content exclusions and the completeness test.
