import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type ILlm,
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
  symmetricEmbedder,
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

  it('circuit breaker on + a projected strategy → StrategyRag(store); the registry entry stays the store; one rerank per query (D68)', async () => {
    const reg = new SimpleRagRegistry();
    const store = primaryStore([hit('a', 0.9), hit('b', 0.8)]);
    reg.register('docs', store, undefined, {
      displayName: 'docs',
      scope: 'global',
    });
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
      assert.equal(
        projected.inner,
        store,
        'no store wrapper under the strategy',
      );
      assert.equal(reg.get('docs', 'global'), store, 'registry not mutated');
      await projected.query(q, 1);
      assert.equal(calls.length, 1);
    } finally {
      await handle.close();
    }
  });

  it('a store wrapped before build + circuit breaker → that same store, no second wrap (D68)', async () => {
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
      assert.equal(handle.ragStores.tools, tools);
      assert.equal(hasRetrievalStrategy(handle.ragStores.tools), true);
      await projected.query(q, 1);
      assert.equal(calls.length, 1);
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
      .build();
    try {
      await handle.agent.process('hello', { sessionId: 's1' });
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
      .build();
    try {
      await handle.agent.process('hello', { sessionId: 's1' });
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
    const handle = await builder.build();
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
    // The parent's tools are already in the shared registry …
    registry.register('tools', labelledStore('parent', seen), undefined, {
      displayName: 'tools',
      scope: 'global',
    });
    const { strategy, calls } = spyStrategy();
    // … and the worker brings its own tools plus an explicit strategy.
    let builder = new SmartAgentBuilder({ skipModelValidation: true })
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
    const handle = await builder.build();
    return { handle, seen, calls };
  }

  it('the pipeline queries the worker tools, through the strategy, never the parent', async () => {
    const { handle, seen, calls } = await workerOverParentRegistry(false);
    try {
      await handle.agent.process('hello', { sessionId: 's1' });
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

  it('the main agent keeps the projected strategy layer over its own store (circuit breaker on: no store wrap)', async () => {
    const seen: string[] = [];
    const own = labelledStore('own', seen);
    const { strategy, calls } = spyStrategy();
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withMainLlm(stubLlm())
      .withEmbedder(
        symmetricEmbedder({
          embed: async (_t: string, _o?: CallOptions) => ({
            vector: [0.1, 0.2, 0.3],
          }),
        }),
      )
      .setToolsRag(own)
      .withRetrievalStrategy('tools', strategy)
      .withCircuitBreaker({})
      .build();
    try {
      const projected = handle.ragStores.tools;
      assert.ok(projected instanceof StrategyRag);
      assert.equal(projected.inner, own);
      await handle.agent.process('hello', { sessionId: 's1' });
      assert.ok(seen.includes('own'));
      assert.ok(calls.length >= 1);
    } finally {
      await handle.close();
    }
  });
});
