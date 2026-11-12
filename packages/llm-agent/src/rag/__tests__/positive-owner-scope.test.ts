import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesRagIdentity, ragIdentityFilter } from '../identity-filter.js';

test('positive ownerScope is mandatory and mismatched scope/id fails closed', () => {
  for (const [scope, key] of [
    ['session', 'sessionId'],
    ['user', 'userId'],
  ] as const) {
    assert.equal(
      matchesRagIdentity(
        { [key]: 'a' },
        ragIdentityFilter({ ragFilter: { [key]: 'a' } }),
      ),
      false,
    );
    assert.equal(
      matchesRagIdentity(
        { ownerScope: 'global', [key]: 'a' },
        ragIdentityFilter({ ragFilter: { [key]: 'a' } }),
      ),
      false,
    );
    assert.equal(
      matchesRagIdentity(
        { ownerScope: scope, [key]: 'a' },
        ragIdentityFilter({ ragFilter: { [key]: 'a' } }),
      ),
      true,
    );
  }
  assert.equal(
    matchesRagIdentity(
      {},
      { ownerScope: 'global', owner: { scope: 'global' } },
    ),
    false,
  );
  assert.equal(
    matchesRagIdentity(
      { ownerScope: 'global' },
      { ownerScope: 'global', owner: { scope: 'global' } },
    ),
    true,
  );
});

test('full-owner consistency rejects conflicting stored tags and ids', () => {
  for (const metadata of [
    { ownerScope: 'global', userId: 'u' },
    { ownerScope: 'global', sessionId: null },
    { ownerScope: 'session', sessionId: 's', userId: 'u' },
    { ownerScope: 'session', sessionId: 's', roleId: 'r' },
    { ownerScope: 'user', userId: 'u', roleId: 'r' },
  ] as const) {
    for (const owner of [
      { scope: 'global' },
      { scope: 'session', sessionId: 's' },
      { scope: 'user', userId: 'u' },
    ] as const)
      assert.equal(
        matchesRagIdentity(
          metadata,
          ragIdentityFilter({ ragFilter: { owner } }),
        ),
        false,
      );
  }
});
