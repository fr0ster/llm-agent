import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemorySessionMetaStore } from '../session-meta-store.js';
import {
  handleDeleteSession,
  handleListSessions,
  handleResumeSession,
  usesStepper,
} from '../smart-server.js';

// ---------------------------------------------------------------------------
// /v1/sessions extracted handler tests
// ---------------------------------------------------------------------------

test('GET /v1/sessions lists rows for the identity', async () => {
  const store = new InMemorySessionMetaStore();
  await store.create({
    sessionId: 'a',
    userIdentity: 'u1',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'idle',
  });
  const body = await handleListSessions(store, 'u1');
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].sessionId, 'a');
});

test('GET /v1/sessions does not return rows for a different identity', async () => {
  const store = new InMemorySessionMetaStore();
  await store.create({
    sessionId: 'a',
    userIdentity: 'u1',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'idle',
  });
  await store.create({
    sessionId: 'b',
    userIdentity: 'u2',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'idle',
  });
  const body = await handleListSessions(store, 'u1');
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].sessionId, 'a');
});

test('GET /v1/sessions returns empty list when no sessions exist for identity', async () => {
  const store = new InMemorySessionMetaStore();
  const body = await handleListSessions(store, 'nobody');
  assert.equal(body.sessions.length, 0);
});

test('POST /v1/sessions/:id/resume claims + returns metadata', async () => {
  const store = new InMemorySessionMetaStore();
  await store.create({
    sessionId: 'a',
    userIdentity: 'u1',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'idle',
  });
  const r = await handleResumeSession(store, 'u1', 'a');
  assert.equal(r.ok, true);
  assert.equal(r.session?.sessionId, 'a');
});

test('POST /v1/sessions/:id/resume returns 404 for wrong identity', async () => {
  const store = new InMemorySessionMetaStore();
  await store.create({
    sessionId: 'a',
    userIdentity: 'u1',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'idle',
  });
  const r = await handleResumeSession(store, 'u2', 'a');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('POST /v1/sessions/:id/resume returns 404 for unknown session', async () => {
  const store = new InMemorySessionMetaStore();
  const r = await handleResumeSession(store, 'u1', 'nonexistent');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('DELETE /v1/sessions/:id removes the row', async () => {
  const store = new InMemorySessionMetaStore();
  await store.create({
    sessionId: 'a',
    userIdentity: 'u1',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'idle',
  });
  const evicted: string[] = [];
  await handleDeleteSession(store, 'u1', 'a', async (sid) => {
    evicted.push(sid);
  });
  assert.equal(await store.get('a'), undefined);
  assert.deepEqual(evicted, ['a']);
});

test('DELETE /v1/sessions/:id returns error for wrong identity', async () => {
  const store = new InMemorySessionMetaStore();
  await store.create({
    sessionId: 'a',
    userIdentity: 'u1',
    createdAt: '2026-05-29T00:00:00Z',
    status: 'idle',
  });
  const evicted: string[] = [];
  const r = await handleDeleteSession(store, 'u2', 'a', async (sid) => {
    evicted.push(sid);
  });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  // Row must still exist
  assert.ok(await store.get('a'));
  assert.deepEqual(evicted, []);
});

// ---------------------------------------------------------------------------
// usesStepper mode-gating tests (plan 17b-test)
// ---------------------------------------------------------------------------

test('usesStepper gates on raw coordinator.mode, not on the defaulted parse', () => {
  assert.equal(usesStepper({ mode: 'deep-stepper' }), true);
  assert.equal(usesStepper({ planner: { type: 'llm' } }), false); // legacy 17.0 → Dag path
  assert.equal(usesStepper({}), false);
  assert.equal(usesStepper(undefined), false);
});

test('usesStepper returns true for planned-react mode string', () => {
  assert.equal(usesStepper({ mode: 'planned-react' }), true);
});

test('usesStepper returns true for cyclic-react mode string', () => {
  assert.equal(usesStepper({ mode: 'cyclic-react' }), true);
});

test('usesStepper returns false for non-string mode value', () => {
  assert.equal(usesStepper({ mode: 42 } as never), false);
  assert.equal(usesStepper({ mode: null } as never), false);
});
