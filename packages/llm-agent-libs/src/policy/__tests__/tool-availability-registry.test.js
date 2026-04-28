import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isToolContextUnavailableError, ToolAvailabilityRegistry, } from '../tool-availability-registry.js';
describe('ToolAvailabilityRegistry', () => {
    it('blocks tool per session and filters it out', () => {
        const registry = new ToolAvailabilityRegistry(1_000);
        registry.block('s1', 'GetTableContent', 'not available');
        const result = registry.filterTools('s1', [
            { name: 'GetTable', description: '', inputSchema: { type: 'object' } },
            {
                name: 'GetTableContent',
                description: '',
                inputSchema: { type: 'object' },
            },
        ]);
        assert.deepEqual(result.allowed.map((t) => t.name), ['GetTable']);
        assert.deepEqual(result.blocked, ['GetTableContent']);
    });
    it('blocklist is session-scoped', () => {
        const registry = new ToolAvailabilityRegistry(1_000);
        registry.block('s1', 'GetTableContent', 'not available');
        assert.equal(registry.isBlocked('s1', 'GetTableContent'), true);
        assert.equal(registry.isBlocked('s2', 'GetTableContent'), false);
    });
    it('block expires after ttl', () => {
        const registry = new ToolAvailabilityRegistry(100);
        registry.block('s1', 'GetTableContent', 'not available', 100, 1_000);
        assert.equal(registry.isBlocked('s1', 'GetTableContent', 1_050), true);
        assert.equal(registry.isBlocked('s1', 'GetTableContent', 1_101), false);
    });
});
describe('isToolContextUnavailableError', () => {
    it('matches common availability failures', () => {
        assert.equal(isToolContextUnavailableError('Tool not available in this environment'), true);
        assert.equal(isToolContextUnavailableError('Permission denied'), true);
    });
    it('does not match generic execution errors', () => {
        assert.equal(isToolContextUnavailableError('Syntax error in request'), false);
    });
});
//# sourceMappingURL=tool-availability-registry.test.js.map