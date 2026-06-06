import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveNeed } from '../need-resolver.js';

describe('resolveNeed', () => {
  it('returns semantic hits from session-memory for the need text', async () => {
    const rag = {
      write: async () => {},
      query: async (text: string, opts?: { k?: number }) => {
        assert.equal(text, 'includes of ZTEST');
        assert.equal(opts?.k, 5);
        return [
          {
            content: 'INCLUDE zinc.',
            metadata: {
              traceId: 'trace-1',
              turnId: 'turn-1',
              stepperId: 'stepper-1',
              task: 'ZINC',
              artifactType: 'code',
              createdAt: '2026-06-06T00:00:00.000Z',
            },
          },
        ];
      },
    } as never;

    const hits = await resolveNeed(rag, 'includes of ZTEST', 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, 'INCLUDE zinc.');
  });

  it('empty when nothing relevant', async () => {
    const rag = {
      write: async () => {},
      query: async () => [],
    } as never;
    assert.deepEqual(await resolveNeed(rag, 'x', 5), []);
  });
});
