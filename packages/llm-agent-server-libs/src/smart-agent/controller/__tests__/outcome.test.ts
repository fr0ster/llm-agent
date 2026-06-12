import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Outcome, resolveByPrecedence } from '../outcome.js';

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
