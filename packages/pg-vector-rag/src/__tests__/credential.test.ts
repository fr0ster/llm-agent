import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import { resolvePgConnectArgs } from '../connection.js';

describe('resolvePgConnectArgs', () => {
  it('takes the identity and the secret from the credential', async () => {
    const args = await resolvePgConnectArgs({
      host: 'h',
      collectionName: 't',
      credential: staticLogin('cred_user', 'cred_pw'),
    });
    assert.equal(args.user, 'cred_user');
    assert.equal(args.password, 'cred_pw');
  });

  it('accepts a connection string that carries the ADDRESS only', async () => {
    const args = await resolvePgConnectArgs({
      connectionString: 'postgres://h:5432/db',
      collectionName: 't',
      credential: staticLogin('cred_user', 'cred_pw'),
    });
    assert.equal(args.user, 'cred_user');
  });

  it('REFUSES a connection string carrying credentials, naming the fix', async () => {
    await assert.rejects(
      () =>
        resolvePgConnectArgs({
          connectionString: 'postgres://u:pw@h/db',
          collectionName: 't',
          credential: staticLogin('cred_user', 'cred_pw'),
        }),
      /staticLogin/,
      'silently ignoring the embedded password is the failure this replaces',
    );
  });
});
