import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnsupportedScopeError } from '../corrections/errors.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { DirectEditStrategy, ImmutableEditStrategy, } from '../strategies/edit/index.js';
describe('InMemoryRagProvider', () => {
    it('supports only session scope', () => {
        const p = new InMemoryRagProvider({ name: 'mem' });
        assert.deepEqual(p.supportedScopes, ['session']);
    });
    it('rejects non-session scopes', async () => {
        const p = new InMemoryRagProvider({ name: 'mem' });
        const res = await p.createCollection('x', { scope: 'global' });
        assert.ok(!res.ok);
        assert.ok(res.error instanceof UnsupportedScopeError);
    });
    it('creates editable InMemoryRag when editable=true (default)', async () => {
        const p = new InMemoryRagProvider({ name: 'mem' });
        const res = await p.createCollection('x', {
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(res.ok);
        assert.ok(res.value.editor instanceof DirectEditStrategy);
        const up = await res.value.editor.upsert('hello', { id: 'x1' });
        assert.ok(up.ok && up.value.id.startsWith('S:'));
    });
    it('creates read-only when editable=false', async () => {
        const p = new InMemoryRagProvider({ name: 'mem-ro', editable: false });
        const res = await p.createCollection('x', {
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(res.ok);
        assert.ok(res.value.editor instanceof ImmutableEditStrategy);
    });
});
//# sourceMappingURL=in-memory-rag-provider.test.js.map