import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hydrateBundle, persistBundle, resetRun } from '../session-bundle.js';
import type { SessionBundle } from '../types.js';

function memBackend() {
  const store = new Map<
    string,
    { content: string; metadata: { artifactType?: string } }[]
  >();
  return {
    put: async (sid: string, e: never) => {
      const a = store.get(sid) ?? [];
      a.push(e as never);
      store.set(sid, a);
    },
    semanticQuery: async () => [],
    scan: async (sid: string) => store.get(sid) ?? [],
    deleteSession: async (sid: string) => {
      store.delete(sid);
    },
  } as never;
}

describe('session-bundle', () => {
  it('hydrate returns a fresh empty bundle when none persisted', async () => {
    const b = await hydrateBundle(memBackend(), 's1');
    assert.equal(b.goal, '');
    assert.equal(b.budgets.stepsUsed, 0);
    assert.equal(b.pending, undefined);
  });

  it('persist then hydrate round-trips the latest bundle', async () => {
    const be = memBackend();
    const bundle: SessionBundle = {
      goal: 'build RAP app',
      plannerPrivate: 'step2 done',
      budgets: { stepsUsed: 3, rewindsUsed: 1 },
      pending: { kind: 'clarify', question: 'which DB?', position: 'step:3' },
    };
    await persistBundle(be, 's1', bundle);
    const got = await hydrateBundle(be, 's1');
    assert.deepEqual(got, bundle);
  });

  it('latest persisted bundle wins over an earlier one', async () => {
    const be = memBackend();
    await persistBundle(be, 's1', {
      goal: 'first',
      plannerPrivate: '',
      budgets: { stepsUsed: 1, rewindsUsed: 0 },
    });
    await persistBundle(be, 's1', {
      goal: 'second',
      plannerPrivate: '',
      budgets: { stepsUsed: 2, rewindsUsed: 0 },
    });
    assert.equal((await hydrateBundle(be, 's1')).goal, 'second');
  });

  it('ignores non-bundle artifacts in the same session', async () => {
    const be = memBackend();
    await persistBundle(be, 's1', {
      goal: 'real goal',
      plannerPrivate: '',
      budgets: { stepsUsed: 1, rewindsUsed: 0 },
    });
    // a memorizer-written artifact lands in the SAME session backend AFTER the bundle:
    await (
      be as unknown as { put: (sid: string, e: unknown) => Promise<void> }
    ).put('s1', {
      content: 'REPORT z.',
      metadata: {
        artifactType: 'code',
        traceId: 's1',
        turnId: 's1',
        stepperId: 'controller',
        task: 't',
        createdAt: 'x',
      },
    });
    const got = await hydrateBundle(be, 's1');
    assert.equal(got.goal, 'real goal'); // not the code artifact
  });

  it('resetRun clears every run-scoped field and starts in evaluating', () => {
    const b = {
      goal: 'old',
      plannerPrivate: 'x',
      budgets: { stepsUsed: 5, rewindsUsed: 2 },
      plan: [{ name: 's', instructions: 'i' }],
      planCursor: 1,
      pending: { kind: 'clarify', question: 'q', position: 'goal' },
      lastOutcome: 'failed',
      runState: 'terminal',
      runPhase: 'finalizing',
      nextSeq: 4,
      inFlightStep: { seq: 3 },
      plannerResumeCount: 9,
      finalizeAttempt: 7,
      legacyFinalAnswer: 'stale',
    } as unknown as SessionBundle;
    resetRun(b, 'new request');
    assert.equal(b.goal, '');
    assert.equal(b.runState, 'active');
    assert.equal(b.runPhase, 'evaluating');
    assert.equal(b.originalRequest, 'new request');
    assert.equal(b.nextSeq, 0);
    assert.equal(b.inFlightStep, undefined);
    assert.equal(b.plannerResumeCount, 0);
    assert.equal(b.finalizeAttempt, 0);
    assert.equal(b.legacyFinalAnswer, undefined);
  });
});
