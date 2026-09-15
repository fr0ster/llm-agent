import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRag, IRagEditor, IRagProvider } from '../../interfaces/rag.js';
import { RagError } from '../../interfaces/types.js';
import {
  CollectionNotFoundError,
  DeleteUnsupportedError,
  ProviderNotFoundError,
  SessionCloseIncompleteError,
} from '../corrections/errors.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';
import {
  DirectEditStrategy,
  ImmutableEditStrategy,
} from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy } from '../strategies/id/index.js';

describe('SimpleRagRegistry', () => {
  it('registers and retrieves rag + editor', () => {
    const reg = new SimpleRagRegistry();
    const rag = new InMemoryRag();
    const ed = new DirectEditStrategy(
      rag.writer(),
      new GlobalUniqueIdStrategy(),
    );
    reg.register('notes', rag, ed, { displayName: 'Notes' });
    assert.equal(reg.get('notes'), rag);
    assert.equal(reg.getEditor('notes'), ed);
  });

  it('marks collection as editable only when editor is concrete (not Immutable)', () => {
    const reg = new SimpleRagRegistry();
    const rag = new InMemoryRag();
    reg.register(
      'editable',
      rag,
      new DirectEditStrategy(rag.writer(), new GlobalUniqueIdStrategy()),
      { displayName: 'Editable' },
    );
    reg.register('corp', new InMemoryRag(), new ImmutableEditStrategy('corp'), {
      displayName: 'Corp',
    });
    reg.register('facts', new InMemoryRag(), undefined, {
      displayName: 'Facts',
    });
    const list = reg.list();
    const edit = list.find((m) => m.name === 'editable');
    const corp = list.find((m) => m.name === 'corp');
    const facts = list.find((m) => m.name === 'facts');
    assert.equal(edit?.editable, true);
    assert.equal(corp?.editable, false);
    assert.equal(facts?.editable, false);
  });

  it('rejects duplicate names', () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
    assert.throws(() =>
      reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' }),
    );
  });

  it('unregister removes entry and returns true when present', () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
    assert.equal(reg.unregister('x'), true);
    assert.equal(reg.unregister('x'), false);
  });

  it('list preserves insertion order', () => {
    const reg = new SimpleRagRegistry();
    reg.register('a', new InMemoryRag(), undefined, { displayName: 'A' });
    reg.register('b', new InMemoryRag(), undefined, { displayName: 'B' });
    reg.register('c', new InMemoryRag(), undefined, { displayName: 'C' });
    assert.deepEqual(
      reg.list().map((m) => m.name),
      ['a', 'b', 'c'],
    );
  });

  it('defaults displayName to name when not provided', () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag());
    const [m] = reg.list();
    assert.equal(m.displayName, 'x');
  });
});

describe('SimpleRagRegistry.createCollection', () => {
  it('delegates to provider and registers the collection atomically', async () => {
    const reg = new SimpleRagRegistry();
    const provReg = new SimpleRagProviderRegistry();
    provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
    reg.setProviderRegistry(provReg);

    const res = await reg.createCollection({
      providerName: 'mem',
      collectionName: 'notes',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(res.ok);
    assert.equal(res.value.name, 'notes');
    assert.equal(res.value.scope, 'session');
    assert.equal(res.value.sessionId, 'S');
    assert.equal(res.value.providerName, 'mem');
    assert.ok(reg.get('notes'));
  });

  it('fails when provider is missing', async () => {
    const reg = new SimpleRagRegistry();
    reg.setProviderRegistry(new SimpleRagProviderRegistry());
    const res = await reg.createCollection({
      providerName: 'nope',
      collectionName: 'x',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(!res.ok);
    assert.ok(res.error instanceof ProviderNotFoundError);
  });

  it('fails on duplicate collection name without touching the provider', async () => {
    const reg = new SimpleRagRegistry();
    const provReg = new SimpleRagProviderRegistry();
    provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
    reg.setProviderRegistry(provReg);

    reg.register('dup', new InMemoryRag(), undefined, { displayName: 'Dup' });
    const res = await reg.createCollection({
      providerName: 'mem',
      collectionName: 'dup',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(!res.ok);
    assert.match(res.error.code, /DUPLICATE/);
  });

  it('fails when no providerRegistry is configured', async () => {
    const reg = new SimpleRagRegistry();
    const res = await reg.createCollection({
      providerName: 'mem',
      collectionName: 'x',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(!res.ok);
    assert.match(res.error.code, /NO_PROVIDER_REGISTRY|PROVIDER_NOT_FOUND/);
  });
});

describe('SimpleRagRegistry.deleteCollection', () => {
  it('returns CollectionNotFoundError for unknown name', async () => {
    const reg = new SimpleRagRegistry();
    const res = await reg.deleteCollection('nope');
    assert.ok(!res.ok);
    assert.ok(res.error instanceof CollectionNotFoundError);
  });

  it('delegates to provider when providerName set in meta', async () => {
    const reg = new SimpleRagRegistry();
    let providerDeleteCalled: string | null = null;
    const provReg = new SimpleRagProviderRegistry();
    provReg.registerProvider({
      name: 'stub',
      kind: 'vector',
      editable: true,
      supportedScopes: ['session'],
      createCollection: async () => ({
        ok: true,
        value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
      }),
      deleteCollection: async (name) => {
        providerDeleteCalled = name;
        return { ok: true, value: undefined };
      },
    });
    reg.setProviderRegistry(provReg);
    reg.register('x', new InMemoryRag(), undefined, {
      displayName: 'X',
      providerName: 'stub',
    });

    const res = await reg.deleteCollection('x');
    assert.ok(res.ok);
    assert.equal(providerDeleteCalled, 'x');
    assert.equal(reg.get('x'), undefined);
  });

  it('unregisters without provider call when providerName not set', async () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
    const res = await reg.deleteCollection('x');
    assert.ok(res.ok);
    assert.equal(reg.get('x'), undefined);
  });
});

describe('SimpleRagRegistry.closeSession', () => {
  it('deletes session-scoped collections with matching sessionId, leaves others', async () => {
    const reg = new SimpleRagRegistry();
    reg.register('sess-A', new InMemoryRag(), undefined, {
      displayName: 'A',
      scope: 'session',
      sessionId: 'S',
    });
    reg.register('sess-B', new InMemoryRag(), undefined, {
      displayName: 'B',
      scope: 'session',
      sessionId: 'OTHER',
    });
    reg.register('global', new InMemoryRag(), undefined, {
      displayName: 'G',
      scope: 'global',
    });

    const res = await reg.closeSession('S');
    assert.ok(res.ok);
    assert.equal(reg.get('sess-A'), undefined);
    assert.ok(reg.get('sess-B'));
    assert.ok(reg.get('global'));
  });
});

describe('SimpleRagRegistry mutation listener', () => {
  it('fires listener on register/unregister/createCollection/deleteCollection/closeSession', async () => {
    const reg = new SimpleRagRegistry();
    const events: string[] = [];
    reg.setMutationListener(() => events.push('m'));

    reg.register('a', new InMemoryRag(), undefined, { displayName: 'A' });
    reg.unregister('a');

    const provReg = new SimpleRagProviderRegistry();
    provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
    reg.setProviderRegistry(provReg);

    await reg.createCollection({
      providerName: 'mem',
      collectionName: 'x',
      scope: 'session',
      sessionId: 'S',
    });
    await reg.deleteCollection('x');

    reg.register('y', new InMemoryRag(), undefined, {
      displayName: 'Y',
      scope: 'session',
      sessionId: 'Q',
    });
    await reg.closeSession('Q');

    assert.ok(events.length >= 5);
  });
});

describe('SimpleRagRegistry default scope normalization', () => {
  it('defaults scope to "global" when not provided on register', () => {
    const reg = new SimpleRagRegistry();
    reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
    const m = reg.list().find((e) => e.name === 'x');
    assert.ok(m);
    assert.equal(m.scope, 'global');
  });
});

/** A provider over plain in-memory stores, deleting as told. */
function stubProvider(opts: {
  deleteCollection?: IRagProvider['deleteCollection'];
  rag?: () => IRag;
}): IRagProvider {
  return {
    name: 'stub',
    kind: 'vector',
    editable: true,
    supportedScopes: ['session', 'user', 'global'],
    createCollection: async () => ({
      ok: true,
      value: {
        rag: opts.rag?.() ?? new InMemoryRag(),
        editor: {} as IRagEditor,
      },
    }),
    ...(opts.deleteCollection
      ? { deleteCollection: opts.deleteCollection }
      : {}),
  };
}

function registryWith(provider: IRagProvider): SimpleRagRegistry {
  const reg = new SimpleRagRegistry();
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(provider);
  reg.setProviderRegistry(providers);
  return reg;
}

async function create(
  reg: SimpleRagRegistry,
  providerName: string,
  collectionName: string,
  sessionId = 'S',
): Promise<void> {
  const res = await reg.createCollection({
    providerName,
    collectionName,
    scope: 'session',
    sessionId,
  });
  assert.ok(res.ok);
}

class NoClearRag extends InMemoryRag {
  writer() {
    const { upsertRaw, deleteByIdRaw } = super.writer();
    return { upsertRaw, deleteByIdRaw };
  }
}

describe('SimpleRagRegistry.deleteCollection — the collection goes, whatever its data does', () => {
  it('unregisters even when the provider fails to delete, and returns its error', async () => {
    const reg = registryWith(
      stubProvider({
        deleteCollection: async () => ({
          ok: false,
          error: new RagError('backend down', 'BACKEND_DOWN'),
        }),
      }),
    );
    await create(reg, 'stub', 'x');
    const res = await reg.deleteCollection('x');
    assert.ok(!res.ok);
    assert.equal(res.error.message, 'backend down');
    assert.equal(reg.get('x'), undefined);
    assert.equal(reg.list().length, 0);
  });

  it('unregisters when the provider throws, and returns a RAG_DELETE_ERROR', async () => {
    const reg = registryWith(
      stubProvider({
        deleteCollection: async () => {
          throw new Error('socket hang up');
        },
      }),
    );
    await create(reg, 'stub', 'x');
    const res = await reg.deleteCollection('x');
    assert.ok(!res.ok);
    assert.equal(res.error.code, 'RAG_DELETE_ERROR');
    assert.match(res.error.message, /socket hang up/);
    assert.equal(reg.get('x'), undefined);
  });

  it('empties the store of a provider that deletes nothing', async () => {
    const reg = registryWith(new InMemoryRagProvider({ name: 'mem' }));
    await create(reg, 'mem', 'x');
    const rag = reg.get('x');
    const editor = reg.getEditor('x');
    assert.ok(rag && editor);
    const up = await editor.upsert('hello', { id: 'r1' });
    assert.ok(up.ok);
    const before = await rag.getById(up.value.id);
    assert.ok(before.ok && before.value);

    const res = await reg.deleteCollection('x');
    assert.ok(res.ok);
    assert.equal(reg.get('x'), undefined);
    const after = await rag.getById(up.value.id);
    assert.ok(after.ok);
    assert.equal(after.value, null);
  });

  it('reports a provider that can neither delete nor clear, and still unregisters', async () => {
    const reg = registryWith(stubProvider({ rag: () => new NoClearRag() }));
    await create(reg, 'stub', 'x');
    const res = await reg.deleteCollection('x');
    assert.ok(!res.ok);
    assert.ok(res.error instanceof DeleteUnsupportedError);
    assert.equal(res.error.code, 'RAG_DELETE_UNSUPPORTED');
    assert.equal(reg.get('x'), undefined);
  });

  it('reports a provider that is no longer registered, and still unregisters', async () => {
    const reg = registryWith(stubProvider({}));
    reg.register('x', new InMemoryRag(), undefined, {
      displayName: 'X',
      providerName: 'gone',
    });
    const res = await reg.deleteCollection('x');
    assert.ok(!res.ok);
    assert.ok(res.error instanceof DeleteUnsupportedError);
    assert.equal(reg.get('x'), undefined);
  });

  it('leaves the store of a collection registered without a provider untouched', async () => {
    const reg = new SimpleRagRegistry();
    const rag = new InMemoryRag();
    const up = await rag.writer().upsertRaw('r1', 'hello', { id: 'r1' });
    assert.ok(up.ok);
    reg.register('x', rag, undefined, { displayName: 'X' });

    const res = await reg.deleteCollection('x');
    assert.ok(res.ok);
    assert.equal(reg.get('x'), undefined);
    const kept = await rag.getById('r1');
    assert.ok(kept.ok && kept.value, 'the registrant still owns its store');
  });
});

describe('SimpleRagRegistry.closeSession — goes through every collection', () => {
  it('deletes all of the session past a failure, and returns the failures together', async () => {
    const deleted: string[] = [];
    const reg = registryWith(
      stubProvider({
        deleteCollection: async (name) => {
          deleted.push(name);
          return name === 'bad'
            ? { ok: false, error: new RagError('backend down') }
            : { ok: true, value: undefined };
        },
      }),
    );
    await create(reg, 'stub', 'bad', 'S');
    await create(reg, 'stub', 'good', 'S');
    await create(reg, 'stub', 'other', 'T');

    const res = await reg.closeSession('S');
    assert.ok(!res.ok);
    assert.ok(res.error instanceof SessionCloseIncompleteError);
    assert.equal(res.error.code, 'RAG_SESSION_CLOSE_INCOMPLETE');
    assert.deepEqual(
      res.error.failures.map((f) => f.name),
      ['bad'],
    );
    assert.match(res.error.message, /bad: backend down/);
    assert.deepEqual(deleted, ['bad', 'good']);
    assert.equal(reg.get('bad'), undefined);
    assert.equal(reg.get('good'), undefined);
    assert.ok(reg.get('other'));
  });
});
