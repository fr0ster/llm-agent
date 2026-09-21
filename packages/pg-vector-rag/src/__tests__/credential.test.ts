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
    // The password is a function handed to `pg`, not a resolved string —
    // see the "hands the pool a password FUNCTION" test below for why.
    assert.equal(typeof args.password, 'function');
    assert.equal(await (args.password as () => Promise<string>)(), 'cred_pw');
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

  it('hands the pool a password FUNCTION so a rotating credential is asked per connection, not resolved once', async () => {
    // A `PgVectorRag`'s pool reuses one config object for every physical
    // connection it opens over its lifetime. If `resolvePgConnectArgs`
    // resolved `credential.secret()` to a string here, that string would be
    // frozen into the pool for as long as it lives — a rotating credential
    // would authenticate the first connection and then fail every
    // connection opened after the original secret's TTL. `pg` accepts the
    // secret as a function precisely so it can ask fresh per connection
    // (`@types/pg`: `password?: string | (() => string | Promise<string>)`;
    // the installed runtime checks `typeof this.password === 'function'`
    // per client in `lib/client.js`), so the fix is to hand over the
    // function itself, unresolved.
    let calls = 0;
    const credential = {
      kind: 'secret-login' as const,
      principal: 'cred_user',
      secret: async () => {
        calls++;
        return `secret-${calls}`;
      },
    };

    const args = await resolvePgConnectArgs({
      host: 'h',
      collectionName: 't',
      credential,
    });

    assert.equal(
      typeof args.password,
      'function',
      'the pool must receive the secret as a function, not a resolved string — ' +
        'a mutation that resolves it eagerly turns this into a string and fails here',
    );
    assert.equal(
      calls,
      0,
      'resolvePgConnectArgs must not itself resolve the secret',
    );

    const passwordFn = args.password as () => Promise<string>;
    const firstConnection = await passwordFn();
    const secondConnection = await passwordFn();

    assert.equal(firstConnection, 'secret-1');
    assert.equal(secondConnection, 'secret-2');
    assert.notEqual(
      firstConnection,
      secondConnection,
      'two physical connections must see two different passwords when the credential rotates',
    );

    // The identity, unlike the secret, is resolved once — it does not rotate.
    assert.equal(args.user, 'cred_user');
  });
});
