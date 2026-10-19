import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRagCatalogPatch } from '../rag/catalog/patch.js';
import {
  assertNonEmptyFilter,
  assertScanFilter,
  assertScanOptions,
  DEFAULT_SCAN_PAGE_SIZE,
  decodeIdScanCursor,
  encodeIdScanCursor,
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
  it('rejects a non-string filter value with INVALID_ARGUMENT', () => {
    const r = assertNonEmptyFilter({ userId: 1 } as unknown as {
      userId: string;
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, INVALID_ARGUMENT);
  });
});

describe('assertScanFilter / assertScanOptions', () => {
  it('accepts no filter, an empty filter and string values', () => {
    assert.equal(assertScanFilter(undefined).ok, true);
    assert.equal(assertScanFilter({}).ok, true);
    assert.equal(assertScanFilter({ userId: 'u', namespace: '' }).ok, true);
  });
  it('refuses null, a number, a boolean, an array', () => {
    for (const v of [null, 1, true, ['u']]) {
      const r = assertScanFilter({ sessionId: v } as unknown as {
        sessionId: string;
      });
      assert.equal(r.ok, false, JSON.stringify(v));
      if (!r.ok) assert.equal(r.error.code, INVALID_ARGUMENT);
    }
  });
  it('pageSize must be a positive integer', () => {
    assert.equal(assertScanOptions().ok, true);
    assert.equal(assertScanOptions({ pageSize: 1 }).ok, true);
    for (const pageSize of [0, -1, 1.5, Number.NaN, Infinity]) {
      const r = assertScanOptions({ pageSize });
      assert.equal(r.ok, false, String(pageSize));
      if (!r.ok) assert.equal(r.error.code, INVALID_ARGUMENT);
    }
  });
});

describe('id scan cursor', () => {
  it('round-trips any id', () => {
    for (const id of ['a', '', 'with space', 'ü-ß', '550e8400-e29b']) {
      assert.equal(decodeIdScanCursor(encodeIdScanCursor(id)), id);
    }
  });
  it('rejects a cursor it did not issue', () => {
    for (const c of ['', 'not a cursor!', 'b', '{"x":1}', 'aTp4=', 1]) {
      assert.equal(decodeIdScanCursor(c), undefined, String(c));
    }
  });
});

describe('validateRagCatalogPatch', () => {
  it('refuses an empty patch and an invalid collectionName', () => {
    for (const patch of [
      {},
      { collectionName: undefined, attributes: undefined },
      { collectionName: '' },
      { collectionName: '  ' },
      { collectionName: null },
      { collectionName: 42 },
    ]) {
      const r = validateRagCatalogPatch(
        patch as unknown as { collectionName?: string },
      );
      assert.equal(r.ok, false, JSON.stringify(patch));
      if (!r.ok) assert.equal(r.error.code, INVALID_ARGUMENT);
    }
  });
  it('keeps what is absent and encodes attributes as on create', () => {
    assert.deepEqual(validateRagCatalogPatch({ collectionName: 'N' }), {
      ok: true,
      value: { collectionName: 'N' },
    });
    assert.deepEqual(validateRagCatalogPatch({ attributes: { a: 1 } }), {
      ok: true,
      value: { attributesJson: '{"a":1}' },
    });
  });
  it('refuses attributes that cannot be stored', () => {
    const r = validateRagCatalogPatch({ attributes: { a: Number.NaN } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'RAG_INVALID_ATTRIBUTES');
  });
});

describe('constants', () => {
  it('values', () => {
    assert.equal(RAG_COLLECTION_NOT_FOUND, 'RAG_COLLECTION_NOT_FOUND');
    assert.equal(INVALID_ARGUMENT, 'INVALID_ARGUMENT');
    assert.equal(DEFAULT_SCAN_PAGE_SIZE, 500);
  });
});
