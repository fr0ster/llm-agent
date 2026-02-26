import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryRag } from '../in-memory-rag.js';

describe('InMemoryRag', () => {
  describe('upsert + query basic', () => {
    it('stores text and retrieves it', async () => {
      const rag = new InMemoryRag();
      await rag.upsert('the quick brown fox', {});
      const result = await rag.query('quick brown fox', 5);
      assert.ok(result.ok);
      assert.equal(result.value.length, 1);
      assert.equal(result.value[0].text, 'the quick brown fox');
      assert.ok(result.value[0].score > 0);
    });
  });

  describe('top-k ordering', () => {
    it('returns results sorted by score descending', async () => {
      const rag = new InMemoryRag({ dedupThreshold: 0.99 });
      await rag.upsert('cat sat on the mat', {});
      await rag.upsert('the quick brown fox jumped', {});
      await rag.upsert('cat mat', {});

      const result = await rag.query('cat mat', 3);
      assert.ok(result.ok);
      assert.equal(result.value.length, 3);

      for (let i = 0; i < result.value.length - 1; i++) {
        assert.ok(
          result.value[i].score >= result.value[i + 1].score,
          `score[${i}]=${result.value[i].score} < score[${i + 1}]=${result.value[i + 1].score}`,
        );
      }

      // The most similar text should be ranked first
      assert.equal(result.value[0].text, 'cat mat');
    });
  });

  describe('dedup — same text', () => {
    it('results in 1 record after 3 upserts of the same text', async () => {
      const rag = new InMemoryRag();
      await rag.upsert('hello world', {});
      await rag.upsert('hello world', {});
      await rag.upsert('hello world', {});

      const result = await rag.query('hello world', 10);
      assert.ok(result.ok);
      assert.equal(result.value.length, 1);
    });
  });

  describe('dedup — similar text', () => {
    it('updates existing record instead of creating a duplicate', async () => {
      const rag = new InMemoryRag({ dedupThreshold: 0.8 });
      await rag.upsert('machine learning algorithms', { source: 'v1' });
      await rag.upsert('machine learning algorithms overview', {
        source: 'v2',
      });

      const result = await rag.query('machine learning algorithms', 10);
      assert.ok(result.ok);
      assert.equal(result.value.length, 1);
      // metadata should be merged (newer wins)
      assert.equal(result.value[0].metadata.source, 'v2');
    });
  });

  describe('dedup — different text', () => {
    it('creates a new record for sufficiently different text', async () => {
      const rag = new InMemoryRag({ dedupThreshold: 0.99 });
      await rag.upsert('apple banana cherry', {});
      await rag.upsert('dog cat fish bird', {});

      const result = await rag.query('apple', 10);
      assert.ok(result.ok);
      assert.equal(result.value.length, 2);
    });
  });

  describe('TTL — expired excluded', () => {
    it('does not return records with expired TTL', async () => {
      const rag = new InMemoryRag();
      const pastTtl = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
      await rag.upsert('expired record', { ttl: pastTtl });

      const result = await rag.query('expired record', 10);
      assert.ok(result.ok);
      assert.equal(result.value.length, 0);
    });
  });

  describe('TTL — not expired', () => {
    it('returns records with TTL in the future', async () => {
      const rag = new InMemoryRag();
      const futureTtl = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      await rag.upsert('fresh record', { ttl: futureTtl });

      const result = await rag.query('fresh record', 10);
      assert.ok(result.ok);
      assert.equal(result.value.length, 1);
    });
  });

  describe('namespace isolation', () => {
    it('store with namespace=a does not see records from namespace=b', async () => {
      const ragA = new InMemoryRag({ namespace: 'a' });
      const ragB = new InMemoryRag({ namespace: 'b' });

      await ragA.upsert('shared topic alpha', {});
      await ragB.upsert('shared topic beta', {});

      const resultA = await ragA.query('shared topic', 10);
      assert.ok(resultA.ok);
      assert.equal(resultA.value.length, 1);
      assert.equal(resultA.value[0].text, 'shared topic alpha');

      const resultB = await ragB.query('shared topic', 10);
      assert.ok(resultB.ok);
      assert.equal(resultB.value.length, 1);
      assert.equal(resultB.value[0].text, 'shared topic beta');
    });
  });

  describe('memory growth bounded', () => {
    it('1000 upserts of the same text → 1 record', async () => {
      const rag = new InMemoryRag();
      for (let i = 0; i < 1000; i++) {
        await rag.upsert('repeated text content', {});
      }

      const result = await rag.query('repeated text content', 10);
      assert.ok(result.ok);
      assert.equal(result.value.length, 1);
    });
  });

  describe('empty store query', () => {
    it('returns empty array when store has no records', async () => {
      const rag = new InMemoryRag();
      const result = await rag.query('anything', 5);
      assert.ok(result.ok);
      assert.deepEqual(result.value, []);
    });
  });

  describe('AbortSignal upsert', () => {
    it('returns ABORTED error when signal is pre-aborted', async () => {
      const rag = new InMemoryRag();
      const controller = new AbortController();
      controller.abort();

      const result = await rag.upsert(
        'some text',
        {},
        { signal: controller.signal },
      );
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'ABORTED');
    });
  });

  describe('AbortSignal query', () => {
    it('returns ABORTED error when signal is pre-aborted', async () => {
      const rag = new InMemoryRag();
      await rag.upsert('some text', {});

      const controller = new AbortController();
      controller.abort();

      const result = await rag.query('some text', 5, {
        signal: controller.signal,
      });
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'ABORTED');
    });
  });
});
