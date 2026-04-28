import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCorrectionMetadata,
  deprecateMetadata,
  filterActive,
  validateCorrectionMetadata,
} from '../corrections/metadata.js';

describe('validateCorrectionMetadata', () => {
  it('passes with canonicalKey', () => {
    validateCorrectionMetadata({ canonicalKey: 'k' });
  });
  it('throws when canonicalKey missing', () => {
    assert.throws(() => validateCorrectionMetadata({ canonicalKey: '' }));
  });
});
describe('deprecateMetadata', () => {
  it('adds deprecated tag with reason and timestamp', () => {
    const out = deprecateMetadata({ canonicalKey: 'k' }, 'outdated', 1000);
    assert.deepEqual(out.tags, ['deprecated']);
    assert.equal(out.deprecatedReason, 'outdated');
    assert.equal(out.deprecatedAt, 1000);
  });
  it('is idempotent', () => {
    const once = deprecateMetadata({ canonicalKey: 'k' }, 'r', 1);
    const twice = deprecateMetadata(once, 'r', 1);
    assert.deepEqual(twice.tags, ['deprecated']);
  });
});
describe('buildCorrectionMetadata', () => {
  it('marks predecessor superseded and next as correction', () => {
    const { predecessor, next } = buildCorrectionMetadata({
      predecessor: { canonicalKey: 'k' },
      predecessorId: 'k:v1',
      newEntryId: 'k:v2',
      reason: 'typo fix',
    });
    assert.ok(predecessor.tags?.includes('superseded'));
    assert.equal(predecessor.supersededBy, 'k:v2');
    assert.ok(next.tags?.includes('correction'));
    assert.equal(next.canonicalKey, 'k');
  });
});
describe('filterActive', () => {
  const items = [
    { meta: { canonicalKey: 'a' } },
    { meta: { canonicalKey: 'b', tags: ['deprecated'] } },
    { meta: { canonicalKey: 'c', tags: ['superseded'] } },
    { meta: { canonicalKey: 'd', tags: ['verified'] } },
  ];
  it('hides deprecated and superseded by default', () => {
    const out = filterActive(items, (i) => i.meta);
    assert.deepEqual(
      out.map((i) => i.meta.canonicalKey),
      ['a', 'd'],
    );
  });
  it('returns all when includeInactive is true', () => {
    const out = filterActive(items, (i) => i.meta, {
      includeInactive: true,
    });
    assert.equal(out.length, 4);
  });
});
//# sourceMappingURL=corrections-metadata.test.js.map
