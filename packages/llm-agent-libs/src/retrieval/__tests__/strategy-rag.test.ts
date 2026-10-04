import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  FallbackRag,
  InMemoryRag,
  type IQueryEmbedding,
  type IRag,
  type IRetrievalStrategy,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import {
  applyRetrievalStrategy,
  EmbeddingRetrieval,
  hasRetrievalStrategy,
  StrategyRag,
} from '../index.js';
import { ownBuiltInStore } from '../strategy-rag.js';

const hit = (id: string, score: number): RagResult => ({
  text: id,
  metadata: { id },
  score,
});

function fakeStore(results: RagResult[]) {
  const calls: Array<{ k: number; options: unknown }> = [];
  const writer = {
    upsertRaw: async () => ({ ok: true as const, value: undefined }),
  };
  const store: IRag = {
    query: async (_q, k, options) => {
      calls.push({ k, options });
      return { ok: true, value: results.slice(0, k) };
    },
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async (id) => ({
      ok: true,
      value: results.find((r) => r.metadata.id === id) ?? null,
    }),
    writer: () => writer as never,
  };
  return { store, calls, writer };
}
const q = { text: 'q', toVector: async () => [1] } as IQueryEmbedding;

describe('EmbeddingRetrieval', () => {
  it('is store.query(q, k, options)', async () => {
    const { store, calls } = fakeStore([hit('a', 0.9), hit('b', 0.8)]);
    const opts = { sessionId: 's' };
    const r = await new EmbeddingRetrieval().retrieve(store, q, 1, opts);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.text),
      ['a'],
    );
    assert.deepEqual(calls, [{ k: 1, options: opts }]);
  });
});

describe('StrategyRag', () => {
  it('routes query through the strategy and delegates the rest', async () => {
    const { store, writer } = fakeStore([hit('a', 0.9)]);
    const seen: unknown[] = [];
    const strategy: IRetrievalStrategy = {
      name: 'spy',
      retrieve: async (s, qq, k, o) => {
        seen.push(o);
        return s.query(qq, k, o);
      },
    };
    const rag = new StrategyRag(store, strategy);
    const opts = { sessionId: 's' };
    await rag.query(q, 3, opts);
    assert.deepEqual(seen, [opts]);
    assert.deepEqual(await rag.healthCheck(), { ok: true, value: undefined });
    const byId = await rag.getById('a');
    assert.ok(byId.ok && byId.value?.text === 'a');
    assert.equal(rag.writer?.(), writer);
    assert.equal(rag.inner, store);
  });
});

describe('applyRetrievalStrategy / hasRetrievalStrategy', () => {
  it('wraps an explicit embedding strategy too (distinguishable from "not configured")', () => {
    const { store } = fakeStore([]);
    assert.equal(hasRetrievalStrategy(store), false);
    const wrapped = applyRetrievalStrategy(store, new EmbeddingRetrieval());
    assert.notEqual(wrapped, store);
    assert.equal(hasRetrievalStrategy(wrapped), true);
  });

  it('a second application returns the same wrapper', () => {
    const { store } = fakeStore([]);
    const once = applyRetrievalStrategy(store, new EmbeddingRetrieval());
    assert.equal(applyRetrievalStrategy(once, new EmbeddingRetrieval()), once);
  });

  it('sees the brand through a FallbackRag (either order)', () => {
    const { store } = fakeStore([]);
    const inner = applyRetrievalStrategy(store, new EmbeddingRetrieval());
    const outer = new FallbackRag(
      inner,
      new InMemoryRag(),
      new CircuitBreaker({}),
    );
    assert.equal(hasRetrievalStrategy(outer), true);
    assert.equal(
      applyRetrievalStrategy(outer, new EmbeddingRetrieval()),
      outer,
    );
  });
});

describe('ownBuiltInStore', () => {
  const strategy = new EmbeddingRetrieval();
  it('a strategy-wrapped projection over the own store wins (keeps its layers)', () => {
    const own = fakeStore([]).store;
    const projected = new StrategyRag(
      new FallbackRag(own, new InMemoryRag(), new CircuitBreaker()),
      strategy,
    );
    const ownWithStrategy = applyRetrievalStrategy(own, strategy);
    assert.equal(ownBuiltInStore(own, ownWithStrategy, projected), projected);
  });
  it("a strategy-wrapped projection over another agent's store never wins", () => {
    const own = fakeStore([]).store;
    const parent = new StrategyRag(fakeStore([]).store, strategy);
    const ownWithStrategy = applyRetrievalStrategy(own, strategy);
    assert.equal(
      ownBuiltInStore(own, ownWithStrategy, parent),
      ownWithStrategy,
    );
  });
  it('a projection without a strategy, or none, gives the own store', () => {
    const own = fakeStore([]).store;
    assert.equal(ownBuiltInStore(own, own, own), own);
    assert.equal(ownBuiltInStore(own, own, undefined), own);
  });
});
