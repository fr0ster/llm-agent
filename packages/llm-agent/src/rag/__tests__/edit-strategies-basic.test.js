import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReadOnlyError } from '../corrections/errors.js';
import {
  DirectEditStrategy,
  ImmutableEditStrategy,
} from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy } from '../strategies/id/index.js';

function fakeWriter() {
  const calls = {
    upsertRaw: [],
    deleteByIdRaw: [],
  };
  return {
    calls,
    upsertRaw: async (id, text, meta) => {
      calls.upsertRaw.push({ id, text, meta });
      return { ok: true, value: undefined };
    },
    deleteByIdRaw: async (id) => {
      calls.deleteByIdRaw.push({ id });
      return { ok: true, value: true };
    },
  };
}
describe('DirectEditStrategy', () => {
  it('resolves id via strategy and forwards upsert', async () => {
    const w = fakeWriter();
    const ed = new DirectEditStrategy(w, new GlobalUniqueIdStrategy());
    const res = await ed.upsert('hello', { id: 'x' });
    assert.ok(res.ok);
    assert.equal(res.value.id, 'x');
    assert.equal(w.calls.upsertRaw.length, 1);
  });
  it('forwards delete', async () => {
    const w = fakeWriter();
    const ed = new DirectEditStrategy(w, new GlobalUniqueIdStrategy());
    const res = await ed.deleteById('x');
    assert.ok(res.ok);
    assert.equal(w.calls.deleteByIdRaw.length, 1);
  });
});
describe('ImmutableEditStrategy', () => {
  it('returns ReadOnlyError for upsert', async () => {
    const ed = new ImmutableEditStrategy('corp-facts');
    const res = await ed.upsert('t', {});
    assert.ok(!res.ok);
    assert.ok(res.error instanceof ReadOnlyError);
  });
  it('returns ReadOnlyError for deleteById', async () => {
    const ed = new ImmutableEditStrategy('corp-facts');
    const res = await ed.deleteById('x');
    assert.ok(!res.ok);
    assert.ok(res.error instanceof ReadOnlyError);
  });
});
//# sourceMappingURL=edit-strategies-basic.test.js.map
