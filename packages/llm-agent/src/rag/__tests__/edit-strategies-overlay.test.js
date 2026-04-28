import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OverlayEditStrategy,
  SessionScopedEditStrategy,
} from '../strategies/edit/index.js';
import {
  GlobalUniqueIdStrategy,
  SessionScopedIdStrategy,
} from '../strategies/id/index.js';

function fakeWriter() {
  const rows = new Map();
  const writer = {
    upsertRaw: async (id, text, meta) => {
      rows.set(id, { text, meta: meta });
      return { ok: true, value: undefined };
    },
    deleteByIdRaw: async (id) => ({ ok: true, value: rows.delete(id) }),
  };
  return { writer, rows };
}
describe('OverlayEditStrategy', () => {
  it('writes only to overlay writer with resolved id', async () => {
    const { writer, rows } = fakeWriter();
    const ed = new OverlayEditStrategy(writer, new GlobalUniqueIdStrategy());
    const res = await ed.upsert('v', { id: 'x' });
    assert.ok(res.ok && res.value.id === 'x');
    assert.equal(rows.size, 1);
  });
});
describe('SessionScopedEditStrategy', () => {
  it('stamps sessionId on every write and uses the session id strategy', async () => {
    const { writer, rows } = fakeWriter();
    const ed = new SessionScopedEditStrategy(
      writer,
      'S',
      new SessionScopedIdStrategy('S'),
    );
    const res = await ed.upsert('v', { id: 'x' });
    assert.ok(res.ok);
    const row = rows.get(res.value.id);
    assert.ok(row);
    assert.equal(row.meta.sessionId, 'S');
    assert.equal(res.value.id, 'S:x');
  });
  it('stamps createdAt when caller does not provide it', async () => {
    const { writer, rows } = fakeWriter();
    const ed = new SessionScopedEditStrategy(
      writer,
      'S',
      new SessionScopedIdStrategy('S'),
    );
    const res = await ed.upsert('v', { id: 'y' });
    assert.ok(res.ok);
    const row = rows.get(res.value.id);
    assert.ok(row);
    assert.equal(typeof row.meta.createdAt, 'number');
  });
  it('preserves caller-provided createdAt', async () => {
    const { writer, rows } = fakeWriter();
    const ed = new SessionScopedEditStrategy(
      writer,
      'S',
      new SessionScopedIdStrategy('S'),
    );
    const res = await ed.upsert('v', { id: 'z', createdAt: 123 });
    assert.ok(res.ok);
    const row = rows.get(res.value.id);
    assert.ok(row);
    assert.equal(row.meta.createdAt, 123);
  });
  it('deleteById forwards to writer', async () => {
    const { writer, rows } = fakeWriter();
    rows.set('existing', { text: 't', meta: {} });
    const ed = new SessionScopedEditStrategy(
      writer,
      'S',
      new SessionScopedIdStrategy('S'),
    );
    const res = await ed.deleteById('existing');
    assert.ok(res.ok && res.value === true);
  });
});
//# sourceMappingURL=edit-strategies-overlay.test.js.map
