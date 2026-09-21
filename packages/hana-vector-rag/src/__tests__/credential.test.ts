import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import { resolveHanaConnectArgs } from '../connection.js';

describe('resolveHanaConnectArgs', () => {
  it('takes the identity and the secret from the credential', async () => {
    const args = await resolveHanaConnectArgs({
      host: 'h',
      collectionName: 't',
      credential: staticLogin('cred_user', 'cred_pw'),
    });
    assert.equal(args.uid, 'cred_user');
    assert.equal(args.pwd, 'cred_pw');
  });

  it('accepts a connection string that carries the ADDRESS only', async () => {
    const args = await resolveHanaConnectArgs({
      connectionString: 'hdbsql://h:443',
      collectionName: 't',
      credential: staticLogin('cred_user', 'cred_pw'),
    });
    assert.equal(args.uid, 'cred_user');
    assert.equal(args.pwd, 'cred_pw');
  });

  it('REFUSES a connection string carrying credentials, naming the fix', async () => {
    await assert.rejects(
      () =>
        resolveHanaConnectArgs({
          connectionString: 'hdbsql://u:pw@h:443',
          collectionName: 't',
          credential: staticLogin('cred_user', 'cred_pw'),
        }),
      /staticLogin/,
      'silently ignoring the embedded password is the failure this replaces',
    );
  });
});
