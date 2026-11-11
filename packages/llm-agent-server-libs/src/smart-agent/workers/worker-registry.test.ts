import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILogger, IMcpClient } from '@mcp-abap-adt/llm-agent';
import type {
  SessionAgentParts,
  SmartAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  backfillWorkerCacheFromHandle,
  resolveWorkerLlmSet,
  WorkerRegistry,
  type WorkerRegistryDeps,
} from './worker-registry.js';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const worker = { name: 'worker', config: {} };
const agent = { maxToolCalls: 1 } as SmartAgent;
const ownClient = {} as IMcpClient;

function setup(factory: WorkerRegistryDeps['buildSubAgent']) {
  return new WorkerRegistry({
    subAgentConfigs: [worker],
    getFileLogger: () => ({}) as ILogger,
    getEmbedderFactories: () => ({}),
    buildSubAgent: factory,
  });
}

const parts = { mcpClients: [{} as IMcpClient] } as SessionAgentParts;

test('concurrent session builds wait for one complete construction and keep separate agents', async () => {
  const started = deferred();
  const backfill = deferred();
  let primary = 0;
  let sessions = 0;
  const registry = setup(
    async (name, _config, _logger, _factories, injected, cache) => {
      assert.ok(cache);
      if (injected) {
        sessions++;
        assert.equal(injected.mcpClients[0], ownClient);
        return { maxToolCalls: 1 } as SmartAgent;
      }
      primary++;
      const entry = await resolveWorkerLlmSet({ name, cache });
      started.resolve();
      await backfill.promise;
      await backfillWorkerCacheFromHandle(entry, {
        mcpClients: [ownClient],
        ragRegistry: { get: () => undefined },
      });
      return agent;
    },
  );
  const first = registry.build(parts);
  await started.promise;
  const second = registry.build(parts);
  assert.equal(registry.cache.size, 0);
  assert.equal(sessions, 0);
  backfill.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(primary, 1);
  assert.equal(sessions, 2);
  assert.notEqual(a.get('worker'), b.get('worker'));
  assert.equal(await registry.construct(worker), agent);
});

test('drain waits for stale construction and its close before allowing completion', async () => {
  const started = deferred();
  const finish = deferred();
  const closing = deferred();
  const closed = deferred();
  let builds = 0;
  const registry = setup(
    async (name, _config, _logger, _factories, _injected, cache) => {
      assert.ok(cache);
      builds++;
      const entry = await resolveWorkerLlmSet({ name, cache });
      entry.close = async () => {
        closing.resolve();
        await closed.promise;
      };
      started.resolve();
      await finish.promise;
      return agent;
    },
  );
  const build = registry.construct(worker);
  const rejected = assert.rejects(build, /generation drained/);
  await started.promise;
  let drained = false;
  const drain = registry.drain().then(() => {
    drained = true;
  });
  finish.resolve();
  await closing.promise;
  assert.equal(drained, false);
  assert.equal(registry.cache.size, 0);
  closed.resolve();
  await Promise.all([rejected, drain]);
  assert.equal(await registry.construct(worker), agent);
  assert.equal(builds, 2);
});

test('rollback drain discards workers constructed with the rejected configuration', async () => {
  let builds = 0;
  let closes = 0;
  const registry = setup(
    async (name, _config, _logger, _factories, _injected, cache) => {
      assert.ok(cache);
      builds++;
      const entry = await resolveWorkerLlmSet({ name, cache });
      entry.close = async () => {
        closes++;
      };
      return { maxToolCalls: builds } as SmartAgent;
    },
  );
  await registry.construct(worker);
  await registry.drain();
  const rejectedConfig = await registry.construct(worker);
  await registry.drain();
  const restoredConfig = await registry.construct(worker);
  assert.notEqual(restoredConfig, rejectedConfig);
  assert.equal(builds, 3);
  assert.equal(closes, 2);
});

test('failed construction rejects every waiter, closes partial resources and retries', async () => {
  const started = deferred();
  const fail = deferred();
  const error = new Error('construction failed');
  let builds = 0;
  let closes = 0;
  const registry = setup(
    async (name, _config, _logger, _factories, _injected, cache) => {
      assert.ok(cache);
      builds++;
      const entry = await resolveWorkerLlmSet({ name, cache });
      entry.close = async () => {
        closes++;
      };
      started.resolve();
      await fail.promise;
      if (builds === 1) throw error;
      return agent;
    },
  );
  const first = registry.construct(worker);
  await started.promise;
  const second = registry.construct(worker);
  assert.equal(first, second);
  const results = Promise.all([
    assert.rejects(first, (caught: Error) => caught === error),
    assert.rejects(second, (caught: Error) => caught === error),
  ]);
  fail.resolve();
  await results;
  assert.equal(closes, 1);
  assert.equal(registry.cache.size, 0);
  assert.equal(await registry.construct(worker), agent);
  assert.equal(builds, 2);
});

test('backfill failure retains the handle close for construction cleanup', async () => {
  let closes = 0;
  const error = new Error('backfill failed');
  const registry = setup(
    async (name, _config, _logger, _factories, _injected, cache) => {
      assert.ok(cache);
      const entry = await resolveWorkerLlmSet({ name, cache });
      await backfillWorkerCacheFromHandle(entry, {
        ragRegistry: {
          get: () => {
            throw error;
          },
        },
        close: async () => {
          closes++;
        },
      });
      return agent;
    },
  );
  await assert.rejects(
    registry.construct(worker),
    (caught: Error) => caught === error,
  );
  assert.equal(closes, 1);
  assert.equal(registry.cache.size, 0);
});

test('the flight is registered before the factory can reenter construction', async () => {
  let reentered: Promise<SmartAgent> | undefined;
  const registry = setup(
    async (name, _config, _logger, _factories, _injected, cache) => {
      assert.ok(cache);
      reentered = registry.construct(worker);
      await resolveWorkerLlmSet({ name, cache });
      return agent;
    },
  );
  const first = registry.construct(worker);
  assert.equal(await first, agent);
  assert.equal(reentered, first);
});
