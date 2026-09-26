import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import {
  type CredentialEntry,
  envCredentialEntries,
  memoizeCredentials,
} from '../credential-for.js';
import { createLookup } from '../lookup.js';

const SERVICE_KEY = JSON.stringify({
  clientid: 'c',
  clientsecret: 's',
  url: 'https://auth.example',
  serviceurls: { AI_API_URL: 'https://api.example/' },
});

describe('credentialFor (§4.6.5)', () => {
  it('hands back the SAME entry object for the same ref, and builds it once', () => {
    let built = 0;
    const credentialFor = memoizeCredentials((ref) => {
      built++;
      return ref === 'A' ? { credential: staticApiKey('k') } : undefined;
    });
    const first = credentialFor('A');
    const second = credentialFor('A');
    assert.equal(first, second);
    assert.equal(
      first?.credential,
      second?.credential,
      'one quota bucket per account',
    );
    assert.equal(built, 1);
    credentialFor('NONE');
    credentialFor('NONE');
    assert.equal(built, 2, 'an unknown ref is memoized too');
  });

  it('reads nothing until a ref is asked for, and then only that ref', () => {
    const reads: string[] = [];
    const env = new Proxy(
      {},
      {
        get: (_t, p) => {
          reads.push(String(p));
          return undefined;
        },
      },
    ) as NodeJS.ProcessEnv;
    const credentialFor = memoizeCredentials(envCredentialEntries(env));
    assert.deepEqual(reads, []);
    credentialFor('OPENAI');
    assert.ok(reads.length > 0);
    assert.ok(
      reads.every((r) => r.startsWith('OPENAI_')),
      reads.join(','),
    );
  });

  it('maps the env convention onto the three kinds, SAP with its apiBaseUrl', () => {
    const entries = envCredentialEntries({
      A_API_KEY: 'k',
      P_USER: 'u',
      P_PASSWORD: 'pw',
      S_SERVICE_KEY: SERVICE_KEY,
    });
    assert.equal(entries('A')?.credential?.kind, 'api-key');
    const login = entries('P')?.credential;
    assert.equal(login?.kind, 'secret-login');
    assert.equal(login?.kind === 'secret-login' ? login.principal : '', 'u');
    const sap = entries('S');
    assert.equal(sap?.credential?.kind, 'bearer');
    assert.equal(sap?.apiBaseUrl, 'https://api.example');
    assert.equal(entries('MISSING'), undefined);
  });

  it('refuses an ambiguous or half-set ref', () => {
    assert.throws(
      () =>
        envCredentialEntries({ X_API_KEY: 'k', X_USER: 'u', X_PASSWORD: 'p' })(
          'X',
        ),
      /ambiguous.*X_API_KEY.*X_USER/,
    );
    assert.throws(
      () => envCredentialEntries({ Y_USER: 'u' })('Y'),
      /Y_USER and Y_PASSWORD/,
    );
  });
});

describe('lookup (§4.6.4: optional means omittable, never unresolvable)', () => {
  const registry = (map: Record<string, CredentialEntry>) => {
    const asked: string[] = [];
    const credentialFor = memoizeCredentials((ref) => {
      asked.push(ref);
      return map[ref];
    });
    return { asked, lookup: createLookup(credentialFor) };
  };

  it('an absent ref resolves to the role default', () => {
    const cred = staticApiKey('k');
    const { lookup } = registry({ DEF: { credential: cred } });
    assert.equal(lookup(undefined, 'DEF', 'openai').require('api-key'), cred);
  });

  it('an unknown NAMED ref throws at once, naming it', () => {
    const { lookup } = registry({});
    assert.throws(
      () => lookup('QDRNAT', 'DEF', 'qdrant'),
      /credentialRef 'QDRNAT' for qdrant has no entry/,
    );
  });

  it('the wrong kind is refused, naming the ref, the kind wanted and the kind held', () => {
    const { lookup } = registry({ K: { credential: staticApiKey('k') } });
    assert.throws(
      () => lookup('K', 'DEF', 'hana-vector').require('secret-login'),
      /credentialRef 'K' must hold a secret-login credential for hana-vector, got api-key/,
    );
    assert.throws(
      () => lookup('K', 'DEF', 'pg-vector').optional('secret-login'),
      /got api-key/,
    );
  });

  it('optional: omitted and empty is anonymous; named and empty is a misconfiguration', () => {
    const { lookup } = registry({ EMPTY: {} });
    assert.deepEqual(
      lookup(undefined, 'NOPE', 'qdrant').optional('api-key'),
      {},
    );
    assert.throws(
      () => lookup('EMPTY', 'DEF', 'qdrant').optional('api-key'),
      /got none/,
    );
  });

  it('refuseAny: a target that sends nothing refuses a named ref and never reads the default', () => {
    const { asked, lookup } = registry({
      K: { credential: staticApiKey('k') },
    });
    lookup(undefined, 'DEF', 'in-memory').refuseAny();
    assert.deepEqual(asked, [], 'the role default was not even read');
    assert.throws(
      () => lookup('K', 'DEF', 'in-memory').refuseAny(),
      /in-memory takes no credential.*'K'/,
    );
  });

  it('requireApiBaseUrl reads the address from the SAME entry as the credential', () => {
    const { lookup } = registry({
      S: { credential: staticApiKey('x'), apiBaseUrl: 'https://a' },
    });
    assert.equal(
      lookup('S', 'DEF', 'sap-ai-sdk').requireApiBaseUrl(),
      'https://a',
    );
    const { lookup: l2 } = registry({ T: { credential: staticApiKey('x') } });
    assert.throws(
      () => l2('T', 'DEF', 'sap-ai-sdk').requireApiBaseUrl(),
      /'T' must carry an apiBaseUrl/,
    );
  });
});
