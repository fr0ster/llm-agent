import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryRag } from '../in-memory-rag.js';
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
