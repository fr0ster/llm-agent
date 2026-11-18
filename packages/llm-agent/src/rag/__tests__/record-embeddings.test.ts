import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IBatchSizeLimited,
  IEmbedderBatch,
} from '../../interfaces/rag.js';
import { DefaultWaitStrategy } from '../../interfaces/wait-strategy.js';
import { composeResilientEmbedder } from '../../resilience/embedder-resilience.js';
import { embedRecord } from '../record-embedding.js';
import { symmetricEmbedder } from '../retrieval-embedder.js';
import { VectorOnlyStrategy } from '../search-strategy.js';
import { VectorRag } from '../vector-rag.js';

test('stores the whole record once and uses its best fragment for vector ranking', async () => {
  const calls: string[][] = [];
  const vector = (text: string) => (text.includes('finish') ? [0, 1] : [1, 0]);
  const embedder: IEmbedderBatch & IBatchSizeLimited = {
    maxBatchSize: 2,
    async getMaxInputChars() {
      return 8;
    },
    async embed(text) {
      calls.push([text]);
      return { vector: vector(text) };
    },
    async embedBatch(texts) {
      calls.push(texts);
      return texts.map((text) => ({ vector: vector(text) }));
    },
  };
  const full = 'early\n\nmiddle\n\nfinish';
  const rag = new VectorRag(
    symmetricEmbedder(composeResilientEmbedder(embedder, { maxInputChars: 2 })),
    { strategy: new VectorOnlyStrategy() },
  );
  assert.ok(
    (await rag.upsertPrecomputed('legacy', [1, 1], { id: 'legacy' })).ok,
  );
  assert.ok((await rag.upsert(full, { id: 'long' })).ok);
  assert.deepEqual(calls, [['early\n\n', 'middle\n\n'], ['finish']]);
  const lookup = { text: 'finish', toVector: async () => [0, 1] };
  const search = await rag.query(lookup, 2);
  const byId = await rag.getById('long');
  const list = await rag.list({ includeText: true });
  const scan = await rag.scan();
  assert.ok(search.ok && byId.ok && list.ok && scan.ok);
  assert.deepEqual(
    search.value.map((hit) => hit.text),
    [full, 'legacy'],
  );
  assert.equal(search.value[0]?.score, 1);
  assert.equal(byId.value?.text, full);
  assert.deepEqual(list.value.records.map((r) => r.text).sort(), [
    full,
    'legacy',
  ]);
  assert.deepEqual(scan.value.records.map((r) => r.text).sort(), [
    full,
    'legacy',
  ]);

  assert.ok((await rag.upsert('short', { id: 'long' })).ok);
  assert.deepEqual(calls.at(-1), ['short']);
  const replaced = await rag.query(lookup, 1);
  assert.ok(replaced.ok);
  assert.equal(replaced.value[0]?.text, 'legacy');

  assert.ok((await rag.upsert(full, { id: 'long' })).ok);
  assert.ok((await rag.writer().deleteByIdRaw('long')).ok);
  const deleted = await rag.query(lookup, 2);
  assert.ok(deleted.ok);
  assert.deepEqual(
    deleted.value.map((hit) => hit.text),
    ['legacy'],
  );
});

test('falls back to the configured character size and preserves Unicode and all line endings', async () => {
  const seen: string[] = [];
  const embedder = symmetricEmbedder(
    composeResilientEmbedder(
      {
        async embed(text) {
          seen.push(text);
          return { vector: [1] };
        },
      },
      { maxInputChars: 1 },
    ),
  );
  const emoji = '\u{1F33F}';
  const text = `a\r\n\r\n${emoji.repeat(9)}\n tail\n`;
  const vectors = await embedRecord(embedder, text, 8);
  assert.equal(vectors.length, seen.length);
  assert.deepEqual(seen, ['a\r\n\r\n', emoji.repeat(8), `${emoji}\n tail\n`]);
  assert.equal(seen.join(''), text);
  assert.ok(seen.every((fragment) => [...fragment].length <= 8));
});

test('a failed fragment batch leaves the previous record intact', async () => {
  const rag = new VectorRag(
    symmetricEmbedder({
      async embed() {
        return { vector: [1] };
      },
      async embedBatch() {
        return [];
      },
    }),
    { fragmentSizeChars: 4 },
  );
  assert.ok((await rag.upsert('old', { id: 'r' })).ok);
  const result = await rag.upsert('long replacement input', { id: 'r' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'UPSERT_ERROR');
  const existing = await rag.getById('r');
  assert.ok(existing.ok);
  assert.equal(existing.value?.text, 'old');
});

test('fragment writes honor Retry-After past the ordinary retry count and cancel on abort', async (t) => {
  const waits: number[] = [];
  const controller = new AbortController();
  t.mock.method(
    DefaultWaitStrategy.prototype,
    'wait',
    async (ms: number, signal?: AbortSignal) => {
      waits.push(ms);
      if (signal === controller.signal)
        controller.abort(new Error('cancelled'));
      return signal?.aborted ? 'aborted' : 'elapsed';
    },
  );
  let calls = 0;
  const embedder = symmetricEmbedder(
    composeResilientEmbedder({
      async embed() {
        if (++calls <= 6 || controller.signal.aborted)
          throw Object.assign(new Error('busy'), {
            status: 429,
            headers: { 'Retry-After': '7' },
          });
        return { vector: [1] };
      },
    }),
  );
  assert.deepEqual(await embedRecord(embedder, 'aaaa', 2), [[1], [1]]);
  assert.equal(calls, 8);
  assert.deepEqual(
    waits,
    Array.from({ length: 6 }, () => 7000),
  );

  let abortedCalls = 0;
  await assert.rejects(
    embedRecord(
      {
        async embedDocument() {
          abortedCalls++;
          throw Object.assign(new Error('busy'), {
            status: 429,
            retryAfterSeconds: 7,
          });
        },
      },
      'aaaa',
      2,
      { signal: controller.signal },
    ),
    /cancelled/,
  );
  assert.equal(abortedCalls, 1);
  assert.equal(waits.at(-1), 7000);
});
