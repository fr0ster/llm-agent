import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import { resolvePgConnectArgs } from '../connection.js';

describe('resolvePgConnectArgs', () => {
  it('parses postgres:// URL carrying the address only', async () => {
    const a = await resolvePgConnectArgs({
      connectionString: 'postgres://host:5432/db',
      collectionName: 't',
    });
    assert.equal(a.connectionString, 'postgres://host:5432/db');
    assert.equal(a.max, 10);
  });

  it('uses explicit fields', async () => {
    const a = await resolvePgConnectArgs({
      host: 'h',
      port: 6543,
      credential: staticLogin('u', 'p'),
      database: 'db',
      poolMax: 3,
      collectionName: 't',
    });
    assert.equal(a.host, 'h');
    assert.equal(a.port, 6543);
    assert.equal(a.user, 'u');
    assert.equal(typeof a.password, 'function');
    assert.equal(await (a.password as () => Promise<string>)(), 'p');
    assert.equal(a.database, 'db');
    assert.equal(a.max, 3);
  });

  it('rejects missing host and connectionString', async () => {
    await assert.rejects(
      () =>
        resolvePgConnectArgs({
          credential: staticLogin('u', 'p'),
          collectionName: 't',
        }),
      /host|connectionString/i,
    );
  });
});
