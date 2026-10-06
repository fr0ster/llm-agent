import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isIndexNoteSource, isSizeBoundedCut } from '../collection-profile.js';

const estimator = { name: 'e', estimate: () => 1 };
const countCut = { name: 'top', limit: (k: number) => k, cut: () => [] };

describe('optional capabilities (S1, S6)', () => {
  it('isIndexNoteSource: an object with a notesFor function', () => {
    assert.equal(isIndexNoteSource({ notesFor: () => [] }), true);
    for (const v of [undefined, null, {}, { notesFor: 1 }])
      assert.equal(isIndexNoteSource(v), false);
  });
  it('isSizeBoundedCut: a positive integer budget and an estimator', () => {
    assert.equal(
      isSizeBoundedCut({ ...countCut, budgetTokens: 100, estimator }),
      true,
    );
    assert.equal(isSizeBoundedCut(countCut), false);
    assert.equal(
      isSizeBoundedCut({ ...countCut, budgetTokens: 0, estimator }),
      false,
    );
    assert.equal(isSizeBoundedCut({ ...countCut, budgetTokens: 100 }), false);
  });
});
