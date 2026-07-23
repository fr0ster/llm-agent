import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isToolCatalogReporter } from './tool-catalog.js';

describe('isToolCatalogReporter', () => {
  it('accepts an object with the method', () => {
    assert.equal(
      isToolCatalogReporter({ getToolCatalogStatus: () => undefined }),
      true,
    );
  });

  it('rejects null, primitives and objects without the method', () => {
    assert.equal(isToolCatalogReporter(null), false);
    assert.equal(isToolCatalogReporter('x'), false);
    assert.equal(isToolCatalogReporter({}), false);
  });
});
