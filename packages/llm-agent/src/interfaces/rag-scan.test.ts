import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertNonEmptyFilter,
  DEFAULT_SCAN_PAGE_SIZE,
  INVALID_ARGUMENT,
  isRagCatalogUpdater,
  isRagFilteredDeleter,
  isRagScanner,
  matchesScanFilter,
  RAG_COLLECTION_NOT_FOUND,
} from './rag-scan.js';

describe('rag-scan guards', () => {
  it('isRagScanner', () => {
    assert.equal(isRagScanner({ scan: () => {} }), true);
    assert.equal(isRagScanner({}), false);
    assert.equal(isRagScanner({ scan: 1 }), false);
    assert.equal(isRagScanner(null), false);
  });
  it('isRagFilteredDeleter', () => {
    assert.equal(isRagFilteredDeleter({ deleteWhere: () => {} }), true);
    assert.equal(isRagFilteredDeleter({}), false);
    assert.equal(isRagFilteredDeleter('x'), false);
  });
  it('isRagCatalogUpdater', () => {
    assert.equal(isRagCatalogUpdater({ updateCollection: () => {} }), true);
    assert.equal(isRagCatalogUpdater({}), false);
    assert.equal(isRagCatalogUpdater(undefined), false);
  });
});

describe('matchesScanFilter', () => {
  it('is strict: number 123 does not match "123"', () => {
    assert.equal(matchesScanFilter({ userId: 123 }, { userId: '123' }), false);
  });
  it('matches equal strings', () => {
    assert.equal(matchesScanFilter({ userId: 'a' }, { userId: 'a' }), true);
  });
  it('unset filter matches all', () => {
    assert.equal(matchesScanFilter({ userId: 'a' }, undefined), true);
    assert.equal(matchesScanFilter({}, {}), true);
  });
  it('requires every set field', () => {
    const m = { userId: 'a', sessionId: 's', namespace: 'n' };
    assert.equal(matchesScanFilter(m, { userId: 'a', sessionId: 'x' }), false);
    assert.equal(matchesScanFilter(m, { userId: 'a', namespace: 'n' }), true);
  });
});

describe('assertNonEmptyFilter', () => {
  it('rejects an empty filter with INVALID_ARGUMENT', () => {
    const r = assertNonEmptyFilter({});
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, INVALID_ARGUMENT);
  });
  it('accepts a filter with a field', () => {
    assert.equal(assertNonEmptyFilter({ userId: 'u' }).ok, true);
  });
});

describe('constants', () => {
  it('values', () => {
    assert.equal(RAG_COLLECTION_NOT_FOUND, 'RAG_COLLECTION_NOT_FOUND');
    assert.equal(INVALID_ARGUMENT, 'INVALID_ARGUMENT');
    assert.equal(DEFAULT_SCAN_PAGE_SIZE, 500);
  });
});
