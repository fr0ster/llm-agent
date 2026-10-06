// packages/llm-agent-libs/src/collections/__tests__/pool-and-collapse.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RagMetadata, SourcedHit } from '@mcp-abap-adt/llm-agent';
import { ItemPool, MaxScoreCollapse } from '../index.js';
import { ownerFromMetadata, ownerMetadata } from '../owner.js';

const hit = (
  source: string,
  itemId: string,
  score: number,
  meta: RagMetadata = { visibility: 'global' },
): SourcedHit => ({
  text: `${itemId}@${score}`,
  metadata: { ...meta, itemId, recordKind: 'x' },
  score,
  source,
});

describe('owner flattening', () => {
  it('round-trips every scope', () => {
    for (const o of [
      { scope: 'global' },
      { scope: 'group', groupId: 'g1' },
      { scope: 'user', userId: 'alice' },
      { scope: 'session', sessionId: 's1' },
      { scope: 'session', sessionId: 's1', userId: 'alice' },
    ] as const) {
      assert.deepEqual(ownerFromMetadata(ownerMetadata(o)), o);
    }
  });
  it('a user record without userId is malformed, not global', () => {
    assert.equal(ownerFromMetadata({ visibility: 'user' }), undefined);
    assert.equal(ownerFromMetadata({}), undefined);
  });
});

describe('ItemPool', () => {
  it("with n: n items per source, n × maxRecordsPerItem records, whatever the caller's k", () => {
    assert.equal(new ItemPool(30).items(5), 30);
    assert.equal(new ItemPool(30).recordsToFetch(5, 3), 90);
  });
  it("without n: the caller's k items (the generic default, D56), k × maxRecordsPerItem records", () => {
    assert.equal(new ItemPool().items(4), 4);
    assert.equal(new ItemPool().recordsToFetch(4, 3), 12);
    assert.equal(new ItemPool().items(7), 7);
  });
  it('a given n must be a positive integer; so must k and maxRecordsPerItem', () => {
    assert.throws(
      () => new ItemPool(0),
      /ItemPool: items must be a positive integer/,
    );
    assert.throws(
      () => new ItemPool(1.5),
      /ItemPool: items must be a positive integer/,
    );
    assert.throws(
      () => new ItemPool().items(0),
      /ItemPool: requestedK must be a positive integer/,
    );
    assert.throws(
      () => new ItemPool().recordsToFetch(2, 0),
      /ItemPool: maxRecordsPerItem must be a positive integer/,
    );
  });
});

describe('MaxScoreCollapse', () => {
  it('one item per (source, owner, itemId), scored by its best record, sorted', () => {
    const out = new MaxScoreCollapse().collapse([
      hit('primary', 'a', 0.4),
      hit('primary', 'b', 0.9),
      hit('primary', 'a', 0.7),
    ]);
    assert.deepEqual(
      out.map((c) => [c.itemId, c.score, c.hits.map((h) => h.score)]),
      [
        ['b', 0.9, [0.9]],
        ['a', 0.7, [0.7, 0.4]],
      ],
    );
  });
  it('collapse keys on the owner-qualified item, never the bare itemId', () => {
    const out = new MaxScoreCollapse().collapse([
      hit('user', 'case-42', 0.8, { visibility: 'user', userId: 'A' }),
      hit('user', 'case-42', 0.7, { visibility: 'user', userId: 'B' }),
      hit('global', 'case-42', 0.6),
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((c) => c.owner),
      [
        { scope: 'user', userId: 'A' },
        { scope: 'user', userId: 'B' },
        { scope: 'global' },
      ],
    );
  });
  it('ties keep first-seen order', () => {
    const out = new MaxScoreCollapse().collapse([
      hit('p', 'x', 0.5),
      hit('p', 'y', 0.5),
    ]);
    assert.deepEqual(
      out.map((c) => c.itemId),
      ['x', 'y'],
    );
  });
});
