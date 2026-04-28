import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyLoadedPlugins, mergePluginExports } from '../types.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stubMcpClient(name) {
    return {
        async listTools() {
            return { ok: true, value: [{ name, inputSchema: {} }] };
        },
        async callTool() {
            return { ok: true, value: { content: [] } };
        },
    };
}
function stubStageHandler() {
    return { execute: async () => true };
}
// ---------------------------------------------------------------------------
// emptyLoadedPlugins
// ---------------------------------------------------------------------------
describe('emptyLoadedPlugins', () => {
    it('initializes mcpClients as empty array', () => {
        const result = emptyLoadedPlugins();
        assert.ok(Array.isArray(result.mcpClients));
        assert.equal(result.mcpClients.length, 0);
    });
});
// ---------------------------------------------------------------------------
// mergePluginExports — mcpClients
// ---------------------------------------------------------------------------
describe('mergePluginExports — mcpClients', () => {
    it('merges mcpClients from a single plugin', () => {
        const result = emptyLoadedPlugins();
        const client = stubMcpClient('tool-a');
        const registered = mergePluginExports(result, { mcpClients: [client] }, 'plugin-a.js');
        assert.ok(registered);
        assert.equal(result.mcpClients.length, 1);
        assert.equal(result.mcpClients[0], client);
        assert.deepEqual(result.loadedFiles, ['plugin-a.js']);
    });
    it('accumulates mcpClients from multiple plugins', () => {
        const result = emptyLoadedPlugins();
        const clientA = stubMcpClient('tool-a');
        const clientB = stubMcpClient('tool-b');
        const clientC = stubMcpClient('tool-c');
        mergePluginExports(result, { mcpClients: [clientA] }, 'plugin-a.js');
        mergePluginExports(result, { mcpClients: [clientB, clientC] }, 'plugin-b.js');
        assert.equal(result.mcpClients.length, 3);
        assert.equal(result.mcpClients[0], clientA);
        assert.equal(result.mcpClients[1], clientB);
        assert.equal(result.mcpClients[2], clientC);
    });
    it('ignores mcpClients when not an array', () => {
        const result = emptyLoadedPlugins();
        const registered = mergePluginExports(result, { mcpClients: 'not-an-array' }, 'bad-plugin.js');
        assert.equal(registered, false);
        assert.equal(result.mcpClients.length, 0);
    });
    it('ignores mcpClients when undefined', () => {
        const result = emptyLoadedPlugins();
        const registered = mergePluginExports(result, {}, 'empty-plugin.js');
        assert.equal(registered, false);
        assert.equal(result.mcpClients.length, 0);
    });
    it('does not interfere with other plugin exports', () => {
        const result = emptyLoadedPlugins();
        const client = stubMcpClient('tool-a');
        const handler = stubStageHandler();
        const skillManager = {
            discover: async () => [],
        };
        mergePluginExports(result, {
            mcpClients: [client],
            stageHandlers: { 'my-stage': handler },
            skillManager,
        }, 'combo-plugin.js');
        assert.equal(result.mcpClients.length, 1);
        assert.ok(result.stageHandlers.has('my-stage'));
        assert.equal(result.skillManager, skillManager);
    });
});
//# sourceMappingURL=plugin-types.test.js.map