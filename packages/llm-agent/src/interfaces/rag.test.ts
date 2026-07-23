import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from './rag.js';
import { isBatchSizeLimited } from './rag.js';

const embed = async (): Promise<IEmbedResult> => ({ vector: [1] });

describe('isBatchSizeLimited', () => {
  it('accepts a positive safe integer', () => {
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: 250 }), true);
  });

  it('rejects undefined, zero, negative and fractional values', () => {
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: undefined }), false);
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: 0 }), false);
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: -1 }), false);
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: 1.5 }), false);
  });

  it('rejects an embedder without the property', () => {
    assert.equal(isBatchSizeLimited({ embed }), false);
  });
});
