import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  FallbackRag,
  InMemoryRag,
  type IRetrievalStrategy,
  isRagDecorator,
} from '../../index.js';

describe('IRagDecorator', () => {
  it('FallbackRag exposes its primary store as inner', () => {
    const primary = new InMemoryRag();
    const fb = new FallbackRag(
      primary,
      new InMemoryRag(),
      new CircuitBreaker({}),
    );
    assert.ok(isRagDecorator(fb));
    assert.equal(fb.inner, primary);
  });

  it('a plain store is not a decorator', () => {
    assert.equal(isRagDecorator(new InMemoryRag()), false);
  });

  it('IRetrievalStrategy is implementable', async () => {
    const s: IRetrievalStrategy = {
      name: 'x',
      retrieve: (store, q, k, o) => store.query(q, k, o),
    };
    assert.equal(s.name, 'x');
  });
});
