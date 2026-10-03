import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RagError, type RagResult } from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { RerankHandler } from '../rerank.js';

const results: RagResult[] = [{ text: 't', metadata: {}, score: 0.4 }];

function span() {
  const attrs: Record<string, unknown> = {};
  const s = {
    name: 'rerank',
    setAttribute: (k: string, v: unknown) => {
      attrs[k] = v;
    },
    addEvent() {},
    setStatus() {},
    end() {},
  } as unknown as ISpan;
  return { s, attrs };
}

describe('RerankHandler failure telemetry', () => {
  it('falls back to the original order and records the failure', async () => {
    const steps: Array<[string, unknown]> = [];
    const ctx = {
      ragText: 'q',
      ragResults: { docs: [...results] },
      reranker: {
        rerank: async () => ({
          ok: false,
          error: new RagError(
            'decision rerank failed: DECISION_AUTH',
            'RERANK_ERROR',
          ),
        }),
      },
      options: {
        sessionLogger: {
          logStep: (n: string, d: unknown) => steps.push([n, d]),
        },
      },
    } as unknown as PipelineContext;
    const { s, attrs } = span();
    await new RerankHandler().execute(ctx, {}, s);
    assert.deepEqual(ctx.ragResults.docs, results);
    assert.equal(attrs['docs.rerank_error'], 'RERANK_ERROR');
    assert.equal(steps.length, 1);
    assert.equal(steps[0][0], 'rerank_error');
    assert.deepEqual(steps[0][1], {
      store: 'docs',
      code: 'RERANK_ERROR',
      message: 'decision rerank failed: DECISION_AUTH',
    });
  });

  it('records nothing on success', async () => {
    const ctx = {
      ragText: 'q',
      ragResults: { docs: [...results] },
      reranker: { rerank: async () => ({ ok: true, value: results }) },
      options: undefined,
    } as unknown as PipelineContext;
    const { s, attrs } = span();
    await new RerankHandler().execute(ctx, {}, s);
    assert.equal(attrs['docs.rerank_error'], undefined);
  });
});
