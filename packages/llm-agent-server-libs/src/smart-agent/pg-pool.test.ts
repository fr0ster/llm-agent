import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePgPool, makePgReadPool } from './pg-pool.js';

// P2-C — both pool factories expose end() so the server can close their sockets
// on shutdown. The pool is created lazily on first query (dynamic import('pg')),
// so end() before any query is a pure no-op: it must NOT construct a pool and
// must resolve without throwing (no real DB connection in unit tests).

test('makePgReadPool: exposes end(); end() before any query is a no-op', async () => {
  const pool = makePgReadPool('postgres://user@localhost:5432/db');
  assert.equal(typeof pool.end, 'function');
  // No query was ever issued, so no raw pg.Pool exists → end() resolves, no throw.
  await assert.doesNotReject(() => pool.end());
});

test('makePgPool: exposes end(); end() before any query is a no-op', async () => {
  const pool = makePgPool('postgres://user@localhost:5432/db');
  assert.equal(typeof pool.end, 'function');
  await assert.doesNotReject(() => pool.end());
});
