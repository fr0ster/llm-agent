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

test('disposeAll closes the registry; subsequent acquire rejects with SESSION_REGISTRY_CLOSED', async () => {
  const { reg } = makeRegistry();
  await reg.acquire('s1');
  reg.release('s1');
  await reg.disposeAll();
  await assert.rejects(
    () => reg.acquire('s2'),
    (err: unknown) => {
      // OrchestratorError carries code='SESSION_REGISTRY_CLOSED'.
      const e = err as { code?: string; message?: string };
      return (
        e.code === 'SESSION_REGISTRY_CLOSED' && /closed/i.test(e.message ?? '')
      );
    },
  );
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
  // The acquire's post-await continuation MUST reject because disposeAll
  // closed the registry while the build was pending (race fix MEDIUM #8).
  await assert.rejects(() => acquired, /closed|disposed/i);
  await dispose;
  assert.deepEqual(
    disposed,
    ['slow'],
    'graph resolved during disposeAll() is disposed, not orphaned',
  );
  assert.equal(reg.size, 0);
});

test('Fix #19: race — in-flight build invalidated by invalidateAll() is disposed, not published', async () => {
  // Sequence:
  //   1. acquire('s1') starts; build is gated.
  //   2. invalidateAll() runs (e.g. PUT /v1/config); clears pendingBuilds + graphs.
  //   3. The gated build resolves. Without the generation marker, its .then
  //      would graphs.set('s1', resolvedGraph) AND the awaiting acquire would
  //      return the stale graph (built with OLD config). With the marker, the
  //      build's .then sees generation changed → disposes the graph and
  //      does NOT publish; the awaiting acquire rejects with
  //      SESSION_INVALIDATED.
  const disposed: string[] = [];
  let resolveBuild: ((g: SessionGraph) => void) | undefined;
  const buildPromise = new Promise<SessionGraph>((r) => {
    resolveBuild = r;
  });
  const gatedFactory = {
    build: (_identity: { sessionId: string }) => buildPromise,
  };
  const reg = new SessionRegistry({
    idleTtlMs: 10_000,
    maxSessions: 10,
    factory: gatedFactory,
  });

  // Caller A: gated acquire.
  const acquirePromise = reg.acquire('s1');
  // Caller B: config-reload invalidation while the build is still pending.
  await Promise.resolve();
  await reg.invalidateAll();

  // Resolve the build AFTER invalidateAll.
  const g = new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger: new SessionRequestLogger(),
    dispose: async (id) => {
      disposed.push(id);
    },
  });
  resolveBuild?.(g);

  // The original acquire must reject — it cannot return a graph that was
  // built with the old config.
  await assert.rejects(
    () => acquirePromise,
    /SESSION_INVALIDATED|invalidated/i,
  );
  // The resolved graph must be disposed (drained), not orphaned in graphs.
  // Allow the .then() and dispose microtasks to run.
  await reg.flushEvictions();
  // The graph from the orphaned build was disposed exactly once.
  assert.deepEqual(
    disposed,
    ['s1'],
    'orphaned build result is disposed (not published)',
  );
  assert.equal(reg.size, 0, 'graphs map empty after invalidate + orphan drain');
});

test('race: in-flight acquire rejects when disposeAll completes during the build (MEDIUM #8)', async () => {
  const disposed: string[] = [];
  let resolveBuild: ((g: SessionGraph) => void) | undefined;
  const buildPromise = new Promise<SessionGraph>((r) => {
    resolveBuild = r;
  });
  const gatedFactory = {
    build: (_identity: { sessionId: string }) => buildPromise,
  };
  const reg = new SessionRegistry({
    idleTtlMs: 10_000,
    maxSessions: 10,
    factory: gatedFactory,
  });
  // Caller A: kick off an acquire whose build is gated.
  const acquirePromise = reg.acquire('s1');
  // Caller B: disposeAll starts; it awaits pendingBuilds.
  const disposePromise = reg.disposeAll();
  // Allow microtasks to run so disposeAll is parked on Promise.allSettled.
  await Promise.resolve();
  // Resolve the build with a real graph — disposeAll proceeds, inserts and
  // then disposes it.
  const g = new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger: new SessionRequestLogger(),
    dispose: async (id) => {
      disposed.push(id);
    },
  });
  resolveBuild?.(g);
  await disposePromise;
  // Caller A's continuation must reject (registry closed / graph disposed).
  await assert.rejects(() => acquirePromise, /closed|disposed/i);
  assert.deepEqual(disposed, ['s1']);
});

test('Fix #20: stale invalidated build does NOT evict the newer in-flight build for same sessionId', async () => {
  // Sequence:
  //  1. acquire('s1') starts build A (gated).
  //  2. invalidateAll() runs — bumps generation, clears pendingBuilds.
  //  3. acquire('s1') starts build B (gated). pendingBuilds.set('s1', B).
  //  4. Build A resolves → its .then sees gen mismatch and used to
  //     unconditionally pendingBuilds.delete('s1') — evicting B!
  //  5. After the fix, A's cleanup is conditional and B remains in
  //     pendingBuilds. A third concurrent acquire('s1') joins build B
  //     (single-flight preserved). Resolving B publishes the graph.
  const disposed: string[] = [];

  let resolveA: ((g: SessionGraph) => void) | undefined;
  const promiseA = new Promise<SessionGraph>((r) => {
    resolveA = r;
  });
  let resolveB: ((g: SessionGraph) => void) | undefined;
  const promiseB = new Promise<SessionGraph>((r) => {
    resolveB = r;
  });
  let calls = 0;
  const factory = {
    build: (_id: { sessionId: string }) => {
      calls++;
      return calls === 1 ? promiseA : promiseB;
    },
  };
  const reg = new SessionRegistry({
    idleTtlMs: 10_000,
    maxSessions: 10,
    factory,
  });

  // Step 1: kick off acquire A (build A gated).
  const acquireA = reg.acquire('s1');
  // Step 2: invalidateAll while A is still pending.
  await Promise.resolve();
  await reg.invalidateAll();
  // Step 3: kick off acquire B (a fresh build because pendingBuilds was cleared).
  const acquireB = reg.acquire('s1');
  await Promise.resolve();
  assert.equal(calls, 2, 'a fresh build was started for s1 after invalidate');

  // Step 4: resolve A AFTER B is registered.
  const ga = new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger: new SessionRequestLogger(),
    dispose: async (id) => {
      disposed.push(`A:${id}`);
    },
  });
  resolveA?.(ga);
  await assert.rejects(() => acquireA, /SESSION_INVALIDATED|invalidated/i);
  // Allow A's cleanup microtasks to settle.
  await reg.flushEvictions();

  // Step 5: a concurrent third acquire MUST join build B (single-flight).
  const acquireC = reg.acquire('s1');

  // Now resolve B. B should publish into graphs, and both B and C acquires
  // return the same graph instance.
  const gb = new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger: new SessionRequestLogger(),
    dispose: async (id) => {
      disposed.push(`B:${id}`);
    },
  });
  resolveB?.(gb);

  const [gB, gC] = await Promise.all([acquireB, acquireC]);
  assert.equal(gB, gb, 'acquireB receives the build-B graph');
  assert.equal(
    gC,
    gb,
    'a third acquire that arrived BEFORE B resolved joins build B (single-flight survived)',
  );
  assert.equal(calls, 2, 'no additional build was started for s1');
  assert.equal(reg.size, 1);

  // Build A's resolved graph was disposed (orphan); B's was not.
  assert.deepEqual(disposed, ['A:s1']);
});
