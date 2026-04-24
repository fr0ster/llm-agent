import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolvePgConnectArgs } from '../connection.js';

describe('resolvePgConnectArgs', () => {
  it('parses postgres:// URL', () => {
    const a = resolvePgConnectArgs({
      connectionString: 'postgres://u:p@host:5432/db',
      collectionName: 't',
    });
    assert.equal(a.connectionString, 'postgres://u:p@host:5432/db');
    assert.equal(a.max, 10);
  });

  it('uses explicit fields', () => {
    const a = resolvePgConnectArgs({
      host: 'h',
      port: 6543,
      user: 'u',
      password: 'p',
      database: 'db',
      poolMax: 3,
      collectionName: 't',
    });
    assert.equal(a.host, 'h');
    assert.equal(a.port, 6543);
    assert.equal(a.user, 'u');
    assert.equal(a.password, 'p');
    assert.equal(a.database, 'db');
    assert.equal(a.max, 3);
  });

  it('rejects missing host and connectionString', () => {
    assert.throws(
      () =>
        resolvePgConnectArgs({ user: 'u', password: 'p', collectionName: 't' }),
      /host|connectionString/i,
    );
  });
});
