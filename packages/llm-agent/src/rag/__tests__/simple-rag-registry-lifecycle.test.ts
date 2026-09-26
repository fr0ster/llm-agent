import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRagEditor, IRagProvider } from '../../interfaces/rag.js';
import { RagError } from '../../interfaces/types.js';
import {
  CatalogRecordDeleteError,
  DuplicateCollectionError,
  OrphanStoreError,
} from '../corrections/errors.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';

type CreateCall = { name: string; opts: Record<string, unknown> };

/** A provider that records every create, and whose delete waits and answers as told. */
function recording(
  deleteAnswer: () => Promise<
    { ok: true; value: undefined } | { ok: false; error: RagError }
  > = async () => ({ ok: true, value: undefined }),
) {
  const creates: CreateCall[] = [];
  const provider: IRagProvider = {
    name: 'p',
    kind: 'vector',
    editable: true,
    supportedScopes: ['session', 'user', 'global'],
    createCollection: async (name, opts) => {
      creates.push({ name, opts: { ...opts } });
      return {
        ok: true,
        value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
      };
    },
    deleteCollection: () => deleteAnswer(),
  };
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(provider);
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return { reg, creates };
}

// Already green after B19 and B23 — they pin the refusal order and the
// forwarding this task must not break while it rewrites createUnder.
describe('createCollection — checked before anything is consulted', () => {
  it('refuses an owner without its key with RAG_INVALID_OWNER, even with no provider registry', async () => {
    const reg = new SimpleRagRegistry(); // no provider registry at all
    for (const owner of [
      { scope: 'user' },
      { scope: 'user', userId: '' },
      { scope: 'session' },
      { scope: 'session', sessionId: '' },
    ]) {
      const res = await reg.createCollection({
        providerName: 'p',
        collectionName: 'c',
        ...owner,
      } as never);
      assert.ok(!res.ok);
      assert.equal(res.error.code, 'RAG_INVALID_OWNER', JSON.stringify(owner));
    }
  });

  it('refuses attributes JSON would change with RAG_INVALID_ATTRIBUTES, creating nothing', async () => {
    const { reg, creates } = recording();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const attributes of [
      Number.NaN,
      { limit: Number.POSITIVE_INFINITY },
      [1, Number.NEGATIVE_INFINITY],
      cycle,
      { when: new Date(0) },
      { big: 1n },
      { fn: () => 1 },
      { gone: undefined },
    ]) {
      const res = await reg.createCollection({
        providerName: 'p',
        collectionName: 'c',
        scope: 'global',
        attributes,
      } as never);
      assert.ok(!res.ok);
      assert.equal(res.error.code, 'RAG_INVALID_ATTRIBUTES');
    }
    assert.deepEqual(creates, [], 'nothing reached the provider');
  });

  it('accepts JSON attributes, a shared (acyclic) sub-object included', async () => {
    const { reg } = recording();
    const shared = { role: 'analyst' };
    const res = await reg.createCollection({
      providerName: 'p',
      collectionName: 'c',
      scope: 'global',
      attributes: { a: shared, b: shared, n: [1, 2.5, null, true, 'x'] },
    } as never);
    assert.ok(res.ok);
  });

  it('forwards the logical name, the owner, the attributes and adoptExisting to the provider', async () => {
    const { reg, creates } = recording();
    const res = await reg.createCollection({
      providerName: 'p',
      collectionName: 'my notes',
      scope: 'user',
      userId: 'alice',
      attributes: { authorization: 'owner' },
      adoptExisting: true,
    } as never);
    assert.ok(res.ok);
    assert.equal(creates.length, 1);
    assert.match(
      creates[0].name,
      /^my_notes_[0-9a-f]{12}$/,
      'the store name is still storeNameFor',
    );
    assert.deepEqual(creates[0].opts, {
      scope: 'user',
      userId: 'alice',
      collectionName: 'my notes',
      attributes: { authorization: 'owner' },
      adoptExisting: true,
    });
  });

  it('passes neither attributes nor adoptExisting when the caller gave none', async () => {
    const { reg, creates } = recording();
    assert.ok(
      (
        await reg.createCollection({
          providerName: 'p',
          collectionName: 'c',
          scope: 'session',
          sessionId: 'S',
        } as never)
      ).ok,
    );
    assert.deepEqual(creates[0].opts, {
      scope: 'session',
      sessionId: 'S',
      collectionName: 'c',
    });
  });

  it('returns the provider refusal unchanged', async () => {
    const reg = new SimpleRagRegistry();
    const providers = new SimpleRagProviderRegistry();
    providers.registerProvider({
      name: 'p',
      kind: 'vector',
      editable: true,
      supportedScopes: ['global'],
      createCollection: async () => ({
        ok: false,
        error: new OrphanStoreError('c_x', 'it exists without a record'),
      }),
    });
    reg.setProviderRegistry(providers);
    const res = await reg.createCollection({
      providerName: 'p',
      collectionName: 'c',
      scope: 'global',
    } as never);
    assert.ok(!res.ok);
    assert.ok(res.error instanceof OrphanStoreError);
    assert.equal(reg.list().length, 0);
  });
});

describe('deleteCollection — the name is reserved while it runs', () => {
  it('is absent to get and list, and taken for createCollection, register and adopt', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { reg } = recording(async () => {
      await held;
      return { ok: true, value: undefined };
    });
    assert.ok(
      (
        await reg.createCollection({
          providerName: 'p',
          collectionName: 'docs',
          scope: 'user',
          userId: 'alice',
        } as never)
      ).ok,
    );

    const deletion = reg.deleteCollection('docs', 'user');
    assert.equal(reg.get('docs', 'user'), undefined);
    assert.equal(reg.list().length, 0);
    const again = await reg.createCollection({
      providerName: 'p',
      collectionName: 'docs',
      scope: 'user',
      userId: 'alice',
    } as never);
    assert.ok(!again.ok);
    assert.ok(again.error instanceof DuplicateCollectionError);
    const dup = (e: unknown) => e instanceof DuplicateCollectionError;
    assert.throws(
      () =>
        reg.register('docs', new InMemoryRag(), undefined, {
          displayName: 'docs',
          scope: 'user',
          userId: 'alice',
        }),
      dup,
    );
    assert.throws(
      () =>
        reg.adopt(
          { storeName: 's', name: 'docs', scope: 'user', userId: 'alice' },
          new InMemoryRag(),
        ),
      dup,
    );
    // another scope of the same name is another collection
    reg.register('docs', new InMemoryRag(), undefined, {
      displayName: 'docs',
      scope: 'session',
      sessionId: 'S',
    });

    release();
    assert.ok((await deletion).ok);
    assert.ok(
      (
        await reg.createCollection({
          providerName: 'p',
          collectionName: 'docs',
          scope: 'user',
          userId: 'alice',
        } as never)
      ).ok,
      'the reservation ends when the provider answers',
    );
  });

  it('restores the SAME entry on CatalogRecordDeleteError, and a retry finds it', async () => {
    let fail = true;
    const { reg } = recording(async () =>
      fail
        ? {
            ok: false,
            error: new CatalogRecordDeleteError(
              'docs',
              'catalog write refused',
            ),
          }
        : { ok: true, value: undefined },
    );
    let mutations = 0;
    reg.setMutationListener(() => {
      mutations += 1;
    });
    assert.ok(
      (
        await reg.createCollection({
          providerName: 'p',
          collectionName: 'docs',
          scope: 'user',
          userId: 'alice',
        } as never)
      ).ok,
    );
    const rag = reg.get('docs');
    const before = mutations;

    const res = await reg.deleteCollection('docs');
    assert.ok(!res.ok);
    assert.ok(res.error instanceof CatalogRecordDeleteError);
    assert.equal(
      reg.get('docs', 'user'),
      rag,
      'the same handles: nothing behind them changed',
    );
    assert.ok(
      mutations >= before + 2,
      'removed, then restored — the projection sees both',
    );

    fail = false;
    assert.ok(
      (await reg.deleteCollection('docs')).ok,
      'the same delete, retried in place',
    );
    assert.equal(reg.get('docs'), undefined);
  });

  it('keeps any other failure as today: unregistered, error returned', async () => {
    const { reg } = recording(async () => ({
      ok: false,
      error: new RagError('data gone wrong', 'RAG_DELETE_ERROR'),
    }));
    assert.ok(
      (
        await reg.createCollection({
          providerName: 'p',
          collectionName: 'docs',
          scope: 'global',
        } as never)
      ).ok,
    );
    const res = await reg.deleteCollection('docs');
    assert.ok(!res.ok);
    assert.equal(reg.get('docs'), undefined);
  });

  it('closeSession retried after a record failure finds the victim again', async () => {
    let fail = true;
    const { reg } = recording(async () =>
      fail
        ? {
            ok: false,
            error: new CatalogRecordDeleteError(
              'scratch',
              'catalog write refused',
            ),
          }
        : { ok: true, value: undefined },
    );
    assert.ok(
      (
        await reg.createCollection({
          providerName: 'p',
          collectionName: 'scratch',
          scope: 'session',
          sessionId: 'S',
        } as never)
      ).ok,
    );
    const first = await reg.closeSession('S');
    assert.ok(!first.ok);
    assert.ok(reg.get('scratch', 'session'));
    fail = false;
    assert.ok((await reg.closeSession('S')).ok);
    assert.equal(reg.get('scratch', 'session'), undefined);
  });
});
