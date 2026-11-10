import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesRagIdentity, ragIdentityFilter } from '../identity-filter.js';

test('positive ownerScope is mandatory and mismatched scope/id fails closed', () => {
  for (const [scope, key] of [
    ['session', 'sessionId'],
    ['user', 'userId'],
    ['role', 'roleId'],
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
