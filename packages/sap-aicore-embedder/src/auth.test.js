import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { TokenProvider } from './auth.js';

const originalFetch = globalThis.fetch;
let fetchCalls = [];
beforeEach(() => {
  fetchCalls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function mockFetch(responder) {
  globalThis.fetch = async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    fetchCalls.push({ url: u, init });
    const { body, status = 200 } = responder(u);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}
test('TokenProvider fetches and returns access_token', async () => {
  mockFetch(() => ({ body: { access_token: 'tok-1', expires_in: 3600 } }));
  const provider = new TokenProvider({
    clientId: 'cid',
    clientSecret: 'csec',
    tokenUrl: 'https://auth.example.com/oauth/token',
  });
  const token = await provider.getToken();
  assert.equal(token, 'tok-1');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://auth.example.com/oauth/token');
  assert.equal(
    fetchCalls[0].init.headers.Authorization,
    `Basic ${Buffer.from('cid:csec').toString('base64')}`,
  );
});
test('TokenProvider caches token until near expiry', async () => {
  let issued = 0;
  mockFetch(() => {
    issued++;
    return { body: { access_token: `tok-${issued}`, expires_in: 3600 } };
  });
  const provider = new TokenProvider({
    clientId: 'cid',
    clientSecret: 'csec',
    tokenUrl: 'https://auth.example.com/oauth/token',
  });
  assert.equal(await provider.getToken(), 'tok-1');
  assert.equal(await provider.getToken(), 'tok-1');
  assert.equal(fetchCalls.length, 1);
});
test('TokenProvider refreshes when forced', async () => {
  let issued = 0;
  mockFetch(() => {
    issued++;
    return { body: { access_token: `tok-${issued}`, expires_in: 3600 } };
  });
  const provider = new TokenProvider({
    clientId: 'cid',
    clientSecret: 'csec',
    tokenUrl: 'https://auth.example.com/oauth/token',
  });
  assert.equal(await provider.getToken(), 'tok-1');
  assert.equal(await provider.getToken({ forceRefresh: true }), 'tok-2');
  assert.equal(fetchCalls.length, 2);
});
test('TokenProvider throws on non-2xx', async () => {
  mockFetch(() => ({ body: { error: 'invalid_client' }, status: 401 }));
  const provider = new TokenProvider({
    clientId: 'cid',
    clientSecret: 'csec',
    tokenUrl: 'https://auth.example.com/oauth/token',
  });
  await assert.rejects(() => provider.getToken(), /401/);
});
//# sourceMappingURL=auth.test.js.map
