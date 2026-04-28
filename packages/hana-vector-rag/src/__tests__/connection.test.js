import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveHanaConnectArgs } from '../connection.js';

describe('resolveHanaConnectArgs', () => {
  it('accepts explicit fields', () => {
    const args = resolveHanaConnectArgs({
      host: 'h.example.com',
      port: 443,
      user: 'U1',
      password: 'pw',
      collectionName: 't',
    });
    assert.equal(args.serverNode, 'h.example.com:443');
    assert.equal(args.uid, 'U1');
    assert.equal(args.pwd, 'pw');
    assert.equal(args.encrypt, 'true');
  });
  it('parses hdbsql URL', () => {
    const args = resolveHanaConnectArgs({
      connectionString: 'hdbsql://u:p@host.example:443',
      collectionName: 't',
    });
    assert.equal(args.serverNode, 'host.example:443');
    assert.equal(args.uid, 'u');
    assert.equal(args.pwd, 'p');
  });
  it('rejects missing host', () => {
    assert.throws(
      () =>
        resolveHanaConnectArgs({
          user: 'u',
          password: 'p',
          collectionName: 't',
        }),
      /host/i,
    );
  });
});
//# sourceMappingURL=connection.test.js.map
