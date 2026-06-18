import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionId, decisionSlotId, deterministicId } from '../artifacts.js';

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
