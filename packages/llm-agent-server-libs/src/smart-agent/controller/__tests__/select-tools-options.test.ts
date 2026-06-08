import assert from 'node:assert/strict';
import { test } from 'node:test';

test('a selectTools wired over toolsRag.query forwards options', async () => {
  const seen: unknown[] = [];
  const toolsRag = {
    query: async (_t: string, _k?: number, o?: unknown) => {
      seen.push(o);
      return [];
    },
    lookup: () => undefined,
  };
  const selectTools = (query: string, k?: number, options?: unknown) =>
    toolsRag.query(query, k, options);
  await selectTools('x', 5, { trace: { traceId: 'r1' } });
  assert.deepEqual(seen[0], { trace: { traceId: 'r1' } });
});
