// packages/llm-agent-server/src/smart-agent/__tests__/session-identity-resolver.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveSessionIdentity } from '../session-identity-resolver.js';

const COOKIE = 'sid';
const base = { cookieName: COOKIE, maxAgeSeconds: 7200, isHttps: false };

test('mints a unique id and a Set-Cookie when no cookie present', () => {
  const r = resolveSessionIdentity({ ...base, cookieHeader: undefined });
  assert.ok(r.identity.sessionId.length > 0);
  assert.equal(r.minted, true);
  assert.match(
    r.setCookie ?? '',
    new RegExp(`^${COOKIE}=${r.identity.sessionId};`),
  );
  assert.match(r.setCookie ?? '', /Max-Age=7200/);
  assert.match(r.setCookie ?? '', /HttpOnly/);
  assert.match(r.setCookie ?? '', /SameSite=Lax/);
  assert.match(r.setCookie ?? '', /Path=\//);
  assert.doesNotMatch(r.setCookie ?? '', /Secure/); // not HTTPS
});

test('adds Secure when the request is HTTPS', () => {
  const r = resolveSessionIdentity({
    ...base,
    isHttps: true,
    cookieHeader: undefined,
  });
  assert.match(r.setCookie ?? '', /Secure/);
});

test('reuses an existing valid session cookie without minting', () => {
  const r = resolveSessionIdentity({
    ...base,
    cookieHeader: `${COOKIE}=abc-123; other=x`,
  });
  assert.equal(r.identity.sessionId, 'abc-123');
  assert.equal(r.minted, false);
  assert.equal(r.setCookie, undefined);
});

test('malformed/empty cookie -> mint fresh (bad value never adopted)', () => {
  for (const bad of ['', 'has space', 'inv@lid', 'x'.repeat(129)]) {
    const r = resolveSessionIdentity({
      ...base,
      cookieHeader: `${COOKIE}=${bad}`,
    });
    assert.equal(r.minted, true, `expected mint for "${bad}"`);
    assert.notEqual(r.identity.sessionId, bad);
  }
});

test('two mints produce distinct ids (no shared default bucket)', () => {
  const a = resolveSessionIdentity({ ...base, cookieHeader: undefined });
  const b = resolveSessionIdentity({ ...base, cookieHeader: undefined });
  assert.notEqual(a.identity.sessionId, b.identity.sessionId);
});
