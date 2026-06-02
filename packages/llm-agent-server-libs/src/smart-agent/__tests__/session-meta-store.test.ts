import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemorySessionMetaStore } from '../session-meta-store.js';

test('create / get / list / touch / delete', async () => {
  const s = new InMemorySessionMetaStore();
  await s.create({
    sessionId: 'a',
    userIdentity: 'u1',
    title: 'first',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'idle',
  });
  await s.create({
    sessionId: 'b',
    userIdentity: 'u1',
    title: 'second',
    createdAt: '2026-05-29T00:01:00Z',
    status: 'in-progress',
  });
  await s.create({
    sessionId: 'c',
    userIdentity: 'u2',
    title: 'other',
    createdAt: '2026-05-29T00:02:00Z',
    status: 'idle',
  });

  const u1 = await s.listForUser('u1');
  assert.deepEqual(u1.map((x) => x.sessionId).sort(), ['a', 'b']);

  await s.touch('a', '2026-05-29T01:00:00Z');
  assert.equal((await s.get('a'))?.lastUsedAt, '2026-05-29T01:00:00Z');

  await s.setStatus('b', 'idle');
  assert.equal((await s.get('b'))?.status, 'idle');

  await s.delete('a');
  assert.equal(await s.get('a'), undefined);
});

test('inProgressSessions returns only in-progress', async () => {
  const s = new InMemorySessionMetaStore();
  await s.create({
    sessionId: 'x',
    userIdentity: 'u',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'in-progress',
  });
  await s.create({
    sessionId: 'y',
    userIdentity: 'u',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'idle',
  });
  assert.deepEqual(
    (await s.inProgressSessions()).map((r) => r.sessionId),
    ['x'],
  );
});
