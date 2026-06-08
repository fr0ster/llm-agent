import assert from 'node:assert/strict';
import { test } from 'node:test';
import { establishTargetState } from '../target-state.js';

test('establishTargetState forwards options to embedder.embed', async () => {
  const seen: unknown[] = [];
  const embedder = {
    embed: async (_t: string, o?: unknown) => {
      seen.push(o);
      return { vector: [1, 0, 0] };
    },
  };
  const evaluator = {
    send: async () => ({ kind: 'content' as const, content: 'Goal: X' }),
  };
  const opts = { trace: { traceId: 'r1' } };
  await establishTargetState(
    { evaluator, embedder } as never,
    'do X',
    { strategy: 'auto', distanceThreshold: 0.7 },
    opts as never,
  );
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], opts);
  assert.deepEqual(seen[1], opts);
});
