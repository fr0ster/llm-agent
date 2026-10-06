import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IReranker,
  RagError,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import {
  callReranker,
  MAX_THROWN_MESSAGE,
  rerankFailedError,
} from '../rerank-call.js';

const cands: RagResult[] = [{ text: 'a', metadata: {}, score: 1 }];

describe('callReranker', () => {
  it('ok: false → the reranker code and message', async () => {
    const rr: IReranker = {
      rerank: async () => ({
        ok: false,
        error: new RagError('x', 'DECISION_AUTH'),
      }),
    };
    assert.deepEqual(await callReranker(rr, 'q', cands, undefined), {
      ok: false,
      failure: { code: 'DECISION_AUTH', message: 'x' },
    });
  });

  it('a throw → RERANK_THROWN, message capped', async () => {
    const rr: IReranker = {
      rerank: async () => {
        throw new Error('x'.repeat(2000));
      },
    };
    const r = await callReranker(rr, 'q', cands, undefined);
    assert.ok(!r.ok);
    assert.equal(r.failure.code, 'RERANK_THROWN');
    assert.equal(r.failure.message.length, MAX_THROWN_MESSAGE);
    assert.equal(MAX_THROWN_MESSAGE, 500);
  });

  it('a check naming a defect → RERANK_ERROR with that text', async () => {
    const rr: IReranker = { rerank: async (_q, r) => ({ ok: true, value: r }) };
    assert.deepEqual(
      await callReranker(rr, 'q', cands, undefined, () => 'bad'),
      {
        ok: false,
        failure: { code: 'RERANK_ERROR', message: 'bad' },
      },
    );
  });

  it('a success whose check finds nothing → ok', async () => {
    const rr: IReranker = { rerank: async (_q, r) => ({ ok: true, value: r }) };
    assert.deepEqual(
      await callReranker(rr, 'q', cands, undefined, () => undefined),
      { ok: true, value: cands },
    );
  });

  it('rerankFailedError', () => {
    const e = rerankFailedError({ code: 'A', message: 'b' });
    assert.ok(e instanceof RagError);
    assert.equal(e.code, 'RERANK_ERROR');
    assert.equal(e.message, 'rerank failed: A: b');
  });
});
