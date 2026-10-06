import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type RecordOwner, recordId } from '../collection-profile.js';

const G: RecordOwner = { scope: 'global' };

describe('recordId', () => {
  it('formats every scope (spec §3.1)', () => {
    assert.equal(
      recordId(G, 'tool:read_file', 'summary', 0),
      'g:/tool%3Aread_file#summary:0',
    );
    assert.equal(
      recordId({ scope: 'group', groupId: 'team-a' }, 'x', 'item', 0),
      'grp:team-a/x#item:0',
    );
    assert.equal(
      recordId({ scope: 'user', userId: 'alice' }, 'case-42', 'item', 0),
      'u:alice/case-42#item:0',
    );
    assert.equal(
      recordId(
        { scope: 'session', sessionId: 's1', userId: 'alice' },
        'x',
        'note',
        2,
      ),
      's:s1/x#note:2',
    );
  });

  it('separators inside the owner key or item id never shift a field', () => {
    const a = recordId({ scope: 'user', userId: 'a/b' }, 'c', 'k', 0);
    const b = recordId({ scope: 'user', userId: 'a' }, 'b/c', 'k', 0);
    assert.notEqual(a, b);
    assert.notEqual(recordId(G, 'x#k', 'y', 0), recordId(G, 'x', 'k#y', 0));
    assert.notEqual(recordId(G, 'a:1', 'k', 0), recordId(G, 'a', '1:k', 0));
  });

  it('the same itemId under two owners gives disjoint ids', () => {
    assert.notEqual(
      recordId({ scope: 'user', userId: 'A' }, 'case-42', 'item', 0),
      recordId({ scope: 'user', userId: 'B' }, 'case-42', 'item', 0),
    );
  });

  it('ids over 200 characters become h: + 64 hex, stable, at most 255', () => {
    const long = 'x'.repeat(400);
    const id = recordId(G, long, 'full', 0);
    assert.match(id, /^h:[0-9a-f]{64}$/);
    assert.equal(id, recordId(G, long, 'full', 0));
    for (const n of [0, 1, 199, 200, 201, 254, 255, 1000]) {
      assert.ok(recordId(G, 'y'.repeat(n), 'full', 0).length <= 255);
    }
  });

  it('refuses a position that is not a non-negative integer', () => {
    assert.throws(() => recordId(G, 'x', 'k', -1), RangeError);
    assert.throws(() => recordId(G, 'x', 'k', 1.5), RangeError);
  });
});
