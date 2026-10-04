import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRag, RagResult } from '@mcp-abap-adt/llm-agent';
import {
  applyRetrievalStrategy,
  EmbeddingRetrieval,
} from '../../../retrieval/index.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { RerankHandler } from '../rerank.js';

const hit = (id: string, score: number): RagResult => ({
  text: id,
  metadata: { id },
  score,
});

function fakeStore(results: RagResult[]) {
  const store: IRag = {
    query: async (_q, k) => ({ ok: true, value: results.slice(0, k) }),
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async () => ({ ok: true, value: null }),
  };
  return { store };
}

function span() {
  const s = {
    name: 'rerank',
    setAttribute() {},
    addEvent() {},
    setStatus() {},
    end() {},
  } as unknown as ISpan;
  return { s };
}

describe('RerankHandler precedence', () => {
  it('skips a store with an explicit strategy (embedding included); reranks an unlisted one', async () => {
    const calls: string[] = [];
    const reranker = {
      rerank: async (_q: string, r: RagResult[]) => {
        calls.push(String(r[0]?.text));
        return { ok: true as const, value: r };
      },
    };
    const historyStore = applyRetrievalStrategy(
      fakeStore([]).store,
      new EmbeddingRetrieval(),
    );
    const ctx = {
      ragText: 'q',
      ragResults: { history: [hit('h', 0.5)], docs: [hit('d', 0.5)] },
      ragStores: { history: historyStore, docs: fakeStore([]).store },
      reranker,
      options: undefined,
    } as unknown as PipelineContext;
    await new RerankHandler().execute(ctx, {}, span().s);
    assert.deepEqual(calls, ['d']);
  });
});
