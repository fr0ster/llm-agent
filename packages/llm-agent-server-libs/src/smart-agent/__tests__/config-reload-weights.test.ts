import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  FallbackRag,
  InMemoryRag,
  type IRag,
  type IRagDecorator,
} from '@mcp-abap-adt/llm-agent';
import { EmbeddingRetrieval, StrategyRag } from '@mcp-abap-adt/llm-agent-libs';
import {
  type ConfigReloadDeps,
  ConfigReloadWatcher,
  findWeightedStore,
} from '../config-reload-watcher.js';

type Weights = Parameters<
  NonNullable<ReturnType<typeof findWeightedStore>>['updateWeights']
>[0];

/** A store that takes weight updates, like VectorRag. */
function weightedStore() {
  const updates: Weights[] = [];
  const store = Object.assign(new InMemoryRag(), {
    updateWeights: (w: Weights) => {
      updates.push(w);
    },
  });
  return { store, updates };
}

function watcherOver(ragStores: ConfigReloadDeps['ragStores']) {
  const watcher = new ConfigReloadWatcher({
    configFile: '/nonexistent/smart-server.yaml',
    log: () => {},
    applyAgentUpdate: () => {},
    mirrorCfg: () => {},
    drainWorkers: async () => {},
    invalidateSessions: async () => {},
    ragStores,
  });
  // biome-ignore lint/complexity/useLiteralKeys: Drive the reload without a file watcher.
  return (u: Weights) => watcher['_onReload'](u);
}

describe('config reload — RAG weight updates through decorators', () => {
  it('reaches a store wrapped by StrategyRag', () => {
    const { store, updates } = weightedStore();
    const reload = watcherOver({
      tools: new StrategyRag(store, new EmbeddingRetrieval()),
    });
    reload({ vectorWeight: 0.3, keywordWeight: 0.7 });
    assert.deepEqual(updates, [{ vectorWeight: 0.3, keywordWeight: 0.7 }]);
  });

  it('reaches a store under FallbackRag(StrategyRag(...))', () => {
    const { store, updates } = weightedStore();
    const wrapped = new FallbackRag(
      new StrategyRag(store, new EmbeddingRetrieval()),
      new InMemoryRag(),
      new CircuitBreaker(),
    );
    const reload = watcherOver({ history: wrapped });
    reload({ vectorWeight: 0.5 });
    assert.deepEqual(updates, [
      { vectorWeight: 0.5, keywordWeight: undefined },
    ]);
  });

  it('still updates an unwrapped store; a store without weights is skipped', () => {
    const { store, updates } = weightedStore();
    assert.equal(findWeightedStore(store), store);
    assert.equal(findWeightedStore(new InMemoryRag()), undefined);
    assert.equal(findWeightedStore(undefined), undefined);
    const reload = watcherOver({ tools: store, other: new InMemoryRag() });
    reload({ keywordWeight: 0.2 });
    assert.equal(updates.length, 1);
  });

  it('updates a weighted store through a deep projected chain', () => {
    const { store, updates } = weightedStore();
    const strategy = new EmbeddingRetrieval();
    const deep = Array.from({ length: 32 }).reduce<IRag>(
      (inner) => new StrategyRag(inner, strategy),
      store,
    );
    assert.equal(findWeightedStore(deep), store);
    watcherOver({ docs: { rag: deep } })({ keywordWeight: 0.4 });
    assert.deepEqual(updates, [
      { vectorWeight: undefined, keywordWeight: 0.4 },
    ]);
  });

  it('rejects a cycle even when one store can update weights', () => {
    const { store, updates } = weightedStore();
    const cyclic: IRag & { inner: IRag } = Object.assign(store, {
      inner: store,
    });
    const outer: IRag & IRagDecorator = new StrategyRag(
      cyclic,
      new EmbeddingRetrieval(),
    );
    cyclic.inner = outer;
    assert.throws(
      () => watcherOver({ tools: outer })({ vectorWeight: 0.4 }),
      /Cycle in RAG decorator chain/,
    );
    assert.deepEqual(updates, []);
  });
});
