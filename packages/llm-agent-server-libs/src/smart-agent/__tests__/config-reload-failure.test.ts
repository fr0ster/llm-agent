/**
 * Spec §10.5.9 V6 (D77's rejection and event boundary, D80, D82): a reload
 * transaction whose worker drain, session invalidation or agent update fails
 * rejects — nothing is restored, the RAG weights are not applied, and the
 * server's config queue records it as not ready. The event boundary logs
 * `config_reload_failed`; reloads are serialized in the server's queue.
 */
import assert from 'node:assert/strict';
import type { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigReloadWatcher } from '../config-reload-watcher.js';
import { ConfigTransactionQueue } from '../config-transaction-queue.js';
import {
  emitReload,
  FLAT_PIPELINE,
  reloadDocument,
} from './reload-document.js';
import { deferred as serialDeferred } from './server-test-helpers.js';

type Weights = { vectorWeight?: number; keywordWeight?: number };
type Entry = {
  watcher: EventEmitter;
  _onReload: (document: unknown) => Promise<void>;
};

interface V6Options {
  drainWorkers?: () => Promise<void>;
  invalidateSessions?: () => Promise<void>;
  applyAgentUpdate?: (u: Record<string, unknown>) => void;
  updateWeights?: (w: Weights) => void;
}

/** A watcher over recording deps, a weighted store and its own queue (the server injects one, D80). */
function v6Harness(t: { after(fn: () => void): void }, o: V6Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reload-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'smart-server.yaml');
  writeFileSync(configFile, 'agent:\n  maxIterations: 10\n');
  const queue = new ConfigTransactionQueue();
  const applied: Record<string, unknown>[] = [];
  const mirrored: Record<string, unknown>[] = [];
  const weights: Weights[] = [];
  const events: Record<string, unknown>[] = [];
  let drainCalls = 0;
  const watcher = new ConfigReloadWatcher({
    configFile,
    log: (e) => {
      events.push(e);
    },
    applyAgentUpdate: (u) => {
      applied.push(u);
      o.applyAgentUpdate?.(u);
    },
    mirrorCfg: (patch) => {
      mirrored.push(patch);
    },
    drainWorkers: () => {
      drainCalls++;
      return o.drainWorkers ? o.drainWorkers() : Promise.resolve();
    },
    invalidateSessions: () =>
      o.invalidateSessions ? o.invalidateSessions() : Promise.resolve(),
    // findWeightedStore takes any object with an `updateWeights` function.
    ragStores: {
      tools: {
        updateWeights: (w: Weights) => {
          weights.push(w);
          o.updateWeights?.(w);
        },
      },
    },
    transactions: queue,
    pipeline: FLAT_PIPELINE, // D83 (11): the documents select no pipeline — flat
  });
  const entry = watcher as unknown as Entry;
  return {
    watcher,
    entry,
    queue,
    applied,
    mirrored,
    weights,
    events,
    drainCalls: () => drainCalls,
    reload: (values: Record<string, unknown>) =>
      entry._onReload(reloadDocument(values)),
  };
}

const NOT_READY =
  /config reload failed, the server is not ready until a whole config applies — /;

test('V6: a rejecting worker drain fails the reload — nothing restored, no weights, not ready', async (t) => {
  const h = v6Harness(t, {
    drainWorkers: async () => {
      throw new Error('close failed');
    },
  });
  await assert.rejects(
    h.reload({ maxIterations: 25, vectorWeight: 0.3 }),
    /config reload failed, the server is not ready until a whole config applies — worker drain: Error: close failed/,
  );
  // No rollback (D82): applied once, never again.
  assert.deepEqual(h.applied, [{ maxIterations: 25 }]);
  assert.equal(h.mirrored.length, 1);
  assert.deepEqual(h.weights, [], 'the weights are not applied');
  assert.equal(
    h.events.filter((e) => e.event === 'config_reload_applied').length,
    0,
  );
  assert.equal(h.queue.notApplied?.source, 'reload');
  assert.match(
    h.queue.notApplied?.reason ?? '',
    /worker drain: Error: close failed/,
  );
});

test('V6: a rejecting session invalidation fails the reload the same way', async (t) => {
  const h = v6Harness(t, {
    invalidateSessions: async () => {
      throw new Error('dispose failed');
    },
  });
  await assert.rejects(
    h.reload({ maxIterations: 25, vectorWeight: 0.3 }),
    /session invalidation: Error: dispose failed/,
  );
  assert.deepEqual(h.applied, [{ maxIterations: 25 }]);
  assert.equal(h.mirrored.length, 1);
  assert.deepEqual(h.weights, []);
  assert.equal(h.queue.notApplied?.source, 'reload');
});

test('V6: both rejecting → one rejection naming both', async (t) => {
  const h = v6Harness(t, {
    drainWorkers: async () => {
      throw new Error('close failed');
    },
    invalidateSessions: async () => {
      throw new Error('dispose failed');
    },
  });
  await assert.rejects(
    h.reload({ maxIterations: 25 }),
    /worker drain: Error: close failed; session invalidation: Error: dispose failed/,
  );
  assert.match(
    h.queue.notApplied?.reason ?? '',
    /worker drain.*session invalidation/,
  );
});

test('V6: a throwing applyAgentUpdate rejects with its error; the drain never runs; not ready', async (t) => {
  const h = v6Harness(t, {
    applyAgentUpdate: () => {
      throw new Error('boom');
    },
  });
  await assert.rejects(h.reload({ maxIterations: 25 }), /boom/);
  assert.equal(h.drainCalls(), 0);
  assert.equal(h.queue.notApplied?.source, 'reload');
  // The reason names the failed step under the queue's prefix, never the bare error.
  assert.match(
    h.queue.notApplied?.reason ?? '',
    /^config reload failed, the server is not ready until a whole config applies — apply: Error: boom/,
  );
});

test('V6: a throwing updateWeights fails the reload with the weights prefix; not ready', async (t) => {
  const h = v6Harness(t, {
    updateWeights: () => {
      throw new Error('weights broke');
    },
  });
  await assert.rejects(
    h.reload({ maxIterations: 25, vectorWeight: 0.3 }),
    /config reload failed, the server is not ready until a whole config applies — weights: Error: weights broke/,
  );
  assert.equal(h.queue.notApplied?.source, 'reload');
  assert.match(
    h.queue.notApplied?.reason ?? '',
    /^config reload failed, the server is not ready until a whole config applies — weights: Error: weights broke/,
  );
});

test('V6: success resolves, applies the weights, logs config_reload_applied once; failed then successful → set then cleared', async (t) => {
  const h = v6Harness(t);
  await h.reload({ maxIterations: 25, vectorWeight: 0.3 });
  assert.deepEqual(h.weights, [
    { vectorWeight: 0.3, keywordWeight: undefined },
  ]);
  assert.equal(
    h.events.filter((e) => e.event === 'config_reload_applied').length,
    1,
  );
  assert.equal(h.queue.notApplied, undefined);

  let fail = true;
  const g = v6Harness(t, {
    drainWorkers: async () => {
      if (fail) throw new Error('close failed');
    },
  });
  await assert.rejects(g.reload({ maxIterations: 25 }), NOT_READY);
  assert.equal(g.queue.notApplied?.source, 'reload');
  fail = false;
  await g.reload({ maxIterations: 30 });
  assert.equal(g.queue.notApplied, undefined);
});

test('V6: the event boundary — a rejecting reload is logged config_reload_failed, never applied; no unhandled rejection', async (t) => {
  let unhandled: unknown;
  const onUnhandled = (r: unknown) => {
    unhandled = r;
  };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const h = v6Harness(t, {
    drainWorkers: async () => {
      throw new Error('close failed');
    },
  });
  h.watcher.start();
  t.after(() => h.watcher.stop());
  emitReload(h.entry.watcher, { maxIterations: 25 });
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  const failed = h.events.find((e) => e.event === 'config_reload_failed');
  assert.ok(failed, 'config_reload_failed logged');
  assert.match(String(failed.error), /worker drain/);
  assert.equal(
    h.events.filter((e) => e.event === 'config_reload_applied').length,
    0,
  );
  assert.equal(unhandled, undefined);
});

// ---------------------------------------------------------------------------
// D80: serialized — the server's one config queue.
// ---------------------------------------------------------------------------

type SerialWeights = { vectorWeight?: number; keywordWeight?: number };
type SerialEntry = {
  watcher: EventEmitter;
  _onReload: (document: unknown) => Promise<void>;
};

const serialTurn = () => new Promise<void>((r) => setImmediate(r));

function serialHarness(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'reload-serial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'smart-server.yaml');
  writeFileSync(configFile, 'agent:\n  maxIterations: 10\n');
  let live: Record<string, unknown> = { maxIterations: 10 };
  const weights: SerialWeights[] = [];
  const events: Record<string, unknown>[] = [];
  const drains: ReturnType<typeof serialDeferred>[] = [];
  // The server's one config queue (D80) — here this watcher's alone.
  const queue = new ConfigTransactionQueue();
  const watcher = new ConfigReloadWatcher({
    configFile,
    log: (e) => {
      events.push(e);
    },
    applyAgentUpdate: (u) => {
      live = { ...live, ...u };
    },
    mirrorCfg: () => {},
    drainWorkers: () => {
      const d = serialDeferred();
      drains.push(d);
      return d.promise;
    },
    invalidateSessions: async () => {},
    // findWeightedStore takes any object with an `updateWeights` function.
    ragStores: {
      tools: {
        updateWeights: (w: SerialWeights) => {
          weights.push(w);
        },
      },
    },
    transactions: queue,
    pipeline: FLAT_PIPELINE, // D83 (11): the documents select no pipeline — flat
  });
  // White-box: the inner ConfigWatcher (an EventEmitter) and the entry point.
  const entry = watcher as unknown as SerialEntry;
  return { watcher, entry, queue, live: () => live, weights, events, drains };
}

test("D80: reload B waits for reload A to settle; A's drain fails after B was queued → A reported (not ready), then B applied (ready) — config and weights are B's", async (t) => {
  const h = serialHarness(t);
  const a = h.entry._onReload(
    reloadDocument({ maxIterations: 25, vectorWeight: 0.3 }),
  );
  const b = h.entry._onReload(
    reloadDocument({ maxIterations: 40, vectorWeight: 0.7 }),
  );
  await serialTurn();
  assert.equal(h.drains.length, 1, 'B has not started while A is in flight');
  assert.equal(
    h.live().maxIterations,
    25,
    "A's config is live while its drain is pending",
  );
  h.drains[0].reject(new Error('close failed'));
  await assert.rejects(a, /worker drain: Error: close failed/);
  await serialTurn();
  assert.equal(h.drains.length, 2, 'B started only after A settled');
  assert.equal(
    h.queue.notApplied?.source,
    'reload',
    'A left the server not ready',
  );
  h.drains[1].resolve();
  await b;
  assert.equal(h.live().maxIterations, 40, "the final config is B's");
  assert.deepEqual(
    h.weights,
    [{ vectorWeight: 0.7, keywordWeight: undefined }],
    "only B's weights",
  );
  assert.equal(
    h.events.filter((e) => e.event === 'config_reload_applied').length,
    1,
  );
  assert.equal(
    h.queue.notApplied,
    undefined,
    'B applied — the server is ready again',
  );
});

test('D80: a failed reload does not block the next one; each is reported on its own at the event boundary', async (t) => {
  const h = serialHarness(t);
  let unhandled: unknown;
  const onUnhandled = (r: unknown) => {
    unhandled = r;
  };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  h.watcher.start();
  t.after(() => h.watcher.stop());
  emitReload(h.entry.watcher, { maxIterations: 25 });
  emitReload(h.entry.watcher, { maxIterations: 40 });
  await serialTurn();
  assert.equal(h.drains.length, 1, 'the second reload is queued, not started');
  h.drains[0].reject(new Error('close failed'));
  await serialTurn();
  assert.equal(
    h.drains.length,
    2,
    'the failed reload did not block the next one',
  );
  h.drains[1].resolve();
  await serialTurn();
  const outcomes = h.events
    .filter(
      (e) =>
        e.event === 'config_reload_failed' ||
        e.event === 'config_reload_applied',
    )
    .map((e) => e.event);
  assert.deepEqual(outcomes, ['config_reload_failed', 'config_reload_applied']);
  const failed = h.events.find((e) => e.event === 'config_reload_failed');
  assert.match(String(failed?.error), /worker drain: Error: close failed/);
  assert.equal(h.live().maxIterations, 40);
  assert.equal(h.queue.notApplied, undefined);
  assert.equal(unhandled, undefined);
});
