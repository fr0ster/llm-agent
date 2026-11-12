import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseRagCollectionRecord,
  validateRagOwner,
} from '../catalog/validation.js';

test('legacy role owners are rejected and never become global', () => {
  assert.equal(validateRagOwner({ scope: 'role', roleId: 'team' }).ok, false);
  const parsed = parseRagCollectionRecord({
    storeName: 'legacy',
    name: 'Docs',
    scope: 'role',
  });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.rejected.storeName, 'legacy');
});
