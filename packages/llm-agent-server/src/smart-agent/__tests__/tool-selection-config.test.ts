import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveToolSelectionStrategy } from '../config.js';

describe('resolveToolSelectionStrategy', () => {
  it('resolves top-k', () => {
    assert.equal(resolveToolSelectionStrategy('top-k').name, 'top-k');
  });
  it('resolves threshold with minScore', () => {
    const s = resolveToolSelectionStrategy('threshold', { minScore: 0.3 });
    assert.equal(s.name, 'threshold');
  });
  it('throws when threshold has no minScore', () => {
    assert.throws(() => resolveToolSelectionStrategy('threshold'), /minScore/);
  });
  it('throws on unknown strategy', () => {
    assert.throws(
      () => resolveToolSelectionStrategy('bogus'),
      /Allowed: top-k, threshold/,
    );
  });
});
