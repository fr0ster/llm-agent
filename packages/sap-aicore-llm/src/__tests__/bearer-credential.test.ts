import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { buildDestination } from '../sap-core-ai-provider.js';

describe('buildDestination', () => {
  it('asks per call and keeps the address out of the credential', async () => {
    let n = 0;
    const credential: IBearerCredential = {
      kind: 'bearer',
      token: async () => `t${++n}`,
    };
    const first = await buildDestination({
      apiBaseUrl: 'https://aicore',
      credential,
    });
    const second = await buildDestination({
      apiBaseUrl: 'https://aicore',
      credential,
    });
    assert.equal(first.headers?.Authorization, 'Bearer t1');
    assert.equal(second.headers?.Authorization, 'Bearer t2');
    assert.equal(first.url, 'https://aicore');
    assert.equal(first.authentication, 'NoAuthentication');
  });
});
