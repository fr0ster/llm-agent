import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { staticApiKey, staticLogin } from '../../index.js';

describe('the static conversions', () => {
  it('wrap a key that does not rotate, and are asked on every use', async () => {
    const c = staticApiKey('sk-live');
    assert.equal(c.kind, 'api-key');
    assert.equal(await c.secret(), 'sk-live');
    assert.equal(await c.secret(), 'sk-live');
  });

  it('wrap an identity and a secret, keeping them together', async () => {
    const c = staticLogin('rag_svc', 'hunter2');
    assert.equal(c.kind, 'secret-login');
    assert.equal(c.principal, 'rag_svc');
    assert.equal(await c.secret(), 'hunter2');
  });
});
