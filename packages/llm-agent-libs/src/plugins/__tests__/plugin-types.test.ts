import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IMcpClient,
  IPipelinePlugin,
  ISkillManager,
} from '@mcp-abap-adt/llm-agent';
import type { IStageHandler } from '../../pipeline/stage-handler.js';
import { emptyLoadedPlugins, mergePluginExports } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubMcpClient(name: string): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [{ name, inputSchema: {} }] };
    },
    async callTool() {
      return { ok: true as const, value: { content: [] } };
    },
  } as unknown as IMcpClient;
}

function stubStageHandler(): IStageHandler {
  return { execute: async () => true } as unknown as IStageHandler;
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

    const registered = mergePluginExports(
      result,
      { mcpClients: [client] },
      'plugin-a.js',
    );

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
    mergePluginExports(
      result,
      { mcpClients: [clientB, clientC] },
      'plugin-b.js',
    );

    assert.equal(result.mcpClients.length, 3);
    assert.equal(result.mcpClients[0], clientA);
    assert.equal(result.mcpClients[1], clientB);
    assert.equal(result.mcpClients[2], clientC);
  });

  it('ignores mcpClients when not an array', () => {
    const result = emptyLoadedPlugins();

    const registered = mergePluginExports(
      result,
      { mcpClients: 'not-an-array' } as unknown as { mcpClients: IMcpClient[] },
      'bad-plugin.js',
    );

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
    } as unknown as ISkillManager;

    mergePluginExports(
      result,
      {
        mcpClients: [client],
        stageHandlers: { 'my-stage': handler },
        skillManager,
      },
      'combo-plugin.js',
    );

    assert.equal(result.mcpClients.length, 1);
    assert.ok(result.stageHandlers.has('my-stage'));
    assert.equal(result.skillManager, skillManager);
  });
});

// ---------------------------------------------------------------------------
// mergePluginExports — pipelinePlugins
// ---------------------------------------------------------------------------

function stubPipeline(name: string): IPipelinePlugin {
  return {
    name,
    parseConfig: (r) => r,
    build: async () => ({ agent: {} as never, close: async () => {} }),
  };
}

describe('pipelinePlugins merge', () => {
  it('emptyLoadedPlugins initialises both pipeline maps', () => {
    const r = emptyLoadedPlugins();
    assert.ok(r.pipelinePlugins instanceof Map);
    assert.ok(r.pipelinePluginSources instanceof Map);
    assert.equal(r.pipelinePlugins.size, 0);
  });

  it('registers a pipeline plugin and records its source', () => {
    const r = emptyLoadedPlugins();
    const registered = mergePluginExports(r, { pipelinePlugins: { dag: stubPipeline('dag') } }, 'pkg-a');
    assert.equal(registered, true);
    assert.equal(r.pipelinePlugins.get('dag')?.name, 'dag');
    assert.equal(r.pipelinePluginSources.get('dag'), 'pkg-a');
  });

  it('rejects a duplicate name: keeps the first, records an error naming both sources', () => {
    const r = emptyLoadedPlugins();
    mergePluginExports(r, { pipelinePlugins: { dag: stubPipeline('dag') } }, 'pkg-a');
    mergePluginExports(r, { pipelinePlugins: { dag: stubPipeline('dag-2') } }, 'pkg-b');
    // first wins
    assert.equal(r.pipelinePlugins.get('dag')?.name, 'dag');
    // duplicate recorded with BOTH sources (stable contract: name + both sources,
    // not a brittle exact phrase)
    const dupe = r.errors.find(
      (e) => e.error.includes("'dag'") && e.error.includes('pkg-a') && e.error.includes('pkg-b'),
    );
    assert.ok(dupe, 'expected a duplicate error naming the pipeline and both sources');
  });
});
