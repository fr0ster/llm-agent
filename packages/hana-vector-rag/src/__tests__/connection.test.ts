import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import { resolveHanaConnectArgs } from '../connection.js';

describe('resolveHanaConnectArgs', () => {
  it('accepts explicit fields', async () => {
    const args = await resolveHanaConnectArgs({
      host: 'h.example.com',
      port: 443,
      credential: staticLogin('U1', 'pw'),
      collectionName: 't',
    });
    assert.equal(args.serverNode, 'h.example.com:443');
    assert.equal(args.uid, 'U1');
    assert.equal(args.pwd, 'pw');
    assert.equal(args.encrypt, 'true');
  });

  it('parses hdbsql URL carrying the address only', async () => {
    const args = await resolveHanaConnectArgs({
      connectionString: 'hdbsql://host.example:443',
      credential: staticLogin('u', 'p'),
      collectionName: 't',
    });
    assert.equal(args.serverNode, 'host.example:443');
    assert.equal(args.uid, 'u');
    assert.equal(args.pwd, 'p');
  });

  it('rejects missing host', async () => {
    await assert.rejects(
      () =>
        resolveHanaConnectArgs({
          credential: staticLogin('u', 'p'),
          collectionName: 't',
        }),
      /host/i,
    );
  });
});
