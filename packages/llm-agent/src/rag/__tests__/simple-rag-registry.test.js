import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CollectionNotFoundError, ProviderNotFoundError, } from '../corrections/errors.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';
import { DirectEditStrategy, ImmutableEditStrategy, } from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy } from '../strategies/id/index.js';
describe('SimpleRagRegistry', () => {
    it('registers and retrieves rag + editor', () => {
        const reg = new SimpleRagRegistry();
        const rag = new InMemoryRag();
        const ed = new DirectEditStrategy(rag.writer(), new GlobalUniqueIdStrategy());
        reg.register('notes', rag, ed, { displayName: 'Notes' });
        assert.equal(reg.get('notes'), rag);
        assert.equal(reg.getEditor('notes'), ed);
    });
    it('marks collection as editable only when editor is concrete (not Immutable)', () => {
        const reg = new SimpleRagRegistry();
        const rag = new InMemoryRag();
        reg.register('editable', rag, new DirectEditStrategy(rag.writer(), new GlobalUniqueIdStrategy()), { displayName: 'Editable' });
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
        assert.throws(() => reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' }));
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
        assert.deepEqual(reg.list().map((m) => m.name), ['a', 'b', 'c']);
    });
    it('defaults displayName to name when not provided', () => {
        const reg = new SimpleRagRegistry();
        reg.register('x', new InMemoryRag());
        const [m] = reg.list();
        assert.equal(m.displayName, 'x');
    });
});
describe('SimpleRagRegistry.createCollection', () => {
    it('delegates to provider and registers the collection atomically', async () => {
        const reg = new SimpleRagRegistry();
        const provReg = new SimpleRagProviderRegistry();
        provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
        reg.setProviderRegistry(provReg);
        const res = await reg.createCollection({
            providerName: 'mem',
            collectionName: 'notes',
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(res.ok);
        assert.equal(res.value.name, 'notes');
        assert.equal(res.value.scope, 'session');
        assert.equal(res.value.sessionId, 'S');
        assert.equal(res.value.providerName, 'mem');
        assert.ok(reg.get('notes'));
    });
    it('fails when provider is missing', async () => {
        const reg = new SimpleRagRegistry();
        reg.setProviderRegistry(new SimpleRagProviderRegistry());
        const res = await reg.createCollection({
            providerName: 'nope',
            collectionName: 'x',
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(!res.ok);
        assert.ok(res.error instanceof ProviderNotFoundError);
    });
    it('fails on duplicate collection name without touching the provider', async () => {
        const reg = new SimpleRagRegistry();
        const provReg = new SimpleRagProviderRegistry();
        provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
        reg.setProviderRegistry(provReg);
        reg.register('dup', new InMemoryRag(), undefined, { displayName: 'Dup' });
        const res = await reg.createCollection({
            providerName: 'mem',
            collectionName: 'dup',
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(!res.ok);
        assert.match(res.error.code, /DUPLICATE/);
    });
    it('fails when no providerRegistry is configured', async () => {
        const reg = new SimpleRagRegistry();
        const res = await reg.createCollection({
            providerName: 'mem',
            collectionName: 'x',
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(!res.ok);
        assert.match(res.error.code, /NO_PROVIDER_REGISTRY|PROVIDER_NOT_FOUND/);
    });
});
describe('SimpleRagRegistry.deleteCollection', () => {
    it('returns CollectionNotFoundError for unknown name', async () => {
        const reg = new SimpleRagRegistry();
        const res = await reg.deleteCollection('nope');
        assert.ok(!res.ok);
        assert.ok(res.error instanceof CollectionNotFoundError);
    });
    it('delegates to provider when providerName set in meta', async () => {
        const reg = new SimpleRagRegistry();
        let providerDeleteCalled = null;
        const provReg = new SimpleRagProviderRegistry();
        provReg.registerProvider({
            name: 'stub',
            kind: 'vector',
            editable: true,
            supportedScopes: ['session'],
            createCollection: async () => ({
                ok: true,
                value: { rag: new InMemoryRag(), editor: {} },
            }),
            deleteCollection: async (name) => {
                providerDeleteCalled = name;
                return { ok: true, value: undefined };
            },
        });
        reg.setProviderRegistry(provReg);
        reg.register('x', new InMemoryRag(), undefined, {
            displayName: 'X',
            providerName: 'stub',
        });
        const res = await reg.deleteCollection('x');
        assert.ok(res.ok);
        assert.equal(providerDeleteCalled, 'x');
        assert.equal(reg.get('x'), undefined);
    });
    it('unregisters without provider call when providerName not set', async () => {
        const reg = new SimpleRagRegistry();
        reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
        const res = await reg.deleteCollection('x');
        assert.ok(res.ok);
        assert.equal(reg.get('x'), undefined);
    });
});
describe('SimpleRagRegistry.closeSession', () => {
    it('deletes session-scoped collections with matching sessionId, leaves others', async () => {
        const reg = new SimpleRagRegistry();
        reg.register('sess-A', new InMemoryRag(), undefined, {
            displayName: 'A',
            scope: 'session',
            sessionId: 'S',
        });
        reg.register('sess-B', new InMemoryRag(), undefined, {
            displayName: 'B',
            scope: 'session',
            sessionId: 'OTHER',
        });
        reg.register('global', new InMemoryRag(), undefined, {
            displayName: 'G',
            scope: 'global',
        });
        const res = await reg.closeSession('S');
        assert.ok(res.ok);
        assert.equal(reg.get('sess-A'), undefined);
        assert.ok(reg.get('sess-B'));
        assert.ok(reg.get('global'));
    });
});
describe('SimpleRagRegistry mutation listener', () => {
    it('fires listener on register/unregister/createCollection/deleteCollection/closeSession', async () => {
        const reg = new SimpleRagRegistry();
        const events = [];
        reg.setMutationListener(() => events.push('m'));
        reg.register('a', new InMemoryRag(), undefined, { displayName: 'A' });
        reg.unregister('a');
        const provReg = new SimpleRagProviderRegistry();
        provReg.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
        reg.setProviderRegistry(provReg);
        await reg.createCollection({
            providerName: 'mem',
            collectionName: 'x',
            scope: 'session',
            sessionId: 'S',
        });
        await reg.deleteCollection('x');
        reg.register('y', new InMemoryRag(), undefined, {
            displayName: 'Y',
            scope: 'session',
            sessionId: 'Q',
        });
        await reg.closeSession('Q');
        assert.ok(events.length >= 5);
    });
});
describe('SimpleRagRegistry default scope normalization', () => {
    it('defaults scope to "global" when not provided on register', () => {
        const reg = new SimpleRagRegistry();
        reg.register('x', new InMemoryRag(), undefined, { displayName: 'X' });
        const m = reg.list().find((e) => e.name === 'x');
        assert.ok(m);
        assert.equal(m.scope, 'global');
    });
});
//# sourceMappingURL=simple-rag-registry.test.js.map