import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import { resolvePgConnectArgs } from '../connection.js';

// pg's own resolution of a pool config into what a client connects with.
const ConnectionParameters = createRequire(import.meta.url)(
  'pg/lib/connection-parameters.js',
) as new (
  cfg: object,
) => {
  user: string;
  password: unknown;
  host: string;
  port: number;
  database: string;
  ssl: unknown;
};

describe('resolvePgConnectArgs', () => {
  it('parses postgres:// URL carrying the address only', async () => {
    const a = await resolvePgConnectArgs({
      connectionString: 'postgres://host:5432/db',
      collectionName: 't',
    });
    assert.equal(a.host, 'host');
    assert.equal(a.port, 5432);
    assert.equal(a.database, 'db');
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

  it('a connectionString keeps the credential: pg must connect as the principal', async () => {
    // pg merges the parsed connection string OVER the config, and parsing a
    // URL without userinfo yields user "" and password "" — so passing the
    // string beside user/password threw the credential away (found against a
    // real SCRAM Postgres: "client password must be a string").
    const a = await resolvePgConnectArgs({
      connectionString: 'postgres://db.example:15432/rag?sslmode=no-verify',
      credential: staticLogin('ragapp', 'ragpass'),
      collectionName: 't',
    });
    const p = new ConnectionParameters(a);
    assert.equal(p.user, 'ragapp');
    assert.equal(typeof p.password, 'function');
    assert.equal(await (p.password as () => Promise<string>)(), 'ragpass');
    assert.equal(p.host, 'db.example');
    assert.equal(p.port, 15432);
    assert.equal(p.database, 'rag');
    assert.deepEqual(p.ssl, { rejectUnauthorized: false });
  });
});
