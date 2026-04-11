import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps, makeRag } from '../testing/index.js';

// ---------------------------------------------------------------------------
// SmartAgent.addRagStore / removeRagStore
// ---------------------------------------------------------------------------

function makeAgent() {
  const { deps } = makeDefaultDeps();
  const config = { maxIterations: 5 };
  const agent = new SmartAgent(deps, config);
  return { agent, deps };
}

describe('SmartAgent.addRagStore()', () => {
  it('adds a custom store to ragStores', () => {
    const { agent, deps } = makeAgent();
    const store = makeRag([]);
    agent.addRagStore('kb', store);
    assert.equal((deps.ragStores as Record<string, unknown>).kb, store);
  });

  it('overwrites an existing custom store with the same name', () => {
    const { agent, deps } = makeAgent();
    const store1 = makeRag([]);
    const store2 = makeRag([]);
    agent.addRagStore('kb', store1);
    agent.addRagStore('kb', store2);
    assert.equal((deps.ragStores as Record<string, unknown>).kb, store2);
  });

  it('throws when trying to overwrite built-in "tools" store', () => {
    const { agent } = makeAgent();
    assert.throws(
      () => agent.addRagStore('tools', makeRag([])),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /tools/);
        return true;
      },
    );
  });

  it('throws when trying to overwrite built-in "history" store', () => {
    const { agent } = makeAgent();
    assert.throws(
      () => agent.addRagStore('history', makeRag([])),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /history/);
        return true;
      },
    );
  });
});

describe('SmartAgent.removeRagStore()', () => {
  it('removes a custom store from ragStores', () => {
    const { agent, deps } = makeAgent();
    agent.addRagStore('kb', makeRag([]));
    assert.ok('kb' in deps.ragStores);

    agent.removeRagStore('kb');
    assert.ok(!('kb' in deps.ragStores));
  });

  it('is a no-op when removing a non-existent custom store', () => {
    const { agent, deps } = makeAgent();
    assert.doesNotThrow(() => agent.removeRagStore('nonexistent'));
    assert.ok(!('nonexistent' in deps.ragStores));
  });

  it('throws when trying to remove built-in "tools" store', () => {
    const { agent } = makeAgent();
    assert.throws(
      () => agent.removeRagStore('tools'),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /tools/);
        return true;
      },
    );
  });

  it('throws when trying to remove built-in "history" store', () => {
    const { agent } = makeAgent();
    assert.throws(
      () => agent.removeRagStore('history'),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /history/);
        return true;
      },
    );
  });
});
