import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

function makeRegistry() {
  const reg = new SimpleRagRegistry();
  const rag = new InMemoryRag();
  reg.register(
    'notes',
    rag,
    new DirectEditStrategy(rag.writer(), new GlobalUniqueIdStrategy()),
    { displayName: 'Notes' },
  );
  reg.register('corp', new InMemoryRag(), new ImmutableEditStrategy('corp'), {
    displayName: 'Corp',
  });
  return reg;
}

describe('buildRagCollectionToolEntries', () => {
  it('produces rag_add, rag_correct, rag_deprecate, rag_list_collections, rag_describe_collection, rag_delete_collection', () => {
    const entries = buildRagCollectionToolEntries({ registry: makeRegistry() });
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
    const entries = buildRagCollectionToolEntries({ registry: makeRegistry() });
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
    const entries = buildRagCollectionToolEntries({ registry: makeRegistry() });
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
    const entries = buildRagCollectionToolEntries({ registry: makeRegistry() });
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
    const entries = buildRagCollectionToolEntries({ registry: reg });
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
    const entries = buildRagCollectionToolEntries({ registry: reg });
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
    const entries = buildRagCollectionToolEntries({ registry: reg });
    assert.equal(
      entries.find((e) => e.toolDefinition.name === 'rag_create_collection'),
      undefined,
    );
  });

  it('returns error when provider is unknown', async () => {
    const { reg, provReg } = makeFullRegistry();
    const entries = buildRagCollectionToolEntries({
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
    const entries = buildRagCollectionToolEntries({ registry: reg });
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
    const entries = buildRagCollectionToolEntries({ registry: reg });
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
    const entries = buildRagCollectionToolEntries({ registry: reg });
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
    const entries = buildRagCollectionToolEntries({ registry: reg });
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
    const entries = buildRagCollectionToolEntries({ registry: reg });
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
    const entries = buildRagCollectionToolEntries({ registry: reg });
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

  it('rejects session deletion when sessionId mismatches', async () => {
    const { reg } = makeFullRegistry();
    reg.register('s', new InMemoryRag(), undefined, {
      displayName: 'S',
      scope: 'session',
      sessionId: 'S',
    });
    const entries = buildRagCollectionToolEntries({ registry: reg });
    const del = entries.find(
      (e) => e.toolDefinition.name === 'rag_delete_collection',
    );
    assert.ok(del);
    const out = (await del.handler({ sessionId: 'X' }, { name: 's' })) as {
      ok: boolean;
    };
    assert.equal(out.ok, false);
    assert.ok(reg.get('s'));
  });

  it('allows user deletion when userId matches', async () => {
    const { reg } = makeFullRegistry();
    reg.register('u', new InMemoryRag(), undefined, {
      displayName: 'U',
      scope: 'user',
      userId: 'alice',
    });
    const entries = buildRagCollectionToolEntries({ registry: reg });
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
