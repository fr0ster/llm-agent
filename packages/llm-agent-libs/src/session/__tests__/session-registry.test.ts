import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';
import { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';
import { SessionGraph } from '../session-graph.js';
import { SessionRegistry } from '../session-registry.js';

function fakeFactory(disposed: string[], counter?: { n: number }) {
  return {
    build: async (identity: { sessionId: string }) => {
      if (counter) counter.n++;
      // Yield a microtask so concurrent acquire() of the same new id overlaps the build.
      await Promise.resolve();
      return new SessionGraph({
        sessionId: identity.sessionId,
        toolAvailability: new ToolAvailabilityRegistry(),
        pendingToolResults: new PendingToolResultsRegistry(),
        logger: new SessionRequestLogger(),
        dispose: async (id) => {
          disposed.push(id);
        },
      });
    },
  };
}

function makeRegistry(
  over: Partial<{ idleTtlMs: number; maxSessions: number }> = {},
  counter?: { n: number },
) {
  const disposed: string[] = [];
  const reg = new SessionRegistry({
    idleTtlMs: 10_000,
    maxSessions: 2,
    factory: fakeFactory(disposed, counter),
    ...over,
  });
  return { reg, disposed };
}

test('acquire is lazy and stable per id', async () => {
  const { reg } = makeRegistry();
  const a = await reg.acquire('s1');
  const a2 = await reg.acquire('s1');
  assert.equal(a, a2);
  assert.equal(a.activeRequests, 2);
  assert.equal(reg.size, 1);
});

test('SINGLE-FLIGHT: concurrent acquire of the same NEW sessionId builds exactly once and returns the same graph instance', async () => {
  const counter = { n: 0 };
  const { reg } = makeRegistry({}, counter);
  const [g1, g2] = await Promise.all([reg.acquire('new'), reg.acquire('new')]);
  assert.equal(
    counter.n,
    1,
    'factory.build called exactly once for the new sessionId',
  );
  assert.equal(g1, g2, 'both callers receive the identical graph instance');
  assert.equal(g1.activeRequests, 2, 'both acquires pinned the same graph');
  assert.equal(reg.size, 1);
});

test('idle-TTL evicts only unpinned graphs and disposes', async () => {
  const { reg, disposed } = makeRegistry({ idleTtlMs: 0 });
  await reg.acquire('s1'); // pinned (active=1)
  await reg.evictIdle();
  assert.deepEqual(disposed, []); // pinned -> not evicted
  reg.release('s1');
  await reg.evictIdle();
  assert.deepEqual(disposed, ['s1']);
  assert.equal(reg.size, 0);
});

test('LRU cap evicts the least-recently-used unpinned graph', async () => {
  const { reg, disposed } = makeRegistry({ maxSessions: 2, idleTtlMs: 10_000 });
  await reg.acquire('s1');
  reg.release('s1');
  await reg.acquire('s2');
  reg.release('s2');
  await reg.acquire('s3');
  reg.release('s3'); // over cap -> evict LRU (s1)
  await reg.flushEvictions();
  assert.deepEqual(disposed, ['s1']);
  assert.equal(reg.size, 2);
});

test('DRAIN: pinned LRU candidate over cap is marked, then disposed on release at refcount 0', async () => {
  const { reg, disposed } = makeRegistry({ maxSessions: 1, idleTtlMs: 10_000 });
  const g1 = await reg.acquire('s1'); // pinned (active=1)
  await reg.acquire('s2');
  reg.release('s2'); // over cap; s1 pinned -> MARK s1, don't dispose yet
  await reg.flushEvictions();
  assert.deepEqual(disposed, [], 'pinned graph not disposed while in-flight');
  assert.equal(g1.markedForDisposal, true);
  reg.release('s1'); // refcount hits 0 -> dispose now
  await reg.flushEvictions();
  assert.deepEqual(disposed, ['s1']);
  assert.equal(reg.size, 1); // only s2 remains
});

test('release uses a non-creating lookup (unknown session never resurrected)', () => {
  const { reg } = makeRegistry();
  reg.release('never-seen'); // must be a no-op, not create a graph
  assert.equal(reg.size, 0);
});

test('disposeAll awaits in-flight builds so a graph resolving after disposal is NOT orphaned', async () => {
  const disposed: string[] = [];
  // Slow factory: build resolves only after we hand control back to the
  // event loop several times. disposeAll() must wait it out, then dispose
  // the graph it produced.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slowFactory = {
    build: async (identity: { sessionId: string }) => {
      await gate;
      return new SessionGraph({
        sessionId: identity.sessionId,
        toolAvailability: new ToolAvailabilityRegistry(),
        pendingToolResults: new PendingToolResultsRegistry(),
        logger: new SessionRequestLogger(),
        dispose: async (id) => {
          disposed.push(id);
        },
      });
    },
  };
  const reg = new SessionRegistry({
    idleTtlMs: 10_000,
    maxSessions: 10,
    factory: slowFactory,
  });
  // Kick off an acquire without awaiting — its build is now pending.
  const acquired = reg.acquire('slow');
  // Schedule disposeAll concurrently; it must await the pending build.
  const dispose = reg.disposeAll();
  // Let microtasks settle, then release the gate so the build resolves.
  await Promise.resolve();
  release?.();
  await acquired;
  await dispose;
  assert.deepEqual(
    disposed,
    ['slow'],
    'graph resolved during disposeAll() is disposed, not orphaned',
  );
  assert.equal(reg.size, 0);
});
