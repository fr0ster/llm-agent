import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionIdentity } from '../session-identity.js';

test('SessionIdentity carries sessionId and optional userId', () => {
  const id: SessionIdentity = { sessionId: 's1' };
  assert.equal(id.sessionId, 's1');
  assert.equal(id.userId, undefined);
  const withUser: SessionIdentity = { sessionId: 's1', userId: 'u1' };
  assert.equal(withUser.userId, 'u1');
});
