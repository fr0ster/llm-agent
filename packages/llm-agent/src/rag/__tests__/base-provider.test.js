import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnsupportedScopeError } from '../corrections/errors.js';
import { AbstractRagProvider } from '../providers/base-provider.js';
import { DirectEditStrategy, ImmutableEditStrategy, } from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy, SessionScopedIdStrategy, } from '../strategies/id/index.js';
const dummyWriter = {
    upsertRaw: async () => ({ ok: true, value: undefined }),
    deleteByIdRaw: async () => ({ ok: true, value: false }),
};
const dummyRag = { writer: () => dummyWriter };
class TestProvider extends AbstractRagProvider {
    name = 'test';
    kind = 'vector';
    editable;
    supportedScopes;
    constructor(editable, supportedScopes, idStrategyFactory) {
        super();
        this.editable = editable;
        this.supportedScopes = supportedScopes;
        if (idStrategyFactory)
            this.idStrategyFactory = idStrategyFactory;
    }
    async createCollection(_name, opts) {
        const check = this.checkScope(opts.scope);
        if (!check.ok)
            return check;
        const idStrategy = this.pickIdStrategy(opts);
        const editor = this.buildEditor(dummyRag, idStrategy);
        return { ok: true, value: { rag: dummyRag, editor } };
    }
}
describe('AbstractRagProvider.checkScope', () => {
    it('returns UnsupportedScopeError when scope not in supportedScopes', async () => {
        const p = new TestProvider(true, ['session']);
        const res = await p.createCollection('x', { scope: 'global' });
        assert.ok(!res.ok);
        assert.ok(res.error instanceof UnsupportedScopeError);
    });
    it('passes when scope is supported', async () => {
        const p = new TestProvider(true, ['session', 'global']);
        const res = await p.createCollection('x', { scope: 'global' });
        assert.ok(res.ok);
    });
});
describe('AbstractRagProvider.buildEditor', () => {
    it('returns DirectEditStrategy when editable', async () => {
        const p = new TestProvider(true, ['session']);
        const res = await p.createCollection('x', {
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(res.ok);
        assert.ok(res.value.editor instanceof DirectEditStrategy);
    });
    it('returns ImmutableEditStrategy when not editable', async () => {
        const p = new TestProvider(false, ['session']);
        const res = await p.createCollection('x', {
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(res.ok);
        assert.ok(res.value.editor instanceof ImmutableEditStrategy);
    });
});
describe('AbstractRagProvider.pickIdStrategy', () => {
    it('uses custom idStrategyFactory when provided', async () => {
        let called = false;
        const p = new TestProvider(true, ['session'], () => {
            called = true;
            return new GlobalUniqueIdStrategy();
        });
        const res = await p.createCollection('x', {
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(res.ok);
        assert.equal(called, true);
    });
});
// Keep referenced symbols
void SessionScopedIdStrategy;
//# sourceMappingURL=base-provider.test.js.map