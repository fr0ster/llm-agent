import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IRag,
  type IRetrievalStrategy,
  isRagDecorator,
} from '../../index.js';

/** A bare store: no decorator. */
const plain = (): IRag =>
  ({
    query: async () => ({ ok: true, value: [] }),
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async () => ({ ok: true, value: null }),
  }) as unknown as IRag;

describe('IRagDecorator', () => {
  it('a decorator exposes the store it wraps as inner', () => {
    const inner = plain();
    const decorator = { ...plain(), inner };
    assert.ok(isRagDecorator(decorator));
    assert.equal(decorator.inner, inner);
  });

  it('a plain store is not a decorator', () => {
    assert.equal(isRagDecorator(plain()), false);
  });

  it('IRetrievalStrategy is implementable', async () => {
    const s: IRetrievalStrategy = {
      name: 'x',
      retrieve: (store, q, k, o) => store.query(q, k, o),
    };
    assert.equal(s.name, 'x');
  });
});
