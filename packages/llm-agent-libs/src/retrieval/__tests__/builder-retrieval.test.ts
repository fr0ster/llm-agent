import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FallbackRag,
  InMemoryRag,
  type IRag,
  type IRagEditor,
  type IRagRegistry,
  type IReranker,
  type IRetrievalStrategy,
  type RagCollectionMeta,
  type RagCollectionScope,
  RagError,
  type RagResult,
  SimpleRagRegistry,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../builder.js';
import { makeLlm } from '../../testing/index.js';
import {
  applyRetrievalStrategy,
  EmbeddingRetrieval,
  hasRetrievalStrategy,
  RerankedRetrieval,
  StrategyRag,
} from '../index.js';

const hit = (id: string, score: number): RagResult => ({
  text: id,
  metadata: { id },
  score,
});

/** A primary store that answers with fixed results and accepts (ignores) writes. */
function primaryStore(results: RagResult[]): IRag {
  const ok = async () => ({ ok: true as const, value: undefined });
  return {
    query: async (_q, k) => ({ ok: true, value: results.slice(0, k) }),
    healthCheck: ok,
    getById: async () => ({ ok: true, value: null }),
    writer: () => ({
      upsertRaw: ok,
      deleteByIdRaw: async () => ({ ok: true as const, value: false }),
    }),
  };
}

function countingReranker() {
  const calls: string[][] = [];
  const reranker: IReranker = {
    rerank: async (_q, results) => {
      calls.push(results.map((r) => r.text));
      return { ok: true, value: results };
    },
  };
  return { reranker, calls };
}

function spyStrategy() {
  const calls: number[] = [];
  const strategy: IRetrievalStrategy = {
    name: 'spy',
    retrieve: (store, q, k, o) => {
      calls.push(k);
      return store.query(q, k, o);
    },
  };
  return { strategy, calls };
}

const q = new TextOnlyEmbedding('q');
const tick = () => new Promise((r) => setImmediate(r));

/** Minimal IRagRegistry that is not a SimpleRagRegistry. */
class PlainRegistry implements IRagRegistry {
  protected readonly entries = new Map<
    string,
    { rag: IRag; editor?: IRagEditor; meta: RagCollectionMeta }
  >();
  private key(name: string, scope: RagCollectionScope = 'global') {
    return `${scope}:${name}`;
  }
  protected changed(): void {}
  register(
    name: string,
    rag: IRag,
    editor?: IRagEditor,
    meta?: Omit<RagCollectionMeta, 'name' | 'editable'>,
  ): void {
    this.entries.set(this.key(name, meta?.scope), {
      rag,
      editor,
      meta: {
        displayName: name,
        ...meta,
        name,
        scope: meta?.scope ?? 'global',
        editable: !!editor,
      },
    });
    this.changed();
  }
  unregister(name: string, scope?: RagCollectionScope): boolean {
    const r = this.entries.delete(this.key(name, scope));
    this.changed();
    return r;
  }
  get(name: string, scope?: RagCollectionScope): IRag | undefined {
    return this.entries.get(this.key(name, scope))?.rag;
  }
  getEditor(name: string, scope?: RagCollectionScope): IRagEditor | undefined {
    return this.entries.get(this.key(name, scope))?.editor;
  }
  list(): readonly RagCollectionMeta[] {
    return [...this.entries.values()].map((e) => e.meta);
  }
  async createCollection(): Promise<never> {
    throw new RagError('not supported');
  }
  async deleteCollection() {
    return { ok: true as const, value: undefined };
  }
  async closeSession() {
    return { ok: true as const, value: undefined };
  }
}

class ListeningRegistry extends PlainRegistry {
  private listener?: () => void;
  setMutationListener(listener: () => void): void {
    this.listener = listener;
  }
  protected override changed(): void {
    this.listener?.();
  }
}

describe('SmartAgentBuilder.withRetrievalStrategy', () => {
  it('wraps the projected store; a query goes through the strategy once', async () => {
    const tools = new InMemoryRag();
    const { strategy, calls } = spyStrategy();
    const handle = await new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setToolsRag(tools)
      .withRetrievalStrategy('tools', strategy)
      .build();
    try {
      const projected = handle.ragStores.tools;
      assert.ok(projected);
      assert.equal(hasRetrievalStrategy(projected), true);
      await projected.query(q, 3);
      assert.deepEqual(calls, [3]);
    } finally {
      await handle.close();
    }
  });

  it('circuit breaker on + a projected strategy → StrategyRag(FallbackRag), one rerank per query', async () => {
    const reg = new SimpleRagRegistry();
    reg.register(
      'docs',
      primaryStore([hit('a', 0.9), hit('b', 0.8)]),
      undefined,
      {
        displayName: 'docs',
        scope: 'global',
      },
    );
    const { reranker, calls } = countingReranker();
    const handle = await new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(reg)
      .withCircuitBreaker()
      .withRetrievalStrategy(
        'docs',
        new RerankedRetrieval(reranker, { storeName: 'docs' }),
      )
      .build();
    try {
      const projected = handle.ragStores.docs;
      assert.ok(projected instanceof StrategyRag);
      assert.ok(projected.inner instanceof FallbackRag);
      assert.ok(
        reg.get('docs', 'global') instanceof FallbackRag,
        'registry not mutated by the strategy',
      );
      await projected.query(q, 1);
      assert.equal(calls.length, 1);
    } finally {
      await handle.close();
    }
  });

  it('a store wrapped before build + circuit breaker → FallbackRag(StrategyRag), no double wrap', async () => {
    const { reranker, calls } = countingReranker();
    const strategy = new RerankedRetrieval(reranker, { storeName: 'tools' });
    const tools = applyRetrievalStrategy(
      primaryStore([hit('a', 0.9), hit('b', 0.8)]),
      strategy,
    );
    const handle = await new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setToolsRag(tools)
      .withCircuitBreaker()
      .withRetrievalStrategy('tools', strategy)
      .build();
    try {
      const projected = handle.ragStores.tools;
      assert.ok(projected instanceof FallbackRag);
      assert.equal(projected.inner, tools);
      assert.equal(hasRetrievalStrategy(projected), true);
      await projected.query(q, 1);
      assert.equal(calls.length, 1);
    } finally {
      await handle.close();
    }
  });

  it('circuit open with a non-empty fallback: FallbackRag(StrategyRag) bypasses the reranker, StrategyRag(FallbackRag) reranks the fallback', async () => {
    const tools = countingReranker();
    const docs = countingReranker();
    const toolsStore = applyRetrievalStrategy(
      primaryStore([hit('primary-tool', 0.9)]),
      new RerankedRetrieval(tools.reranker, { storeName: 'tools' }),
    );
    const reg = new SimpleRagRegistry();
    reg.register('docs', primaryStore([hit('primary-doc', 0.9)]), undefined, {
      displayName: 'docs',
      scope: 'global',
    });
    const handle = await new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(reg)
      .setToolsRag(toolsStore)
      .withCircuitBreaker({ failureThreshold: 1 })
      .withRetrievalStrategy(
        'docs',
        new RerankedRetrieval(docs.reranker, { storeName: 'docs' }),
      )
      .build();
    try {
      const pTools = handle.ragStores.tools;
      const pDocs = handle.ragStores.docs;
      assert.ok(pTools instanceof FallbackRag);
      assert.ok(pDocs instanceof StrategyRag);
      // Writes fan out to the fallback too, so it is not empty once open.
      await pTools.writer?.()?.upsertRaw('t1', 'fallback tool', { id: 't1' });
      await pDocs.writer?.()?.upsertRaw('d1', 'fallback doc', { id: 'd1' });
      await tick();
      // The embedder breaker is the one guarding the RAG stores.
      const embedderBreaker = handle.circuitBreakers[1];
      embedderBreaker.recordFailure();
      assert.equal(embedderBreaker.state, 'open');

      const rt = await pTools.query(new TextOnlyEmbedding('fallback tool'), 1);
      assert.ok(rt.ok);
      assert.deepEqual(
        rt.value.map((r) => r.text),
        ['fallback tool'],
      );
      assert.equal(tools.calls.length, 0, 'reranker bypassed');

      const rd = await pDocs.query(new TextOnlyEmbedding('fallback doc'), 1);
      assert.ok(rd.ok);
      assert.deepEqual(
        rd.value.map((r) => r.text),
        ['fallback doc'],
      );
      assert.deepEqual(
        docs.calls,
        [['fallback doc']],
        'fallback reranked once',
      );
    } finally {
      await handle.close();
    }
  });

  it('custom registry with setMutationListener: a collection registered after build is projected and wrapped', async () => {
    const reg = new ListeningRegistry();
    const handle = await new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(reg)
      .withRetrievalStrategy('kb', new EmbeddingRetrieval())
      .build();
    try {
      const kb = new InMemoryRag();
      reg.register('kb', kb, undefined, { displayName: 'kb', scope: 'global' });
      const projected = handle.ragStores.kb;
      assert.ok(projected instanceof StrategyRag);
      assert.equal(projected.inner, kb);
      assert.equal(reg.get('kb', 'global'), kb, 'registry not mutated');
    } finally {
      await handle.close();
    }
  });

  it('custom registry without setMutationListener: a collection registered after build is not projected, nothing throws', async () => {
    const reg = new PlainRegistry();
    const handle = await new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(reg)
      .withRetrievalStrategy('kb', new EmbeddingRetrieval())
      .build();
    try {
      reg.register('kb', new InMemoryRag(), undefined, {
        displayName: 'kb',
        scope: 'global',
      });
      assert.equal(handle.ragStores.kb, undefined);
    } finally {
      await handle.close();
    }
  });
});
