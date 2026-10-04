import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  FallbackRag,
  InMemoryRag,
  type IRag,
} from '@mcp-abap-adt/llm-agent';
import { EmbeddingRetrieval, StrategyRag } from '@mcp-abap-adt/llm-agent-libs';
import {
  ConfigReloadWatcher,
  findWeightedStore,
} from '../config-reload-watcher.js';

type Weights = { vectorWeight?: number; keywordWeight?: number };

/** A store that takes weight updates, like VectorRag. */
function weightedStore() {
  const updates: Weights[] = [];
  const store = Object.assign(new InMemoryRag(), {
    updateWeights: (w: Weights) => {
      updates.push(w);
    },
  });
  return { store: store as IRag, updates };
}

function watcherOver(ragStores: Record<string, unknown>) {
  const watcher = new ConfigReloadWatcher({
    configFile: '/nonexistent/smart-server.yaml',
    log: () => {},
    applyAgentUpdate: () => {},
    mirrorCfg: () => {},
    drainWorkers: async () => {},
    invalidateSessions: async () => {},
    ragStores,
  });
  // White-box: drive one reload without a file watcher.
  return (u: Weights) =>
    (watcher as unknown as { _onReload: (u: Weights) => void })._onReload(u);
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
});
