import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';

describe('SimpleRagProviderRegistry', () => {
  it('registers and retrieves providers', () => {
    const reg = new SimpleRagProviderRegistry();
    const p = new InMemoryRagProvider({ name: 'mem' });
    reg.registerProvider(p);
    assert.equal(reg.getProvider('mem'), p);
  });
  it('list returns provider names in insertion order', () => {
    const reg = new SimpleRagProviderRegistry();
    reg.registerProvider(new InMemoryRagProvider({ name: 'a' }));
    reg.registerProvider(new InMemoryRagProvider({ name: 'b' }));
    reg.registerProvider(new InMemoryRagProvider({ name: 'c' }));
    assert.deepEqual(reg.listProviders(), ['a', 'b', 'c']);
  });
  it('rejects duplicate provider names', () => {
    const reg = new SimpleRagProviderRegistry();
    reg.registerProvider(new InMemoryRagProvider({ name: 'x' }));
    assert.throws(() =>
      reg.registerProvider(new InMemoryRagProvider({ name: 'x' })),
    );
  });
  it('returns undefined for missing provider', () => {
    const reg = new SimpleRagProviderRegistry();
    assert.equal(reg.getProvider('nope'), undefined);
  });
});
//# sourceMappingURL=simple-provider-registry.test.js.map
