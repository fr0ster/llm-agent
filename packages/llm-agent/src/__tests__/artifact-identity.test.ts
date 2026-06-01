import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactIdentityKey, stableArgsKey } from '../artifact-identity.js';

test('stableArgsKey is order-independent', () => {
  assert.equal(stableArgsKey({ a: 1, b: 2 }), stableArgsKey({ b: 2, a: 1 }));
});

test('artifactIdentityKey is case-normalised — F01 and f01 share one key', () => {
  const upper = artifactIdentityKey('GetInclude', {
    include_name: 'ZDAZ_R_DELAYED_UPDATE_F01',
  });
  const lower = artifactIdentityKey('getinclude', {
    include_name: 'zdaz_r_delayed_update_f01',
  });
  assert.equal(upper, lower, 'case-variant identifiers must dedup to one key');
  assert.equal(
    upper,
    'getinclude:{"include_name":"zdaz_r_delayed_update_f01"}',
  );
});

test('artifactIdentityKey still distinguishes different identifiers', () => {
  assert.notEqual(
    artifactIdentityKey('GetInclude', { n: 'O01' }),
    artifactIdentityKey('GetInclude', { n: 'O02' }),
  );
});
