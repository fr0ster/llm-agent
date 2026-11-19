import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  CircuitBreaker,
  FallbackRag,
  InMemoryRag,
  type IQueryEmbedding,
  type IRag,
  type IRagBackendWriter,
  type IRagDecorator,
  type IRetrievalStrategy,
  isRagFilteredDeleter,
  isRagScanner,
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
  const calls: Array<{ k: number; options?: CallOptions }> = [];
  const writer: IRagBackendWriter = {
    upsertRaw: async () => ({ ok: true as const, value: undefined }),
    deleteByIdRaw: async () => ({ ok: true, value: false }),
    upsertPrecomputedRaw: async () => ({ ok: true, value: undefined }),
    upsertManyPrecomputedRaw: async () => ({ ok: true, value: undefined }),
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
    const seen: (CallOptions | undefined)[] = [];
    const strategy: IRetrievalStrategy = {
      name: 'spy',
      retrieve: async (s, qq, k, o) => {
        seen.push(o);
        return s.query(qq, k, o);
      },
    };
    const rag = new StrategyRag({ ...store, writer: () => writer }, strategy);
    const opts = { sessionId: 's' };
    await rag.query(q, 3, opts);
    assert.deepEqual(seen, [opts]);
    assert.deepEqual(await rag.healthCheck(), { ok: true, value: undefined });
    const byId = await rag.getById('a');
    assert.ok(byId.ok && byId.value?.text === 'a');
    assert.equal(rag.writer?.(), writer);
  });

  it('forwards only supported capabilities and preserves their receivers and writer', async () => {
    const { store, writer } = fakeStore([]);
    const strategy = new EmbeddingRetrieval();
    const readOnly = new StrategyRag(store, strategy);
    for (const capability of [
      'list',
      'scan',
      'deleteWhere',
      'writer',
    ] as const) {
      assert.equal(capability in readOnly, false);
    }

    const native = new InMemoryRag();
    const wrapped = new StrategyRag(native, strategy);
    const nativeWriter = wrapped.writer?.();
    assert.ok(nativeWriter);
    assert.ok(
      (await nativeWriter.upsertRaw('id', 'example', { sessionId: 's' })).ok,
    );
    assert.ok(wrapped.list);
    const list = await wrapped.list();
    assert.ok(list.ok);
    assert.deepEqual(
      list.value.records.map((r) => r.id),
      ['id'],
    );
    assert.ok(isRagScanner(wrapped));
    const page = await wrapped.scan();
    assert.ok(page.ok);
    assert.deepEqual(
      page.value.records.map((r) => r.id),
      ['id'],
    );
    assert.ok(isRagFilteredDeleter(wrapped));
    assert.deepEqual(await wrapped.deleteWhere({ sessionId: 's' }), {
      ok: true,
      value: { deleted: 1 },
    });

    const receiver = {
      ...store,
      backendWriter: writer,
      writer() {
        return this.backendWriter;
      },
    };
    const forwarded = new StrategyRag(receiver, strategy).writer?.();
    assert.equal(forwarded, writer);
    assert.equal(forwarded?.upsertPrecomputedRaw, writer.upsertPrecomputedRaw);
    assert.equal(
      forwarded?.upsertManyPrecomputedRaw,
      writer.upsertManyPrecomputedRaw,
    );
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
    const composed = applyRetrievalStrategy(outer, new EmbeddingRetrieval());
    assert.ok(composed instanceof StrategyRag);
    assert.equal(composed.inner, outer);
    assert.equal(applyRetrievalStrategy(composed), composed);
  });

  for (const depth of [2, 3]) {
    describe(`${depth} repeated fallback compositions`, () => {
      const states = ['closed', 'open'] as const;
      const combinations = Array.from({ length: depth }).reduce<
        (typeof states)[number][][]
      >(
        (combinations) =>
          combinations.flatMap((combination) =>
            states.map((state) => [...combination, state]),
          ),
        [[]],
      );

      for (const combination of combinations) {
        it(`runs the strategy once with breakers ${combination.join(', ')} (inner to outer)`, async (t) => {
          const retrieve = t.mock.fn<IRetrievalStrategy['retrieve']>(
            (store, embedding, k, options) =>
              store.query(embedding, k, options),
          );
          const primary = hit('primary', 0.9);
          const strategy = { name: 'spy', retrieve };
          let rag: IRag = new StrategyRag(fakeStore([primary]).store, strategy);
          let expected = primary;

          for (const [index, state] of combination.entries()) {
            const breaker = new CircuitBreaker();
            t.mock.getter(breaker, 'state', () => state);
            const fallback = hit(`fallback-${index + 1}`, 0.9);
            rag = applyRetrievalStrategy(
              new FallbackRag(rag, fakeStore([fallback]).store, breaker),
            );
            if (state === 'open') expected = fallback;
          }

          assert.deepEqual(await rag.query(q, 1), {
            ok: true,
            value: [expected],
          });
          assert.equal(retrieve.mock.callCount(), 1);
        });
      }
    });
  }

  it('suppresses a relocated strategy reached directly on a fallback route', async (t) => {
    const retrieve = t.mock.fn<IRetrievalStrategy['retrieve']>(
      (store, embedding, k, options) => store.query(embedding, k, options),
    );
    const fallback = hit('fallback', 0.9);
    const original = new StrategyRag(fakeStore([fallback]).store, {
      name: 'spy',
      retrieve,
    });
    const innerBreaker = new CircuitBreaker();
    const innerState = t.mock.getter(innerBreaker, 'state', () => 'open');
    const inner = applyRetrievalStrategy(
      new FallbackRag(
        original,
        fakeStore([hit('inner', 0.9)]).store,
        innerBreaker,
      ),
    );
    const outerBreaker = new CircuitBreaker();
    t.mock.getter(outerBreaker, 'state', () => 'open');
    const rag = applyRetrievalStrategy(
      new FallbackRag(inner, original, outerBreaker),
    );

    assert.deepEqual(await rag.query(q, 1), { ok: true, value: [fallback] });
    assert.equal(innerState.mock.callCount(), 0);
    assert.equal(retrieve.mock.callCount(), 1);
  });

  it('finds a strategy and the underlying store through a deep decorator chain', () => {
    const { store } = fakeStore([]);
    const strategy = new EmbeddingRetrieval();
    const wrapped = new StrategyRag(store, strategy);
    const projected = Array.from({ length: 32 }).reduce<IRag>(
      (inner) => ({ ...store, inner }) satisfies IRag & IRagDecorator,
      wrapped,
    );
    assert.equal(hasRetrievalStrategy(projected), true);
    assert.equal(applyRetrievalStrategy(projected, strategy), projected);
    assert.equal(ownBuiltInStore(store, wrapped, projected), projected);
  });

  it('rejects self and multi-store cycles even with a strategy in the chain', () => {
    const { store } = fakeStore([]);
    const strategy = new EmbeddingRetrieval();
    const cyclic = { ...store, inner: store };
    cyclic.inner = cyclic;
    assert.throws(
      () => hasRetrievalStrategy(cyclic),
      /Cycle in RAG decorator chain/,
    );
    const branded = new StrategyRag(cyclic, strategy);
    cyclic.inner = branded;
    assert.throws(
      () => hasRetrievalStrategy(branded),
      /Cycle in RAG decorator chain/,
    );
    assert.throws(
      () => applyRetrievalStrategy(branded, strategy),
      /Cycle in RAG decorator chain/,
    );
    assert.throws(
      () => ownBuiltInStore(store, store, branded),
      /Cycle in RAG decorator chain/,
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
