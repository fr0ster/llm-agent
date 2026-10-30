import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RagResult } from '@mcp-abap-adt/llm-agent';
import { RecordCache } from '../record-cache.js';

const record = (text = 'value'): RagResult => ({
  text,
  metadata: { id: 'a', nested: { values: [1] } },
  score: 1,
});
function put(
  cache: RecordCache,
  store: string,
  id: string,
  value = record(),
): void {
  const handle = cache.store(store);
  const lease = handle.beginRead(id);
  handle.endRead(id, lease, value);
}
describe('record cache bounds, TTL and coordination', () => {
  it('validates positive finite safe integer limits', () => {
    for (const key of ['maxEntries', 'maxBytes', 'ttlMs'] as const)
      for (const value of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ])
        assert.throws(() => new RecordCache({ [key]: value }), RangeError);
    const cache = new RecordCache();
    assert.equal(cache.maxEntries, 1000);
    assert.equal(cache.maxBytes, 16 * 1024 * 1024);
    assert.equal(cache.ttlMs, 5000);
  });
  it('expires from read start without sliding and rejects already expired reads', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const cache = new RecordCache({ ttlMs: 100 });
    const store = cache.store('s');
    const lease = store.beginRead('a');
    t.mock.timers.tick(40);
    store.endRead('a', lease, record());
    t.mock.timers.tick(59);
    assert.ok(store.get('a'));
    t.mock.timers.tick(1);
    assert.equal(store.get('a'), undefined);
    const slow = store.beginRead('a');
    t.mock.timers.tick(100);
    store.endRead('a', slow, record());
    assert.equal(store.get('a'), undefined);
  });
  it('bounds entries by LRU across stores and bounds UTF-8 bytes', () => {
    const cache = new RecordCache({ maxEntries: 2 });
    put(cache, 's', 'a');
    put(cache, 's', 'b');
    assert.ok(cache.store('s').get('a'));
    put(cache, 'other', 'c');
    assert.equal(cache.store('s').get('b'), undefined);
    assert.ok(cache.store('s').get('a'));
    const value = record('你好');
    const bytes = Buffer.byteLength(
      JSON.stringify({ text: value.text, metadata: value.metadata }),
    );
    const bounded = new RecordCache({ maxBytes: bytes });
    put(bounded, 's', 'a', value);
    put(bounded, 's', 'b', value);
    assert.equal(bounded.store('s').get('a'), undefined);
    assert.ok(bounded.store('s').get('b'));
    put(bounded, 's', 'huge', record('x'.repeat(bytes)));
    assert.equal(bounded.store('s').get('huge'), undefined);
    assert.ok(bounded.store('s').get('b'));
  });
  it('detaches insertion/retrieval and skips unsafe metadata and disabled caches', () => {
    const cache = new RecordCache();
    const value = record();
    put(cache, 's', 'a', value);
    value.metadata.nested = { values: [9] };
    const copy = cache.store('s').get('a');
    assert.ok(copy);
    assert.deepEqual(copy.metadata.nested, { values: [1] });
    copy.metadata.nested = null;
    assert.deepEqual(cache.store('s').get('a')?.metadata.nested, {
      values: [1],
    });
    put(cache, 's', 'unsafe', { ...record(), metadata: { fn: () => 1 } });
    assert.equal(cache.store('s').get('unsafe'), undefined);
    const disabled = new RecordCache(false);
    put(disabled, 's', 'a');
    assert.equal(disabled.store('s').get('a'), undefined);
  });
  it('invalidates only written ids and rejects reads before/during overlapping writes', () => {
    const cache = new RecordCache();
    const store = cache.store('s');
    put(cache, 's', 'a');
    put(cache, 's', 'b');
    put(cache, 'other', 'a');
    const before = store.beginRead('a');
    const first = store.beginWrite(['a']);
    const during = store.beginRead('a');
    const second = store.beginWrite(['a']);
    assert.equal(store.get('a'), undefined);
    assert.ok(store.get('b'));
    assert.ok(cache.store('other').get('a'));
    first();
    store.endRead('a', before, record('old'));
    second();
    store.endRead('a', during, record('old'));
    assert.equal(store.get('a'), undefined);
    put(cache, 's', 'a', record('new'));
    assert.equal(store.get('a')?.text, 'new');
  });
  it('clear and deletion suppress late reads and old handles; shutdown releases all stores', () => {
    const cache = new RecordCache();
    const store = cache.store('s');
    put(cache, 's', 'a');
    put(cache, 'other', 'a');
    const before = store.beginRead('a');
    const settled = store.beginClear();
    const during = store.beginRead('b');
    settled();
    store.endRead('a', before, record());
    store.endRead('b', during, record());
    assert.equal(store.get('a'), undefined);
    assert.equal(store.get('b'), undefined);
    const late = store.beginRead('a');
    cache.deleteStore('s');
    store.endRead('a', late, record());
    store.endRead('a', store.beginRead('a'), record());
    assert.equal(store.get('a'), undefined);
    assert.ok(cache.store('other').get('a'));
    put(cache, 's', 'a');
    assert.ok(cache.store('s').get('a'));
    cache.close();
    assert.equal(cache.store('s').get('a'), undefined);
    assert.equal(cache.store('other').get('a'), undefined);
  });

  it('handles opened during overlapping store deletions remain retired', () => {
    const cache = new RecordCache();
    put(cache, 's', 'a');
    const first = cache.beginDeleteStore('s');
    const second = cache.beginDeleteStore('s');
    const during = cache.store('s');
    put(cache, 's', 'a');
    assert.equal(during.get('a'), undefined);
    first();
    put(cache, 's', 'a');
    assert.equal(during.get('a'), undefined);
    second();
    during.endRead('a', during.beginRead('a'), record());
    assert.equal(during.get('a'), undefined);
    put(cache, 's', 'a');
    assert.ok(cache.store('s').get('a'));
  });
});

it('retired handles invalidate later generations after deletion settles', () => {
  const cache = new RecordCache();
  const old = cache.store('s');
  const settle = cache.beginDeleteStore('s');
  const during = cache.store('s');
  settle(); // Settlement is identical for successful and failed deletions.
  const fresh = cache.store('s');
  put(cache, 's', 'a', record('before'));
  assert.equal(fresh.get('a')?.text, 'before');
  for (const retired of [old, during]) {
    const pending = fresh.beginRead('a');
    const finish = retired.beginWrite(['a']);
    assert.equal(fresh.get('a'), undefined);
    const overlapping = fresh.beginRead('a');
    finish();
    fresh.endRead('a', pending, record('stale'));
    fresh.endRead('a', overlapping, record('stale'));
    assert.equal(fresh.get('a'), undefined);
    retired.endRead('a', retired.beginRead('a'), record('retired'));
    assert.equal(fresh.get('a'), undefined);
    put(cache, 's', 'a', record('current'));
    const clear = retired.beginClear();
    assert.equal(fresh.get('a'), undefined);
    clear();
  }
});
