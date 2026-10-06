import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRag } from '@mcp-abap-adt/llm-agent';
import { EmbeddingRetrieval, StrategyRag } from '@mcp-abap-adt/llm-agent-libs';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent-rag';
import {
  ConfigReloadWatcher,
  findWeightedStore,
} from '../config-reload-watcher.js';
import { ConfigTransactionQueue } from '../config-transaction-queue.js';
import { FLAT_PIPELINE, reloadDocument } from './reload-document.js';

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
    transactions: new ConfigTransactionQueue(),
    pipeline: FLAT_PIPELINE,
  });
  // White-box: drive one reload without a file watcher — a whole document
  // (D83 (10)); the weights land in an in-memory rag.store, so they are read.
  // The weights are applied after the drain settles (V6): await it.
  return (u: Weights) =>
    (
      watcher as unknown as { _onReload: (d: unknown) => Promise<void> }
    )._onReload(reloadDocument(u));
}

describe('config reload — RAG weight updates through decorators', () => {
  it('reaches a store wrapped by StrategyRag', async () => {
    const { store, updates } = weightedStore();
    const reload = watcherOver({
      tools: new StrategyRag(store, new EmbeddingRetrieval()),
    });
    await reload({ vectorWeight: 0.3, keywordWeight: 0.7 });
    assert.deepEqual(updates, [{ vectorWeight: 0.3, keywordWeight: 0.7 }]);
  });

  it('reaches a store under a decorator over StrategyRag(...)', async () => {
    const { store, updates } = weightedStore();
    const strategy = new StrategyRag(store, new EmbeddingRetrieval());
    const wrapped: IRag & { readonly inner: IRag } = {
      inner: strategy,
      query: (e, k, o) => strategy.query(e, k, o),
      healthCheck: (o) => strategy.healthCheck(o),
      getById: (id, o) => strategy.getById(id, o),
    };
    const reload = watcherOver({ history: wrapped });
    await reload({ vectorWeight: 0.5 });
    assert.deepEqual(updates, [
      { vectorWeight: 0.5, keywordWeight: undefined },
    ]);
  });

  it('still updates an unwrapped store; a store without weights is skipped', async () => {
    const { store, updates } = weightedStore();
    assert.equal(findWeightedStore(store), store);
    assert.equal(findWeightedStore(new InMemoryRag()), undefined);
    assert.equal(findWeightedStore(undefined), undefined);
    const reload = watcherOver({ tools: store, other: new InMemoryRag() });
    await reload({ keywordWeight: 0.2 });
    assert.equal(updates.length, 1);
  });
});
