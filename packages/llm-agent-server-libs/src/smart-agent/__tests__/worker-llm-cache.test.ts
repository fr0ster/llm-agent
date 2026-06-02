import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient, IRag } from '@mcp-abap-adt/llm-agent';
import {
  backfillWorkerCacheFromHandle,
  drainWorkerCache,
  resolveWorkerLlmSet,
  type WorkerLlmSet,
} from '../smart-server.js';

// A worker LLM set is built ONCE per worker name and reused by reference on
// subsequent (per-session) calls — never reconstructed. The factory counts how
// many times it actually constructs an LLM.
test('resolveWorkerLlmSet builds once per worker and returns the cached set by reference', async () => {
  let built = 0;
  const cache = new Map<string, WorkerLlmSet>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub for ILlm
  const fakeMake = async (): Promise<any> => {
    built++;
    return {};
  };

  const first = await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  const second = await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });

  assert.equal(first, second, 'same cached set instance returned by reference');
  assert.equal(first.mainLlm, second.mainLlm, 'main LLM not rebuilt');
  assert.equal(
    first.classifierLlm,
    second.classifierLlm,
    'classifier LLM not rebuilt',
  );
  assert.equal(
    built,
    2,
    'exactly two constructions total (main + classifier), once — NOT per call',
  );
});

test('resolveWorkerLlmSet builds once per distinct worker name', async () => {
  let built = 0;
  const cache = new Map<string, WorkerLlmSet>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub for ILlm
  const fakeMake = async (): Promise<any> => {
    built++;
    return {};
  };

  const w1a = await resolveWorkerLlmSet({
    name: 'w1',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  const w2a = await resolveWorkerLlmSet({
    name: 'w2',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  const w1b = await resolveWorkerLlmSet({
    name: 'w1',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });

  assert.equal(w1a, w1b, 'w1 cached by reference across calls');
  assert.notEqual(w1a, w2a, 'distinct names yield distinct sets');
  assert.equal(built, 4, '2 builds per worker × 2 distinct workers');
});

test('resolveWorkerLlmSet caches worker-OWN toolsRag/historyRag/mcpClients and reuses them by reference (review HIGH #1)', async () => {
  let toolsBuilt = 0;
  let historyBuilt = 0;
  let mcpBuilt = 0;
  const cache = new Map<string, WorkerLlmSet>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub for ILlm
  const fakeMake = async (): Promise<any> => ({});
  const makeToolsRag = async (): Promise<IRag> => {
    toolsBuilt++;
    return {} as IRag;
  };
  const makeHistoryRag = async (): Promise<IRag> => {
    historyBuilt++;
    return {} as IRag;
  };
  const makeMcpClients = async (): Promise<IMcpClient[]> => {
    mcpBuilt++;
    return [{} as IMcpClient];
  };

  const a = await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
    makeToolsRag,
    makeHistoryRag,
    makeMcpClients,
  });
  const b = await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
    makeToolsRag,
    makeHistoryRag,
    makeMcpClients,
  });

  assert.equal(a, b, 'cached set returned by reference');
  assert.equal(a.toolsRag, b.toolsRag, 'toolsRag reused by reference');
  assert.equal(a.historyRag, b.historyRag, 'historyRag reused by reference');
  assert.equal(a.mcpClients, b.mcpClients, 'mcpClients reused by reference');
  assert.equal(toolsBuilt, 1, 'toolsRag built exactly once');
  assert.equal(historyBuilt, 1, 'historyRag built exactly once');
  assert.equal(mcpBuilt, 1, 'mcpClients built exactly once');
});

test('backfillWorkerCacheFromHandle: captures handle.mcpClients into empty cache slot (subCfg.mcp auto-connect path)', async () => {
  // Simulates a worker whose MCP came from subCfg.mcp auto-connect (no DI):
  // resolveWorkerLlmSet's makeMcpClients was undefined → cache.mcpClients
  // empty. After the primary subBuilder.build() finishes, the handle holds
  // the connected clients — the backfill must capture them BY REFERENCE so
  // per-session re-wires read the worker's own MCP, not the parent's empty
  // list.
  const fakeClient = { id: 'auto-connected' } as unknown as IMcpClient;
  // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
  const entry: WorkerLlmSet = { mainLlm: {} as any, classifierLlm: {} as any };
  const handle = {
    mcpClients: [fakeClient],
    ragRegistry: { get: () => undefined },
  };
  await backfillWorkerCacheFromHandle(entry, handle);
  assert.equal(
    entry.mcpClients?.[0],
    fakeClient,
    'mcpClients backfilled by reference',
  );
  // Idempotent: second call must not overwrite.
  const other = { id: 'other' } as unknown as IMcpClient;
  await backfillWorkerCacheFromHandle(entry, {
    mcpClients: [other],
    ragRegistry: { get: () => undefined },
  });
  assert.equal(
    entry.mcpClients?.[0],
    fakeClient,
    'subsequent backfill leaves populated slot intact (DI / first-build wins)',
  );
});

test('backfillWorkerCacheFromHandle: captures toolsRag/historyRag from ragRegistry when not already cached', async () => {
  const tools = { id: 'tools' } as unknown as IRag;
  const history = { id: 'history' } as unknown as IRag;
  // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
  const entry: WorkerLlmSet = { mainLlm: {} as any, classifierLlm: {} as any };
  const handle = {
    mcpClients: [],
    ragRegistry: {
      get: (name: string) =>
        name === 'tools' ? tools : name === 'history' ? history : undefined,
    },
  };
  await backfillWorkerCacheFromHandle(entry, handle);
  assert.equal(entry.toolsRag, tools, 'toolsRag backfilled from registry');
  assert.equal(
    entry.historyRag,
    history,
    'historyRag backfilled from registry',
  );
});

test('backfillWorkerCacheFromHandle: empty handle.mcpClients leaves cache slot undefined (re-wire falls back to parent)', async () => {
  // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
  const entry: WorkerLlmSet = { mainLlm: {} as any, classifierLlm: {} as any };
  await backfillWorkerCacheFromHandle(entry, {
    mcpClients: [],
    ragRegistry: { get: () => undefined },
  });
  assert.equal(entry.mcpClients, undefined, 'empty mcp list not captured');
  assert.equal(entry.toolsRag, undefined);
  assert.equal(entry.historyRag, undefined);
});

test('per-session injected slot priority: worker-cached mcpClients wins over parent-fallback (review HIGH #7)', () => {
  // Documents the priority encoded at buildSessionAgent's call site:
  //   injected.mcpClients = cached.mcpClients ?? parts.mcpClients
  //   injected.toolsRag   = cached.toolsRag   ?? parts.toolsRag
  // After the primary buildSubAgent backfills cached.mcpClients/toolsRag from
  // the built handle (e.g. workers configured with `mcp: ...`), per-session
  // re-wires pass the worker's OWN connected clients/RAG, not the parent's.
  const cachedMcp: IMcpClient[] = [
    { id: 'worker-mcp' } as unknown as IMcpClient,
  ];
  const parentMcp: IMcpClient[] = [
    { id: 'parent-mcp' } as unknown as IMcpClient,
  ];
  const cachedTools = { id: 'worker-tools' } as unknown as IRag;
  const parentTools = { id: 'parent-tools' } as unknown as IRag;

  // worker-cached present → wins
  const cachedSet: { mcpClients?: IMcpClient[]; toolsRag?: IRag } = {
    mcpClients: cachedMcp,
    toolsRag: cachedTools,
  };
  const parts = { mcpClients: parentMcp, toolsRag: parentTools };
  const injectedMcp =
    cachedSet.mcpClients && cachedSet.mcpClients.length > 0
      ? cachedSet.mcpClients
      : parts.mcpClients;
  const injectedTools = cachedSet.toolsRag ?? parts.toolsRag;
  assert.equal(injectedMcp, cachedMcp, 'worker-cached MCP clients chosen');
  assert.equal(injectedTools, cachedTools, 'worker-cached toolsRag chosen');

  // worker-cached absent → parent fallback
  const leanSet: { mcpClients?: IMcpClient[]; toolsRag?: IRag } = {};
  const injectedMcp2 =
    leanSet.mcpClients && leanSet.mcpClients.length > 0
      ? leanSet.mcpClients
      : parts.mcpClients;
  const injectedTools2 = leanSet.toolsRag ?? parts.toolsRag;
  assert.equal(injectedMcp2, parentMcp, 'parent MCP clients used as fallback');
  assert.equal(injectedTools2, parentTools, 'parent toolsRag used as fallback');

  // worker-cached present but EMPTY mcpClients array → parent fallback
  const emptyMcpSet: { mcpClients?: IMcpClient[] } = { mcpClients: [] };
  const injectedMcp3 =
    emptyMcpSet.mcpClients && emptyMcpSet.mcpClients.length > 0
      ? emptyMcpSet.mcpClients
      : parts.mcpClients;
  assert.equal(
    injectedMcp3,
    parentMcp,
    'empty cached mcpClients array falls back to parent',
  );
});

test('Fix #18: resolveWorkerLlmSet repopulates the cache on miss after clear (config-reload path)', async () => {
  // After PUT /v1/config / hot-reload clear the cache, buildSessionAgent
  // used to throw "worker LLM set not cached" on the next session build.
  // The fix routes through resolveWorkerLlmSet which is build-on-miss:
  // a cleared cache simply rebuilds the entry rather than throwing.
  let built = 0;
  const cache = new Map<string, WorkerLlmSet>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub for ILlm
  const fakeMake = async (): Promise<any> => {
    built++;
    return {};
  };
  // Prime the cache.
  await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  assert.equal(cache.size, 1);
  assert.equal(built, 2);

  // Simulate the config-reload `_workerLlmCache.clear()`.
  cache.clear();
  assert.equal(cache.size, 0);

  // Next resolve must succeed (no throw) and re-populate.
  const set2 = await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  assert.equal(cache.size, 1, 'cache repopulated on miss');
  assert.equal(cache.get('w'), set2, 'cache holds the freshly built set');
  assert.equal(built, 4, '2 more LLM constructions (main + classifier)');
});

test('worker WITHOUT own toolsRag/MCP factories leaves those cache slots undefined (re-wire falls back to injected)', async () => {
  const cache = new Map<string, WorkerLlmSet>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub for ILlm
  const fakeMake = async (): Promise<any> => ({});
  const set = await resolveWorkerLlmSet({
    name: 'lean',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  assert.equal(
    set.toolsRag,
    undefined,
    'no makeToolsRag factory → cached.toolsRag undefined → re-wire falls back to injected',
  );
  assert.equal(set.historyRag, undefined);
  assert.equal(set.mcpClients, undefined);
});

// ---------------------------------------------------------------------------
// Fix #21: SmartAgentHandle.close() tracked per cached worker.
// ---------------------------------------------------------------------------

test('Fix #21: backfillWorkerCacheFromHandle captures handle.close into the cache entry', async () => {
  const closeFn = async () => {};
  // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
  const entry: WorkerLlmSet = { mainLlm: {} as any, classifierLlm: {} as any };
  await backfillWorkerCacheFromHandle(entry, {
    mcpClients: [],
    ragRegistry: { get: () => undefined },
    close: closeFn,
  });
  assert.equal(entry.close, closeFn, 'close captured by reference');
});

test('Fix #21: drainWorkerCache invokes close on every entry and clears the cache', async () => {
  const calls: string[] = [];
  const cache = new Map<string, WorkerLlmSet>();
  cache.set('w1', {
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    mainLlm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    classifierLlm: {} as any,
    close: async () => {
      calls.push('w1');
    },
  });
  cache.set('w2', {
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    mainLlm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    classifierLlm: {} as any,
    close: async () => {
      calls.push('w2');
    },
  });
  // Entry without close must not blow up drain.
  cache.set('w3', {
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    mainLlm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    classifierLlm: {} as any,
  });
  await drainWorkerCache(cache);
  assert.deepEqual(calls.sort(), ['w1', 'w2']);
  assert.equal(cache.size, 0, 'cache cleared after drain');
});

test('Fix #21: drainWorkerCache continues when one close rejects (allSettled)', async () => {
  const calls: string[] = [];
  const cache = new Map<string, WorkerLlmSet>();
  cache.set('bad', {
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    mainLlm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    classifierLlm: {} as any,
    close: async () => {
      calls.push('bad');
      throw new Error('boom');
    },
  });
  cache.set('good', {
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    mainLlm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    classifierLlm: {} as any,
    close: async () => {
      calls.push('good');
    },
  });
  await drainWorkerCache(cache);
  assert.deepEqual(calls.sort(), ['bad', 'good']);
  assert.equal(cache.size, 0);
});

test('Fix #21: re-backfilling the same cache entry awaits the previous close before overwriting', async () => {
  const order: string[] = [];
  let resolvePrev: (() => void) | undefined;
  const prevDone = new Promise<void>((r) => {
    resolvePrev = r;
  });
  const entry: WorkerLlmSet = {
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    mainLlm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub for unused LLM slots
    classifierLlm: {} as any,
    close: async () => {
      order.push('prev-close-start');
      await prevDone;
      order.push('prev-close-end');
    },
  };
  const newClose = async () => {
    order.push('new-close');
  };
  // Kick off backfill — it will await the prev close (gated).
  const backfill = backfillWorkerCacheFromHandle(entry, {
    mcpClients: [],
    ragRegistry: { get: () => undefined },
    close: newClose,
  });
  await Promise.resolve();
  assert.deepEqual(order, ['prev-close-start']);
  // Now release the prev close.
  resolvePrev?.();
  await backfill;
  assert.deepEqual(order, ['prev-close-start', 'prev-close-end']);
  assert.equal(entry.close, newClose, 'new close installed after prev awaited');
});
