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

// P1-B — pool end() is IDEMPOTENT: the real pg.Pool throws on a second .end(),
// so the guarded factories must make a repeated end() a no-op. Overlapping
// cleanup paths (initSkillHost catch + start() finally + closeFns) all reach
// end(), so a second call MUST resolve without throwing. No real DB: end()
// before any query never constructs a pool, so we assert idempotency offline.

test('makePgPool: end() is idempotent (a second end() resolves, no throw)', async () => {
  const pool = makePgPool('postgres://user@localhost:5432/db');
  await assert.doesNotReject(() => pool.end(), 'first end() resolves');
  await assert.doesNotReject(() => pool.end(), 'second end() is a no-op');
});

test('makePgReadPool: end() is idempotent (a second end() resolves, no throw)', async () => {
  const pool = makePgReadPool('postgres://user@localhost:5432/db');
  await assert.doesNotReject(() => pool.end(), 'first end() resolves');
  await assert.doesNotReject(() => pool.end(), 'second end() is a no-op');
});

// P2-B — query() after end() must FAIL LOUD, not silently reopen an unclosable
// pool. end() before any query leaves createdPool undefined (closes nothing) and
// sets ended=true; without the guard a subsequent query() would lazily construct
// a BRAND-NEW pg.Pool that end() (now a no-op) could never close → socket leak.
// The guard fires BEFORE getPool()/import('pg'), so the rejection is the /closed/
// guard and no pool is constructed (no real DB connection in unit tests).

test('makePgPool: query() after end() throws /closed/ and does not construct a pool', async () => {
  const pool = makePgPool('postgres://user@localhost:5432/db');
  await pool.end(); // end before any query → createdPool stays undefined
  // Guard rejects with /closed/ — NOT an import('pg') / connection error, proving
  // getPool() (and thus pool construction) was never reached.
  await assert.rejects(() => pool.query('SELECT 1'), /closed/);
});

test('makePgReadPool: query() after end() throws /closed/ and does not construct a pool', async () => {
  const pool = makePgReadPool('postgres://user@localhost:5432/db');
  await pool.end();
  await assert.rejects(() => pool.query('SELECT 1'), /closed/);
});
