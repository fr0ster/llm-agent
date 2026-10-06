import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRagEditor, IRagProvider } from '@mcp-abap-adt/llm-agent';
import {
  AmbiguousCollectionError,
  DuplicateCollectionError,
  ReservedCollectionNameError,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '../in-memory-rag.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';
import { ragStoreKey } from '../registry/store-key.js';

/** One `docs` per scope, each its own store. */
function threeDocs() {
  const reg = new SimpleRagRegistry();
  const g = new InMemoryRag();
  const u = new InMemoryRag();
  const s = new InMemoryRag();
  reg.register('docs', g, undefined, { displayName: 'docs', scope: 'global' });
  reg.register('docs', u, undefined, {
    displayName: 'docs',
    scope: 'user',
    userId: 'alice',
  });
  reg.register('docs', s, undefined, {
    displayName: 'docs',
    scope: 'session',
    sessionId: 'S',
  });
  return { reg, g, u, s };
}

const ambiguous = (err: unknown) => {
  assert.ok(
    err instanceof AmbiguousCollectionError,
    'B19’s named error, so a caller can test the class',
  );
  assert.equal(err.code, 'RAG_AMBIGUOUS_COLLECTION');
  assert.deepEqual(err.scopes, ['global', 'user', 'session']);
  return true;
};

describe('SimpleRagRegistry — keyed by scope and name', () => {
  it('holds one collection of a name per scope, and the scope selects it', () => {
    const { reg, g, u, s } = threeDocs();
    assert.equal(reg.list().length, 3);
    assert.equal(reg.get('docs', 'global'), g);
    assert.equal(reg.get('docs', 'user'), u);
    assert.equal(reg.get('docs', 'session'), s);
  });

  it('refuses an ambiguous name without a scope — it never picks one', () => {
    const { reg } = threeDocs();
    assert.throws(() => reg.get('docs'), ambiguous);
    assert.throws(() => reg.getEditor('docs'), ambiguous);
    assert.throws(() => reg.unregister('docs'), ambiguous);
    assert.equal(reg.list().length, 3, 'a refused unregister removed nothing');
  });

  it('returns the ambiguity from deleteCollection, and deletes only the scope named', async () => {
    const { reg, g, u } = threeDocs();
    const refused = await reg.deleteCollection('docs');
    assert.ok(!refused.ok);
    ambiguous(refused.error);
    const res = await reg.deleteCollection('docs', 'session');
    assert.ok(res.ok);
    assert.equal(reg.get('docs', 'session'), undefined);
    assert.equal(reg.get('docs', 'global'), g);
    assert.equal(reg.get('docs', 'user'), u);
  });

  it('needs no scope for a name one scope holds', () => {
    const reg = new SimpleRagRegistry();
    const rag = new InMemoryRag();
    reg.register('mine', rag, undefined, {
      displayName: 'mine',
      scope: 'user',
      userId: 'alice',
    });
    assert.equal(reg.get('mine'), rag);
    assert.equal(reg.unregister('mine'), true);
    assert.equal(reg.get('mine'), undefined);
  });

  it('throws DuplicateCollectionError for a taken scope and name', () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag());
    assert.throws(
      () => reg.register('x', new InMemoryRag()),
      (err: unknown) =>
        err instanceof DuplicateCollectionError &&
        err.code === 'RAG_DUPLICATE_COLLECTION' &&
        // builder-rag-collection-idempotency.test.ts:56 matches this phrase
        /already registered/.test(err.message),
    );
    // the same name in another scope is another collection
    reg.register('x', new InMemoryRag(), undefined, {
      displayName: 'x',
      scope: 'user',
      userId: 'a',
    });
  });

  it('reserves the projection prefixes against globals only', () => {
    const reg = new SimpleRagRegistry();
    for (const name of ['user/docs', 'session/docs']) {
      assert.throws(
        () => reg.register(name, new InMemoryRag()),
        (err: unknown) =>
          err instanceof ReservedCollectionNameError &&
          err.code === 'RAG_RESERVED_COLLECTION_NAME',
      );
    }
    // a user collection may be called anything: its key is prefixed anyway
    reg.register('user/docs', new InMemoryRag(), undefined, {
      displayName: 'user/docs',
      scope: 'user',
      userId: 'a',
    });
  });

  it('refuses a reserved global name in createCollection before any provider is consulted', async () => {
    const reg = new SimpleRagRegistry();
    const res = await reg.createCollection({
      providerName: 'mem',
      collectionName: 'session/x',
      scope: 'global',
    });
    assert.ok(!res.ok);
    assert.ok(
      res.error instanceof ReservedCollectionNameError,
      'not RAG_NO_PROVIDER_REGISTRY: the name is refused first',
    );
  });

  it('a running creation of the user `docs` does not block the session `docs`', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const provider: IRagProvider = {
      name: 'slow',
      kind: 'vector',
      editable: true,
      supportedScopes: ['session', 'user', 'global'],
      createCollection: async (_name, opts) => {
        if (opts.scope === 'user') await held;
        return {
          ok: true,
          value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
        };
      },
    };
    const providers = new SimpleRagProviderRegistry();
    providers.registerProvider(provider);
    const reg = new SimpleRagRegistry();
    reg.setProviderRegistry(providers);
    const user = reg.createCollection({
      providerName: 'slow',
      collectionName: 'docs',
      scope: 'user',
      userId: 'alice',
    });
    const session = await reg.createCollection({
      providerName: 'slow',
      collectionName: 'docs',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(session.ok, 'the creating set is keyed by scope and name');
    release();
    assert.ok((await user).ok);
  });

  it('a creation of a taken scope and name returns DuplicateCollectionError without asking the provider', async () => {
    let asked = 0;
    const provider: IRagProvider = {
      name: 'p',
      kind: 'vector',
      editable: true,
      supportedScopes: ['session', 'user', 'global'],
      createCollection: async () => {
        asked += 1;
        return {
          ok: true,
          value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
        };
      },
    };
    const providers = new SimpleRagProviderRegistry();
    providers.registerProvider(provider);
    const reg = new SimpleRagRegistry();
    reg.setProviderRegistry(providers);
    reg.register('docs', new InMemoryRag(), undefined, {
      displayName: 'docs',
      scope: 'user',
      userId: 'alice',
    });
    const res = await reg.createCollection({
      providerName: 'p',
      collectionName: 'docs',
      scope: 'user',
      userId: 'alice',
    });
    assert.ok(!res.ok);
    assert.ok(res.error instanceof DuplicateCollectionError);
    assert.equal(asked, 0);
  });

  it('closeSession deletes the session `docs` and leaves the global and user ones', async () => {
    const { reg, g, u } = threeDocs();
    const res = await reg.closeSession('S');
    assert.ok(res.ok);
    assert.equal(reg.get('docs', 'session'), undefined);
    assert.equal(reg.get('docs', 'global'), g);
    assert.equal(reg.get('docs', 'user'), u);
  });
});

describe('ragStoreKey', () => {
  it('keeps a global bare and prefixes the two owned scopes', () => {
    assert.equal(ragStoreKey({ name: 'docs', scope: 'global' }), 'docs');
    assert.equal(
      ragStoreKey({ name: 'docs' }),
      'docs',
      'an absent scope is global, as register defaults it',
    );
    assert.equal(ragStoreKey({ name: 'docs', scope: 'user' }), 'user/docs');
    assert.equal(
      ragStoreKey({ name: 'docs', scope: 'session' }),
      'session/docs',
    );
  });
});
