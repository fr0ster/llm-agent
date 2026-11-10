import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRagEditor } from '../../interfaces/rag.js';
import { testRagAccess } from '../../testing/rag-access-testing.js';
import { CollectionDataDeleteError } from '../corrections/errors.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { buildRagCollectionToolEntries } from '../mcp-tools/rag-collection-tools.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';
import {
  DirectEditStrategy,
  ImmutableEditStrategy,
} from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy } from '../strategies/id/index.js';

/** The caller every entry below is built for. */
const ALICE = { sessionId: 'S', userId: 'alice', isAdmin: false };

function makeRegistry() {
  const reg = new SimpleRagRegistry();
  const rag = new InMemoryRag();
  reg.register(
    'notes',
    rag,
    new DirectEditStrategy(rag.writer(), new GlobalUniqueIdStrategy()),
    { displayName: 'Notes', scope: 'user', userId: 'alice' },
  );
  reg.register('corp', new InMemoryRag(), new ImmutableEditStrategy('corp'), {
    displayName: 'Corp',
    scope: 'user',
    userId: 'alice',
  });
  return reg;
}

describe('buildRagCollectionToolEntries', () => {
  it('produces rag_add, rag_correct, rag_deprecate, rag_list_collections, rag_describe_collection, rag_delete_collection', () => {
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: makeRegistry(),
    });
    const names = entries.map((e) => e.toolDefinition.name).sort();
    assert.deepEqual(names, [
      'rag_add',
      'rag_correct',
      'rag_delete_collection',
      'rag_deprecate',
      'rag_describe_collection',
      'rag_list_collections',
    ]);
  });

  it('rag_add rejects unknown collection', async () => {
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: makeRegistry(),
    });
    const add = entries.find((e) => e.toolDefinition.name === 'rag_add');
    assert.ok(add);
    const out = (await add.handler(
      {},
      {
        collection: 'does-not-exist',
        text: 't',
        canonicalKey: 'k',
      },
    )) as { ok: boolean; error?: string };
    assert.equal(out.ok, false);
    assert.ok(out.error);
  });

  it('rag_add rejects read-only collection', async () => {
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: makeRegistry(),
    });
    const add = entries.find((e) => e.toolDefinition.name === 'rag_add');
    assert.ok(add);
    const out = (await add.handler(
      {},
      {
        collection: 'corp',
        text: 't',
        canonicalKey: 'k',
      },
    )) as { ok: boolean; error?: string };
    assert.equal(out.ok, false);
  });

  it('rag_add writes into editable collection', async () => {
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: makeRegistry(),
    });
    const add = entries.find((e) => e.toolDefinition.name === 'rag_add');
    assert.ok(add);
    const out = (await add.handler(
      {},
      {
        collection: 'notes',
        text: 'hello',
        canonicalKey: 'greeting',
      },
    )) as { ok: boolean; id?: string };
    assert.equal(out.ok, true);
    assert.ok(typeof out.id === 'string');
  });

  it('rag_deprecate marks record deprecated via upsert', async () => {
    const reg = makeRegistry();
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    const dep = entries.find((e) => e.toolDefinition.name === 'rag_deprecate');
    assert.ok(dep);
    const out = (await dep.handler(
      {},
      {
        collection: 'notes',
        id: 'x',
        canonicalKey: 'k',
        reason: 'outdated',
      },
    )) as { ok: boolean; id?: string };
    assert.equal(out.ok, true);
  });

  it('rag_correct supersedes and returns both ids', async () => {
    const reg = makeRegistry();
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    const cor = entries.find((e) => e.toolDefinition.name === 'rag_correct');
    assert.ok(cor);
    const out = (await cor.handler(
      {},
      {
        collection: 'notes',
        predecessorId: 'k:v1',
        predecessorCanonicalKey: 'k',
        newText: 'fixed',
        reason: 'typo',
      },
    )) as { ok: boolean; predecessorId?: string; newId?: string };
    assert.equal(out.ok, true);
    assert.equal(out.predecessorId, 'k:v1');
    assert.ok(typeof out.newId === 'string');
  });
});

function makeFullRegistry() {
  const reg = new SimpleRagRegistry();
  const provReg = new SimpleRagProviderRegistry();
  provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  reg.setProviderRegistry(provReg);
  return { reg, provReg };
}

describe('rag_create_collection', () => {
  it('creates session-scoped collection via provider', async () => {
    const { reg, provReg } = makeFullRegistry();
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
      providerRegistry: provReg,
    });
    const create = entries.find(
      (e) => e.toolDefinition.name === 'rag_create_collection',
    );
    assert.ok(create);
    const out = (await create.handler(
      { sessionId: 'S' },
      { provider: 'mem', name: 'workflow-x', scope: 'session' },
    )) as {
      ok: boolean;
      meta?: { name: string; scope: string; sessionId: string };
    };
    assert.equal(out.ok, true);
    assert.equal(out.meta?.name, 'workflow-x');
    assert.equal(out.meta?.scope, 'session');
    assert.equal(out.meta?.sessionId, 'S');
  });

  it('is absent when providerRegistry is not supplied', () => {
    const reg = new SimpleRagRegistry();
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    assert.equal(
      entries.find((e) => e.toolDefinition.name === 'rag_create_collection'),
      undefined,
    );
  });

  it('returns error when provider is unknown', async () => {
    const { reg, provReg } = makeFullRegistry();
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
      providerRegistry: provReg,
    });
    const create = entries.find(
      (e) => e.toolDefinition.name === 'rag_create_collection',
    );
    assert.ok(create);
    const out = (await create.handler(
      { sessionId: 'S' },
      { provider: 'nope', name: 'x', scope: 'session' },
    )) as { ok: boolean; error?: string };
    assert.equal(out.ok, false);
    assert.ok(out.error);
  });
});

describe('rag_list_collections', () => {
  it('lists all collections', async () => {
    const { reg } = makeFullRegistry();
    reg.register('a', new InMemoryRag(), undefined, {
      displayName: 'A',
      scope: 'global',
    });
    reg.register('b', new InMemoryRag(), undefined, {
      displayName: 'B',
      scope: 'session',
      sessionId: 'S',
    });
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    const list = entries.find(
      (e) => e.toolDefinition.name === 'rag_list_collections',
    );
    assert.ok(list);
    const out = (await list.handler({}, {})) as {
      ok: boolean;
      collections: Array<{ name: string }>;
    };
    assert.equal(out.ok, true);
    assert.deepEqual(out.collections.map((m) => m.name).sort(), ['a', 'b']);
  });

  it('filters by scope', async () => {
    const { reg } = makeFullRegistry();
    reg.register('a', new InMemoryRag(), undefined, {
      displayName: 'A',
      scope: 'global',
    });
    reg.register('b', new InMemoryRag(), undefined, {
      displayName: 'B',
      scope: 'session',
      sessionId: 'S',
    });
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    const list = entries.find(
      (e) => e.toolDefinition.name === 'rag_list_collections',
    );
    assert.ok(list);
    const out = (await list.handler({}, { scope: 'session' })) as {
      ok: boolean;
      collections: Array<{ name: string }>;
    };
    assert.deepEqual(
      out.collections.map((m) => m.name),
      ['b'],
    );
  });
});

describe('rag_describe_collection', () => {
  it('returns full meta for a known collection', async () => {
    const { reg } = makeFullRegistry();
    reg.register('a', new InMemoryRag(), undefined, {
      displayName: 'A',
      scope: 'global',
    });
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    const desc = entries.find(
      (e) => e.toolDefinition.name === 'rag_describe_collection',
    );
    assert.ok(desc);
    const out = (await desc.handler({}, { name: 'a' })) as {
      ok: boolean;
      meta?: { scope: string };
    };
    assert.equal(out.ok, true);
    assert.equal(out.meta?.scope, 'global');
  });

  it('returns error for unknown name', async () => {
    const { reg } = makeFullRegistry();
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    const desc = entries.find(
      (e) => e.toolDefinition.name === 'rag_describe_collection',
    );
    assert.ok(desc);
    const out = (await desc.handler({}, { name: 'nope' })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(out.ok, false);
  });
});

describe('rag_delete_collection scope enforcement', () => {
  it('rejects global collection deletion', async () => {
    const { reg } = makeFullRegistry();
    reg.register('g', new InMemoryRag(), undefined, {
      displayName: 'G',
      scope: 'global',
    });
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    const del = entries.find(
      (e) => e.toolDefinition.name === 'rag_delete_collection',
    );
    assert.ok(del);
    const out = (await del.handler({}, { name: 'g' })) as { ok: boolean };
    assert.equal(out.ok, false);
    assert.ok(reg.get('g'));
  });

  it('allows session deletion when sessionId matches', async () => {
    const { reg } = makeFullRegistry();
    reg.register('s', new InMemoryRag(), undefined, {
      displayName: 'S',
      scope: 'session',
      sessionId: 'S',
    });
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    const del = entries.find(
      (e) => e.toolDefinition.name === 'rag_delete_collection',
    );
    assert.ok(del);
    const out = (await del.handler({ sessionId: 'S' }, { name: 's' })) as {
      ok: boolean;
    };
    assert.equal(out.ok, true);
    assert.equal(reg.get('s'), undefined);
  });

  it('does not reach another session’s collection: it is absent, not refused', async () => {
    const { reg } = makeFullRegistry();
    reg.register('s', new InMemoryRag(), undefined, {
      displayName: 'S',
      scope: 'session',
      sessionId: 'S',
    });
    const del = buildRagCollectionToolEntries({
      caller: { sessionId: 'X', userId: 'alice', isAdmin: false },
      access: testRagAccess([ALICE]),
      registry: reg,
    }).find((e) => e.toolDefinition.name === 'rag_delete_collection');
    assert.ok(del);
    const out = (await del.handler({}, { name: 's' })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /not found/);
    assert.ok(reg.get('s'));
  });

  it('allows user deletion when userId matches', async () => {
    const { reg } = makeFullRegistry();
    reg.register('u', new InMemoryRag(), undefined, {
      displayName: 'U',
      scope: 'user',
      userId: 'alice',
    });
    const entries = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    });
    const del = entries.find(
      (e) => e.toolDefinition.name === 'rag_delete_collection',
    );
    assert.ok(del);
    const out = (await del.handler({ userId: 'alice' }, { name: 'u' })) as {
      ok: boolean;
    };
    assert.equal(out.ok, true);
  });
});

describe('rag_delete_collection when the data cannot be deleted', () => {
  it('reports the collection removed, with a warning naming the failure', async () => {
    const reg = new SimpleRagRegistry();
    const providers = new SimpleRagProviderRegistry();
    providers.registerProvider({
      name: 'stub',
      kind: 'vector',
      editable: true,
      supportedScopes: ['session'],
      createCollection: async () => ({
        ok: true,
        value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
      }),
      deleteCollection: async () => ({
        ok: false,
        error: new CollectionDataDeleteError('s', 'backend down'),
      }),
    });
    reg.setProviderRegistry(providers);
    const created = await reg.createCollection({
      providerName: 'stub',
      collectionName: 's',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(created.ok);
    const del = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    }).find((e) => e.toolDefinition.name === 'rag_delete_collection');
    assert.ok(del);
    const out = (await del.handler({ sessionId: 'S' }, { name: 's' })) as {
      ok: boolean;
      warning?: string;
    };
    assert.equal(out.ok, true);
    assert.match(out.warning ?? '', /backend down/);
    assert.equal(reg.get('s'), undefined);
  });
});

describe('rag_delete_collection when nothing could delete the data', () => {
  it('answers ok:false with the code when the provider is not registered — its record was never touched', async () => {
    const reg = new SimpleRagRegistry();
    const providers = new SimpleRagProviderRegistry();
    let deletes = 0;
    providers.registerProvider({
      name: 'stub',
      kind: 'vector',
      editable: true,
      supportedScopes: ['session'],
      createCollection: async () => ({
        ok: true,
        value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
      }),
      deleteCollection: async () => {
        deletes++;
        return { ok: true, value: undefined };
      },
    });
    reg.setProviderRegistry(providers);
    const created = await reg.createCollection({
      providerName: 'stub',
      collectionName: 's',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(created.ok);
    // The provider disappears: nothing can reach the collection's record.
    reg.setProviderRegistry(new SimpleRagProviderRegistry());
    const del = buildRagCollectionToolEntries({
      caller: ALICE,
      access: testRagAccess([ALICE]),
      registry: reg,
    }).find((e) => e.toolDefinition.name === 'rag_delete_collection');
    assert.ok(del);
    const out = (await del.handler({ sessionId: 'S' }, { name: 's' })) as {
      ok: boolean;
      error?: string;
      code?: string;
      warning?: string;
    };
    assert.equal(out.ok, false);
    assert.equal(out.code, 'RAG_DELETE_UNSUPPORTED');
    assert.match(out.error ?? '', /provider 'stub' is not registered/);
    assert.equal(out.warning, undefined);
    assert.equal(deletes, 0);
  });
});

describe('collection access decisions', () => {
  it('With a decision that denies write for collection c, rag_add on c returns RagAccessDeniedError and the store is unchanged', async () => {
    const registry = makeRegistry();
    const access = testRagAccess([ALICE]);
    access.decision.canWrite = async () => false;
    const tool = buildRagCollectionToolEntries({
      registry,
      caller: { ...ALICE, isAdmin: false },
      access,
    }).find((e) => e.toolDefinition.name === 'rag_add');
    assert.ok(tool);
    const result = (await tool.handler(
      {},
      { collection: 'notes', text: 'denied', canonicalKey: 'k' },
    )) as { ok: boolean; error: string };
    assert.equal(result.ok, false);
    assert.match(result.error, /RagAccessDeniedError/);
    assert.deepEqual(
      await registry
        .get('notes', 'user')
        ?.query({ text: 'denied', toVector: async () => [] }, 10),
      { ok: true, value: [] },
    );
  });
  it('With a decision that denies read, rag_list_collections omits c', async () => {
    const access = testRagAccess([ALICE]);
    access.decision.canRead = async () => false;
    const tool = buildRagCollectionToolEntries({
      registry: makeRegistry(),
      caller: { ...ALICE, isAdmin: false },
      access,
    }).find((e) => e.toolDefinition.name === 'rag_list_collections');
    assert.ok(tool);
    assert.deepEqual(await tool.handler({}, {}), { ok: true, collections: [] });
  });
});

describe('every collection handler fails closed', () => {
  for (const name of [
    'rag_add',
    'rag_correct',
    'rag_deprecate',
    'rag_delete_collection',
    'rag_describe_collection',
  ]) {
    for (const failure of ['deny', 'throw']) {
      it(`${name} refuses a server ${failure} without modifying the collection`, async () => {
        const registry = makeRegistry();
        const editor = registry.getEditor('notes', 'user');
        assert.ok(editor);
        const original = await editor.upsert('original', {
          canonicalKey: 'key',
        });
        assert.ok(original.ok);
        const access = testRagAccess([ALICE]);
        const decision = async () => {
          if (failure === 'throw') throw new Error('decision unavailable');
          return false;
        };
        access.decision.canRead = decision;
        access.decision.canWrite = decision;
        const tool = buildRagCollectionToolEntries({
          registry,
          caller: ALICE,
          access,
        }).find((e) => e.toolDefinition.name === name);
        assert.ok(tool);
        const before = await registry
          .get('notes', 'user')
          ?.getById(original.value.id);
        const out = (await tool.handler(
          {},
          {
            name: 'notes',
            collection: 'notes',
            text: 'replacement',
            newText: 'replacement',
            canonicalKey: 'key',
            predecessorCanonicalKey: 'key',
            predecessorId: original.value.id,
            id: original.value.id,
            reason: 'test',
          },
        )) as { ok: boolean; code?: string };
        assert.equal(out.ok, false);
        assert.equal(out.code, 'RAG_ACCESS_DENIED');
        assert.equal(registry.getEditor('notes', 'user'), editor);
        assert.deepEqual(
          await registry.get('notes', 'user')?.getById(original.value.id),
          before,
        );
      });
    }
  }
});
