import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decisionId,
  decisionSlotId,
  decisionWinner,
  deterministicId,
  type PlanDecision,
  readClaims,
  readPlanDecisions,
  writePlanDecision,
  writeStepStartClaim,
} from '../artifacts.js';

test('deterministicId is stable + order-sensitive + collision-resistant on segments', () => {
  assert.equal(
    deterministicId('run1', 'create'),
    deterministicId('run1', 'create'),
  );
  assert.notEqual(
    deterministicId('run1', 'create'),
    deterministicId('run1', 'replan'),
  );
  // segment boundary is unambiguous: ['a','bc'] !== ['ab','c']
  assert.notEqual(deterministicId('a', 'bc'), deterministicId('ab', 'c'));
});

test('decisionSlotId follows the §F kind table', () => {
  assert.equal(
    decisionSlotId({ kind: 'create', runId: 'r' }),
    deterministicId('r', 'create'),
  );
  assert.equal(
    decisionSlotId({ kind: 'replan', runId: 'r', anchor: 'sX' }),
    deterministicId('r', 'replan', 'anchor', 'sX'),
  );
  assert.equal(
    decisionSlotId({ kind: 'replan', runId: 'r', triggerId: 'tg' }),
    deterministicId('r', 'replan', 'trigger', 'tg'),
  );
  assert.notEqual(
    decisionSlotId({ kind: 'replan', runId: 'r', anchor: 'x' }),
    decisionSlotId({ kind: 'replan', runId: 'r', triggerId: 'x' }),
  );
  assert.equal(
    decisionSlotId({
      kind: 'expand',
      runId: 'r',
      discoveryStepId: 'd',
      offset: 5,
    }),
    deterministicId('r', 'expand', 'd', 5),
  );
  assert.equal(
    decisionSlotId({
      kind: 'page',
      runId: 'r',
      discoveryChainId: 'c',
      pageIndex: 2,
      tokenHash: 'th',
    }),
    deterministicId('r', 'page', 'c', 2),
  );
});

test('decisionId folds plannerOutput for LLM-authored kinds, omits it for page', () => {
  const a = decisionId({ kind: 'create', runId: 'r' }, 'PLAN-A');
  const b = decisionId({ kind: 'create', runId: 'r' }, 'PLAN-B');
  assert.notEqual(a, b);
  const p = decisionId(
    {
      kind: 'page',
      runId: 'r',
      discoveryChainId: 'c',
      pageIndex: 2,
      tokenHash: 'th',
    },
    'ignored',
  );
  assert.equal(p, deterministicId('r', 'page', 'c', 2, 'th'));
});

function fakeBackend() {
  const rows: { content: string; metadata: Record<string, unknown> }[] = [];
  return {
    rows,
    put: async (
      _sid: string,
      e: { content: string; metadata: Record<string, unknown> },
    ) => {
      rows.push(e);
    },
    list: async (f: { runId?: string; artifactType?: string }) =>
      rows.filter(
        (r) =>
          (!f.runId || r.metadata.runId === f.runId) &&
          (!f.artifactType || r.metadata.artifactType === f.artifactType),
      ),
  };
}

test('writePlanDecision persists kind/decisionId/slotId + steps; readPlanDecisions returns them', async () => {
  const be = fakeBackend();
  const dec: PlanDecision = {
    runId: 'r',
    kind: 'create',
    steps: [{ stepId: 's1', name: 'Fetch', instructions: 'read' }],
  };
  await writePlanDecision(be as never, 'sess', dec, 'PLAN-A', 'now', 1);
  const got = await readPlanDecisions(be as never, 'r');
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'create');
  assert.equal(got[0].slotId, deterministicId('r', 'create'));
  assert.equal(got[0].decisionId, deterministicId('r', 'create', 'PLAN-A'));
  assert.equal(got[0].steps[0].stepId, 's1');
});

test('decisionWinner = the decisionId of the FIRST claim for a slot (attempt-independent)', async () => {
  const be = fakeBackend();
  const base = { runId: 'r', slotId: 'slot1', stepId: 's1', seq: 0 };
  await writeStepStartClaim(
    be as never,
    'sess',
    { ...base, attempt: 0, decisionId: 'decA' },
    'now',
    1,
  );
  await writeStepStartClaim(
    be as never,
    'sess',
    { ...base, attempt: 0, decisionId: 'decB' },
    'now',
    2,
  );
  const claims = await readClaims(be as never, 'r');
  assert.equal(decisionWinner(claims, 'slot1'), 'decA');
  await writeStepStartClaim(
    be as never,
    'sess',
    { ...base, attempt: 1, decisionId: 'decA' },
    'now',
    3,
  );
  assert.equal(
    decisionWinner(await readClaims(be as never, 'r'), 'slot1'),
    'decA',
  );
});
