import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  CircuitBreaker,
  FallbackRag,
  type ILlm,
  InMemoryRag,
  type IRag,
  type IRagDecorator,
  type IRagEditor,
  type IRagRegistry,
  type IReranker,
  type IRetrievalStrategy,
  type RagCollectionMeta,
  type RagCollectionScope,
  RagError,
  type RagResult,
  SimpleRagRegistry,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { bindRagEmbedderBreaker, SmartAgentBuilder } from '../../builder.js';
import { unwrapBuilderResult } from '../../builder-types.js';
import {
  makeLlm,
  testCallOptions,
  testRequestAccess,
} from '../../testing/index.js';
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
      .withRagAccess(testRequestAccess)
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setToolsRag(tools)
      .withRetrievalStrategy('tools', strategy)
      .build()
      .then(unwrapBuilderResult);
    try {
      const projected = handle.ragStores.tools.rag;
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
      .withRagAccess(testRequestAccess)
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(reg)
      .withCircuitBreaker()
      .withRetrievalStrategy(
        'docs',
        new RerankedRetrieval(reranker, { storeName: 'docs' }),
      )
      .build()
      .then(unwrapBuilderResult);
    try {
      const projected = handle.ragStores.docs.rag;
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

  it('a prewrapped store keeps its intervening decorator and reranks the primary once', async () => {
    const { reranker, calls } = countingReranker();
    const strategy = new RerankedRetrieval(reranker, { storeName: 'tools' });
    const tools = applyRetrievalStrategy(
      primaryStore([hit('a', 0.9), hit('b', 0.8)]),
      strategy,
    );
    const queries: string[] = [];
    const decorator: IRag & IRagDecorator = {
      ...primaryStore([]),
      inner: tools,
      query(embedding, k, options) {
        queries.push(embedding.text);
        return this.inner.query(embedding, k, options);
      },
    };
    const handle = await new SmartAgentBuilder({})
      .withRagAccess(testRequestAccess)
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setToolsRag(decorator)
      .withCircuitBreaker()
      .withRetrievalStrategy('tools', strategy)
      .build()
      .then(unwrapBuilderResult);
    try {
      const projected = handle.ragStores.tools.rag;
      assert.ok(projected instanceof StrategyRag);
      assert.ok(projected.inner instanceof FallbackRag);
      assert.equal(projected.inner.inner, decorator);
      assert.equal(projected.strategy, strategy);
      assert.equal(hasRetrievalStrategy(projected), true);
      await projected.query(q, 1);
      assert.deepEqual(queries, ['q']);
      assert.equal(calls.length, 1);
    } finally {
      await handle.close();
    }
  });

  it('runs either composition once on the selected route and skips global reranking', async () => {
    const tools = countingReranker();
    const docs = countingReranker();
    const global = countingReranker();
    const toolsStore = applyRetrievalStrategy(
      primaryStore([hit('primary-tool', 0.9)]),
      new RerankedRetrieval(tools.reranker, { storeName: 'tools' }),
    );
    const reg = new SimpleRagRegistry();
    for (const name of ['docs', 'plain']) {
      const primary = hit(`primary-${name}`, 0.9);
      primary.metadata.ownerScope = 'global';
      reg.register(name, primaryStore([primary]), undefined, {
        displayName: name,
        scope: 'global',
      });
    }
    const handle = await new SmartAgentBuilder({})
      .withRagAccess(testRequestAccess)
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(reg)
      .setToolsRag(toolsStore)
      .withCircuitBreaker({ failureThreshold: 1 })
      .withReranker(global.reranker)
      .withRetrievalStrategy(
        'docs',
        new RerankedRetrieval(docs.reranker, { storeName: 'docs' }),
      )
      .build()
      .then(unwrapBuilderResult);
    try {
      const pTools = handle.ragStores.tools.rag;
      const pDocs = handle.ragStores.docs.rag;
      assert.ok(pTools instanceof StrategyRag);
      assert.ok(pDocs instanceof StrategyRag);
      // Writes fan out to the fallback too, so it is not empty once open.
      await pTools.writer?.()?.upsertRaw('t1', 'fallback tool', { id: 't1' });
      await pDocs.writer?.()?.upsertRaw('d1', 'fallback docs', { id: 'd1' });
      await handle.ragStores.plain.rag
        .writer?.()
        ?.upsertRaw('p1', 'fallback plain', { id: 'p1' });
      await tick();
      const embedderBreaker = handle.circuitBreakers[1];
      assert.equal(embedderBreaker.state, 'closed');
      await handle.agent.process(
        'primary',
        testCallOptions({ sessionId: 's1' }),
      );
      embedderBreaker.recordFailure();
      assert.equal(embedderBreaker.state, 'open');
      await handle.agent.process(
        'fallback',
        testCallOptions({ sessionId: 's1' }),
      );

      assert.deepEqual(tools.calls, [['primary-tool'], ['fallback tool']]);
      assert.deepEqual(docs.calls, [['primary-docs'], ['fallback docs']]);
      assert.deepEqual(global.calls, [['primary-plain'], ['fallback plain']]);
    } finally {
      await handle.close();
    }
  });

  it('finds deeply bound breakers and does not add a second guard', async () => {
    const breaker = new CircuitBreaker();
    const otherStore = primaryStore([]);
    bindRagEmbedderBreaker(otherStore, new CircuitBreaker());
    const guarded = new FallbackRag(
      primaryStore([]),
      new InMemoryRag(),
      breaker,
    );
    const deep = (store: IRag) =>
      Array.from({ length: 32 }).reduce<IRag>(
        (inner) =>
          ({ ...primaryStore([]), inner }) satisfies IRag & IRagDecorator,
        store,
      );
    const tools = deep(guarded);
    const history = deep(otherStore);
    const handle = await new SmartAgentBuilder({})
      .withRagAccess(testRequestAccess)
      .withMainLlm(stubLlm())
      .withCircuitBreakers({ embedder: breaker })
      .setToolsRag(tools)
      .setHistoryRag(history)
      .build()
      .then(unwrapBuilderResult);
    try {
      assert.equal(handle.ragStores.tools.rag, tools);
      assert.equal(handle.ragStores.history.rag, history);
    } finally {
      await handle.close();
    }
  });

  it('rejects a cyclic built-in store during breaker discovery', async () => {
    const store = primaryStore([]);
    const cyclic = { ...store, inner: store };
    cyclic.inner = cyclic;
    await assert.rejects(
      new SmartAgentBuilder({})
        .withRagAccess(testRequestAccess)
        .withMainLlm(stubLlm())
        .withCircuitBreaker()
        .setToolsRag(cyclic)
        .build(),
      /Cycle in RAG decorator chain/,
    );
  });

  it('custom registry with setMutationListener: a collection registered after build is projected and wrapped', async () => {
    const reg = new ListeningRegistry();
    const handle = await new SmartAgentBuilder({})
      .withRagAccess(testRequestAccess)
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(reg)
      .withRetrievalStrategy('kb', new EmbeddingRetrieval())
      .build()
      .then(unwrapBuilderResult);
    try {
      const kb = new InMemoryRag();
      reg.register('kb', kb, undefined, { displayName: 'kb', scope: 'global' });
      const projected = handle.ragStores.kb.rag;
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
      .withRagAccess(testRequestAccess)
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(reg)
      .withRetrievalStrategy('kb', new EmbeddingRetrieval())
      .build()
      .then(unwrapBuilderResult);
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

function stubLlm(): ILlm {
  return {
    async chat() {
      return {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
    async *streamChat() {
      yield {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
  };
}

describe('withRetrievalStrategy on the real request path (DefaultPipeline)', () => {
  it('an explicit history strategy keeps history out of the reranker; tools without one are still reranked', async () => {
    const { reranker, calls } = countingReranker();
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(stubLlm())
      .withEmbedder(
        symmetricEmbedder({
          embed: async (_t: string, _o?: CallOptions) => ({
            vector: [0.1, 0.2, 0.3],
          }),
        }),
      )
      .setToolsRag(primaryStore([hit('tool-hit', 0.9)]))
      .setHistoryRag(primaryStore([hit('history-hit', 0.9)]))
      .withRetrievalStrategy('history', new EmbeddingRetrieval())
      .withReranker(reranker)
      .build()
      .then(unwrapBuilderResult);
    try {
      await handle.agent.process('hello', testCallOptions({ sessionId: 's1' }));
      const seen = calls.flat();
      assert.ok(seen.includes('tool-hit'), 'tools is still reranked');
      assert.ok(
        !seen.includes('history-hit'),
        'history never reaches the reranker',
      );
    } finally {
      await handle.close();
    }
  });

  it("an explicit tools strategy is what the pipeline's tools query goes through", async () => {
    const { strategy, calls } = spyStrategy();
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(stubLlm())
      .withEmbedder(
        symmetricEmbedder({
          embed: async (_t: string, _o?: CallOptions) => ({
            vector: [0.1, 0.2, 0.3],
          }),
        }),
      )
      .setToolsRag(primaryStore([hit('tool-hit', 0.9)]))
      .withRetrievalStrategy('tools', strategy)
      .build()
      .then(unwrapBuilderResult);
    try {
      await handle.agent.process('hello', testCallOptions({ sessionId: 's1' }));
      assert.ok(calls.length >= 1, 'the tools query went through the strategy');
    } finally {
      await handle.close();
    }
  });
});

describe('withRetrievalStrategy reaches the legacy coordinator tool source', () => {
  async function toolSourceOf(withStrategy: boolean) {
    const { strategy, calls } = spyStrategy();
    let builder = new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(stubLlm())
      .withEmbedder(
        symmetricEmbedder({
          embed: async (_t: string, _o?: CallOptions) => ({
            vector: [0.1, 0.2, 0.3],
          }),
        }),
      )
      .setToolsRag(primaryStore([hit('tool-hit', 0.9)]))
      .withCoordinator({});
    if (withStrategy)
      builder = builder.withRetrievalStrategy('tools', strategy);
    const handle = await builder.build().then(unwrapBuilderResult);
    const pipeline = (
      handle.agent as unknown as { deps: { pipeline: unknown } }
    ).deps.pipeline as { coordinator?: { dispatch?: unknown } };
    assert.ok(pipeline.coordinator, 'expected a coordinator');
    const primary = (
      pipeline.coordinator.dispatch as {
        primary?: {
          contextBuilder?: {
            config: {
              toolSource?: (t: string, k: number) => Promise<RagResult[]>;
            };
          };
        };
      }
    ).primary;
    const toolSource = primary?.contextBuilder?.config.toolSource;
    assert.ok(toolSource, 'expected a default toolSource');
    return { handle, toolSource, calls };
  }

  it('queries the projected strategy-wrapped tools store', async () => {
    const { handle, toolSource, calls } = await toolSourceOf(true);
    try {
      const res = await toolSource('find a tool', 2);
      assert.deepEqual(
        res.map((r) => r.text),
        ['tool-hit'],
      );
      assert.deepEqual(calls, [2]);
    } finally {
      await handle.close();
    }
  });

  it('without a strategy, queries the raw tools store', async () => {
    const { handle, toolSource, calls } = await toolSourceOf(false);
    try {
      const res = await toolSource('find a tool', 2);
      assert.deepEqual(
        res.map((r) => r.text),
        ['tool-hit'],
      );
      assert.deepEqual(calls, []);
    } finally {
      await handle.close();
    }
  });
});

describe("a worker's own store keeps priority under a retrieval strategy", () => {
  /** A tools store that records each query under `label`. */
  function labelledStore(label: string, seen: string[]): IRag {
    const base = primaryStore([hit(`${label}-hit`, 0.9)]);
    return {
      ...base,
      query: async (e, k, o) => {
        seen.push(label);
        return base.query(e, k, o);
      },
    };
  }

  async function workerOverParentRegistry(withCoordinator: boolean) {
    const seen: string[] = [];
    const registry = new SimpleRagRegistry();
    // Build the parent over the shared registry; its tools remain internal.
    const parent = unwrapBuilderResult(
      await new SmartAgentBuilder({ skipModelValidation: true })
        .withRagAccess(testRequestAccess)
        .withMainLlm(stubLlm())
        .setRagRegistry(registry)
        .setToolsRag(labelledStore('parent', seen))
        .build(),
    );
    await parent.close();
    const { strategy, calls } = spyStrategy();
    // … and the worker brings its own tools plus an explicit strategy.
    let builder = new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(stubLlm())
      .withEmbedder(
        symmetricEmbedder({
          embed: async (_t: string, _o?: CallOptions) => ({
            vector: [0.1, 0.2, 0.3],
          }),
        }),
      )
      .setRagRegistry(registry)
      .setToolsRag(labelledStore('worker', seen))
      .withRetrievalStrategy('tools', strategy);
    if (withCoordinator) builder = builder.withCoordinator({});
    const handle = await builder.build().then(unwrapBuilderResult);
    return { handle, seen, calls };
  }

  it('the pipeline queries the worker tools, through the strategy, never the parent', async () => {
    const { handle, seen, calls } = await workerOverParentRegistry(false);
    try {
      await handle.agent.process('hello', testCallOptions({ sessionId: 's1' }));
      assert.ok(seen.includes('worker'), 'the worker store was queried');
      assert.ok(!seen.includes('parent'), 'the parent store was not queried');
      assert.ok(calls.length >= 1, 'the strategy was applied');
    } finally {
      await handle.close();
    }
  });

  it('the legacy coordinator tool source queries the worker tools, through the strategy', async () => {
    const { handle, seen, calls } = await workerOverParentRegistry(true);
    try {
      const pipeline = (
        handle.agent as unknown as { deps: { pipeline: unknown } }
      ).deps.pipeline as {
        coordinator?: {
          dispatch?: {
            primary?: {
              contextBuilder?: {
                config: {
                  toolSource?: (t: string, k: number) => Promise<RagResult[]>;
                };
              };
            };
          };
        };
      };
      const toolSource =
        pipeline.coordinator?.dispatch?.primary?.contextBuilder?.config
          .toolSource;
      assert.ok(toolSource, 'expected a default toolSource');
      seen.length = 0;
      calls.length = 0;
      const res = await toolSource('find a tool', 2);
      assert.deepEqual(
        res.map((r) => r.text),
        ['worker-hit'],
      );
      assert.deepEqual(seen, ['worker']);
      assert.deepEqual(calls, [2]);
    } finally {
      await handle.close();
    }
  });

  it('the main agent keeps the projected (circuit-breaker) layer over its own store', async () => {
    const seen: string[] = [];
    const { strategy, calls } = spyStrategy();
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(stubLlm())
      .withEmbedder(
        symmetricEmbedder({
          embed: async (_t: string, _o?: CallOptions) => ({
            vector: [0.1, 0.2, 0.3],
          }),
        }),
      )
      .setToolsRag(labelledStore('own', seen))
      .withRetrievalStrategy('tools', strategy)
      .withCircuitBreaker({})
      .build()
      .then(unwrapBuilderResult);
    try {
      const projected = handle.ragStores.tools.rag;
      assert.ok(projected instanceof StrategyRag);
      assert.ok(projected.inner instanceof FallbackRag);
      await handle.agent.process('hello', testCallOptions({ sessionId: 's1' }));
      assert.ok(seen.includes('own'));
      assert.ok(calls.length >= 1);
    } finally {
      await handle.close();
    }
  });
});
