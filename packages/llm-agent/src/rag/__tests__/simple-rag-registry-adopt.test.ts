import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IRagProvider,
  RagCollectionRecord,
} from '../../interfaces/rag.js';
import { RagError } from '../../interfaces/types.js';
import {
  DuplicateCollectionError,
  InvalidOwnerError,
  ReservedCollectionNameError,
} from '../corrections/errors.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';

const record: RagCollectionRecord = {
  storeName: 'my_notes_a1b2c3d4e5f6',
  name: 'my notes',
  scope: 'user',
  userId: 'alice',
  attributes: { authorization: 'owner' },
};

/** A provider that records what it is asked, and deletes as told. */
function spyProvider() {
  const asked: string[] = [];
  const deleted: string[] = [];
  const provider = {
    name: 'pg',
    kind: 'vector',
    editable: true,
    supportedScopes: ['session', 'user', 'global'],
    createCollection: async () => {
      asked.push('createCollection');
      return { ok: false, error: new RagError('not expected') };
    },
    deleteCollection: async (storeName: string) => {
      deleted.push(storeName);
      return { ok: true, value: undefined };
    },
  } as unknown as IRagProvider;
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(provider);
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return { reg, asked, deleted };
}

describe('SimpleRagRegistry.adopt', () => {
  it('registers under the LOGICAL name; the store name is not an address', () => {
    const { reg } = spyProvider();
    const rag = new InMemoryRag();
    reg.adopt(record, rag, undefined, 'pg');
    assert.equal(reg.get('my notes', 'user'), rag);
    assert.equal(reg.get('my_notes_a1b2c3d4e5f6'), undefined);
    const [meta] = reg.list();
    assert.equal(meta.name, 'my notes');
    assert.equal(meta.scope, 'user');
    assert.equal(meta.userId, 'alice');
    assert.equal(meta.sessionId, undefined);
    assert.equal(meta.providerName, 'pg');
  });

  it('keeps only the key the scope selects, as validateRagOwner returns it', () => {
    const { reg } = spyProvider();
    reg.adopt(
      { ...record, sessionId: 'stray' } as unknown as RagCollectionRecord,
      new InMemoryRag(),
    );
    assert.equal(reg.list()[0].sessionId, undefined);
  });

  it('creates nothing: no provider is asked for anything', () => {
    const { reg, asked, deleted } = spyProvider();
    reg.adopt(record, new InMemoryRag(), undefined, 'pg');
    assert.deepEqual(asked, []);
    assert.deepEqual(deleted, []);
  });

  it('deletes through the STORE name, and reaches the provider', async () => {
    const { reg, deleted } = spyProvider();
    reg.adopt(record, new InMemoryRag(), undefined, 'pg');
    const res = await reg.deleteCollection('my notes');
    assert.ok(res.ok);
    assert.deepEqual(
      deleted,
      ['my_notes_a1b2c3d4e5f6'],
      'a delete that reaches nobody would leave the record for the next hydration',
    );
  });

  it('closeSession deletes an adopted session collection through its provider', async () => {
    const { reg, deleted } = spyProvider();
    reg.adopt(
      {
        storeName: 'scratch_000000000000',
        name: 'scratch',
        scope: 'session',
        sessionId: 'S',
      },
      new InMemoryRag(),
      undefined,
      'pg',
    );
    assert.ok((await reg.closeSession('S')).ok);
    assert.deepEqual(deleted, ['scratch_000000000000']);
  });

  it('without a provider name the entry is a reference: deleting it only unregisters', async () => {
    const { reg, deleted } = spyProvider();
    reg.adopt(record, new InMemoryRag());
    assert.ok((await reg.deleteCollection('my notes')).ok);
    assert.deepEqual(deleted, []);
    assert.equal(reg.get('my notes'), undefined);
  });

  it('refuses a taken scope and name with DuplicateCollectionError; another scope is free', () => {
    const { reg } = spyProvider();
    reg.adopt(record, new InMemoryRag(), undefined, 'pg');
    assert.throws(
      () => reg.adopt(record, new InMemoryRag(), undefined, 'pg'),
      (e: unknown) => e instanceof DuplicateCollectionError,
    );
    reg.adopt(
      { storeName: 's_g', name: 'my notes', scope: 'global' },
      new InMemoryRag(),
    );
  });

  it('refuses an owner without its key with InvalidOwnerError, as a record from an untyped caller may be', () => {
    const { reg } = spyProvider();
    for (const bad of [
      { storeName: 's', name: 'n', scope: 'user' },
      { storeName: 's', name: 'n', scope: 'user', userId: '' },
      { storeName: 's', name: 'n', scope: 'session' },
      { storeName: 's', name: 'n', scope: 'team' },
    ]) {
      assert.throws(
        () =>
          reg.adopt(bad as unknown as RagCollectionRecord, new InMemoryRag()),
        (e: unknown) =>
          e instanceof InvalidOwnerError && e.code === 'RAG_INVALID_OWNER',
        JSON.stringify(bad),
      );
    }
    assert.equal(reg.list().length, 0);
  });

  it('refuses a global in a reserved prefix with ReservedCollectionNameError', () => {
    const { reg } = spyProvider();
    assert.throws(
      () =>
        reg.adopt(
          { storeName: 's', name: 'user/x', scope: 'global' },
          new InMemoryRag(),
        ),
      (e: unknown) => e instanceof ReservedCollectionNameError,
    );
  });
});
