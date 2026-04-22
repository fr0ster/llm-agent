import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryRag } from '../in-memory-rag.js';
import { buildRagCollectionToolEntries } from '../mcp-tools/rag-collection-tools.js';
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
  it('produces rag_add, rag_correct, rag_deprecate', () => {
    const entries = buildRagCollectionToolEntries({ registry: makeRegistry() });
    const names = entries.map((e) => e.toolDefinition.name).sort();
    assert.deepEqual(names, ['rag_add', 'rag_correct', 'rag_deprecate']);
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
