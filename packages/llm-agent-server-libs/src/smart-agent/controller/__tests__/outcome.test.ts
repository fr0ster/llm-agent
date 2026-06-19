import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Outcome,
  projectStepState,
  resolveByPrecedence,
} from '../outcome.js';

const mk = (status: Outcome['status'], approved = ''): Outcome => ({
  status,
  approved,
  remainder: '',
  note: '',
});

describe('resolveByPrecedence', () => {
  it('prefers ok/exists over partial over failed', () => {
    assert.equal(
      resolveByPrecedence([mk('failed'), mk('partial'), mk('ok')])?.status,
      'ok',
    );
    assert.equal(
      resolveByPrecedence([mk('failed'), mk('partial')])?.status,
      'partial',
    );
    assert.equal(resolveByPrecedence([mk('failed')])?.status, 'failed');
  });
  it('treats exists at the same rank as ok (tie-break: latest wins)', () => {
    const r = resolveByPrecedence([mk('ok', 'first'), mk('exists', 'second')]);
    assert.equal(r?.approved, 'second');
  });
  it('returns undefined for an empty list', () => {
    assert.equal(resolveByPrecedence([]), undefined);
  });
});

describe('projectStepState', () => {
  it('maps a settled outcome to the board terminal state', () => {
    assert.equal(projectStepState('ok'), 'done');
    assert.equal(projectStepState('exists'), 'done');
    assert.equal(projectStepState('partial'), 'partial');
    assert.equal(projectStepState('failed'), 'failed');
  });
});
