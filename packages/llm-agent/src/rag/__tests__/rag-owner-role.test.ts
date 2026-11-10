import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseRagCollectionRecord,
  validateRagOwner,
} from '../catalog/validation.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import {
  SimpleRagRegistry,
  storeNameFor,
} from '../registry/simple-rag-registry.js';
import { ragStoreKey, reservedGlobalNameError } from '../registry/store-key.js';

test('validateRagOwner accepts a role owner and refuses missing or empty roleId', () => {
  assert.deepEqual(validateRagOwner({ scope: 'role', roleId: 'abap-team' }), {
    ok: true,
    value: { scope: 'role', roleId: 'abap-team' },
  });
  assert.equal(validateRagOwner({ scope: 'role' }).ok, false);
  assert.equal(validateRagOwner({ scope: 'role', roleId: '' }).ok, false);
});

test('role projection keys reserve the role prefix', () => {
  assert.equal(
    ragStoreKey({ name: 'docs', scope: 'role', roleId: 'r1' }),
    'role/docs',
  );
  assert.ok(reservedGlobalNameError('global', 'role/x'));
});

test('storeNameFor separates role owners', () => {
  assert.notEqual(
    storeNameFor({ collectionName: 'docs', scope: 'role', roleId: 'a' }),
    storeNameFor({ collectionName: 'docs', scope: 'role', roleId: 'b' }),
  );
});

test('parseRagCollectionRecord accepts role records only with an owner', () => {
  assert.deepEqual(
    parseRagCollectionRecord({
      storeName: 's',
      name: 'n',
      scope: 'role',
      roleId: 'r1',
    }),
    {
      ok: true,
      record: { storeName: 's', name: 'n', scope: 'role', roleId: 'r1' },
    },
  );
  assert.equal(
    parseRagCollectionRecord({ storeName: 's', name: 'n', scope: 'role' }).ok,
    false,
  );
});

test('SimpleRagRegistry creates same-name collections for different roles and refuses ambiguous lookup', async () => {
  const registry = new SimpleRagRegistry();
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(
    new InMemoryRagProvider({ name: 'in-memory', supportedScopes: ['role'] }),
  );
  registry.setProviderRegistry(providers);
  for (const roleId of ['a', 'b']) {
    const result = await registry.createCollection({
      providerName: 'in-memory',
      collectionName: 'docs',
      scope: 'role',
      roleId,
    });
    assert.ok(result.ok);
    assert.equal(result.value.roleId, roleId);
  }
  assert.equal(registry.list().length, 2);
  assert.throws(() => registry.get('docs', 'role'));
});
