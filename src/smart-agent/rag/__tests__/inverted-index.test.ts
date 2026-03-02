import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvertedIndex } from '../inverted-index.js';

describe('InvertedIndex', () => {
  describe('add', () => {
    it('tracks document frequency for each term', () => {
      const idx = new InvertedIndex();
      idx.add(0, ['hello', 'world']);
      idx.add(1, ['hello', 'foo']);

      assert.equal(idx.getDocFrequency('hello'), 2);
      assert.equal(idx.getDocFrequency('world'), 1);
      assert.equal(idx.getDocFrequency('foo'), 1);
      assert.equal(idx.getDocFrequency('missing'), 0);
    });

    it('counts unique terms per document (no double-counting)', () => {
      const idx = new InvertedIndex();
      idx.add(0, ['cat', 'cat', 'cat']);
      assert.equal(idx.getDocFrequency('cat'), 1);
    });

    it('updates docCount correctly', () => {
      const idx = new InvertedIndex();
      assert.equal(idx.docCount, 0);
      idx.add(0, ['a', 'b']);
      assert.equal(idx.docCount, 1);
      idx.add(1, ['c']);
      assert.equal(idx.docCount, 2);
    });
  });

  describe('avgDocLength', () => {
    it('computes average across all docs', () => {
      const idx = new InvertedIndex();
      idx.add(0, ['a', 'b', 'c']); // length 3
      idx.add(1, ['d']); // length 1
      // avg = (3 + 1) / 2 = 2
      assert.equal(idx.avgDocLength, 2);
    });

    it('returns 0 for empty index', () => {
      const idx = new InvertedIndex();
      assert.equal(idx.avgDocLength, 0);
    });
  });

  describe('update', () => {
    it('adjusts DF when document text changes', () => {
      const idx = new InvertedIndex();
      idx.add(0, ['hello', 'world']);
      idx.add(1, ['hello', 'foo']);

      assert.equal(idx.getDocFrequency('hello'), 2);
      assert.equal(idx.getDocFrequency('world'), 1);

      // Update doc 0: replace "hello world" with "bar world"
      idx.update(0, ['hello', 'world'], ['bar', 'world']);

      assert.equal(idx.getDocFrequency('hello'), 1); // only doc 1 now
      assert.equal(idx.getDocFrequency('world'), 1); // still in doc 0
      assert.equal(idx.getDocFrequency('bar'), 1); // new term
    });

    it('updates avgDocLength after document change', () => {
      const idx = new InvertedIndex();
      idx.add(0, ['a', 'b']); // length 2
      idx.add(1, ['c', 'd']); // length 2
      assert.equal(idx.avgDocLength, 2);

      // Update doc 0 to have 4 tokens
      idx.update(0, ['a', 'b'], ['a', 'b', 'c', 'd']);
      // avg = (4 + 2) / 2 = 3
      assert.equal(idx.avgDocLength, 3);
    });

    it('removes term from DF map when no docs contain it', () => {
      const idx = new InvertedIndex();
      idx.add(0, ['unique']);
      assert.equal(idx.getDocFrequency('unique'), 1);

      idx.update(0, ['unique'], ['other']);
      assert.equal(idx.getDocFrequency('unique'), 0);
      assert.equal(idx.getDocFrequency('other'), 1);
    });
  });

  describe('getDocFrequency', () => {
    it('returns 0 for unknown terms', () => {
      const idx = new InvertedIndex();
      assert.equal(idx.getDocFrequency('nonexistent'), 0);
    });
  });
});
