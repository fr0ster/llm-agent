import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UsageRecord } from '@mcp-abap-adt/llm-agent';
import { exportRecords, USAGE_CSV_COLUMNS } from './read.js';

test('JSONL and CSV export preserve reads and creations while legacy records stay valid', async () => {
  const legacy: UsageRecord = {
    schema: 1,
    id: 'old',
    at: 1,
    kind: 'llm.call',
    context: {},
    outcome: 'ok',
    operationId: 'op',
    physicalSeq: 0,
    outerAttempt: 0,
    providerAttempt: 0,
    granularity: 'request',
    retriesVisible: true,
    provider: 'test',
    model: 'test-model',
    stream: false,
    tokensSource: 'provider',
    durationMs: 0,
  };
  const cached: UsageRecord = {
    ...legacy,
    id: 'new',
    cachedInputTokens: 9,
    cacheCreationInputTokens: 5,
  };
  async function* source() {
    yield legacy;
    yield cached;
  }
  const jsonl: string[] = [];
  for await (const row of exportRecords(source(), 'jsonl')) jsonl.push(row);
  assert.deepEqual(
    jsonl.map((row) => JSON.parse(row)),
    [legacy, cached],
  );
  const csv: string[] = [];
  for await (const row of exportRecords(source(), 'csv')) csv.push(row);
  for (const [key, value] of [
    ['cachedInputTokens', 9],
    ['cacheCreationInputTokens', 5],
  ] as const) {
    const index = USAGE_CSV_COLUMNS.indexOf(key);
    assert.ok(index >= 0);
    assert.equal(csv[1].trim().split(',')[index], '""');
    assert.equal(csv[2].trim().split(',')[index], `"${value}"`);
  }
});
