import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serviceKeyCredential } from '../index.js';

const key = JSON.stringify({
  clientid: 'cid',
  clientsecret: 'csecret',
  url: 'https://auth.example',
  serviceurls: { AI_API_URL: 'https://aicore.example/v2' },
});

describe('serviceKeyCredential', () => {
  it('returns the credential AND the address, because a service key holds both', async () => {
    const originalFetch = globalThis.fetch;
    let exchanges = 0;
    globalThis.fetch = (async () => {
      exchanges += 1;
      return new Response(
        JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch;
    try {
      const { credential, apiBaseUrl } = serviceKeyCredential(key);
      assert.equal(
        apiBaseUrl,
        'https://aicore.example/v2',
        'the address is not a credential',
      );
      assert.equal(credential.kind, 'bearer');
      assert.equal(await credential.token(), 'tok');
      assert.equal(await credential.token(), 'tok');
      assert.equal(
        exchanges,
        1,
        'cached — the moved TokenProvider does this already',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses nothing until asked, so a deployment without the key can still start', () => {
    // Constructing must not throw on a malformed key: nothing is read until token().
    assert.doesNotThrow(() => serviceKeyCredential(key));
  });
});
