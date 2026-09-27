import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IMcpClient,
  IPipelinePlugin,
  ISkillManager,
  PluginExports,
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
    const registered = mergePluginExports(
      r,
      { pipelinePlugins: { dag: stubPipeline('dag') } },
      'pkg-a',
    );
    assert.equal(registered, true);
    assert.equal(r.pipelinePlugins.get('dag')?.name, 'dag');
    assert.equal(r.pipelinePluginSources.get('dag'), 'pkg-a');
  });

  it('rejects a duplicate key: keeps the first, records an error naming both sources', () => {
    const r = emptyLoadedPlugins();
    const first = stubPipeline('dag');
    mergePluginExports(r, { pipelinePlugins: { dag: first } }, 'pkg-a');
    mergePluginExports(
      r,
      { pipelinePlugins: { dag: stubPipeline('dag') } },
      'pkg-b',
    );
    assert.equal(r.pipelinePlugins.get('dag'), first, 'first wins');
    assert.ok(
      r.errors.find(
        (e) =>
          e.error.includes("'dag'") &&
          e.error.includes('pkg-a') &&
          e.error.includes('pkg-b'),
      ),
    );
  });

  for (const [what, value, expected] of [
    ['a missing build', { name: 'x' }, /'build' must be a function/],
    [
      'a non-string name',
      { name: 7, build: async () => ({}) },
      /'name' must be a string/,
    ],
    ['a non-object', 'x', /expected an object/],
    ['null', null, /got null/],
  ] as const) {
    it(`refuses ${what} and says so, naming the module and the key`, () => {
      const r = emptyLoadedPlugins();
      const registered = mergePluginExports(
        r,
        { pipelinePlugins: { x: value } } as unknown as PluginExports,
        'pkg-bad',
      );
      assert.equal(registered, false);
      assert.equal(r.pipelinePlugins.size, 0);
      assert.equal(
        r.errors.length,
        1,
        'a refusal is reported, never skipped in silence',
      );
      assert.equal(r.errors[0].file, 'pkg-bad');
      assert.match(r.errors[0].error, /'x'/);
      assert.match(r.errors[0].error, expected);
    });
  }

  it('refuses an instance whose name differs from its key', () => {
    const r = emptyLoadedPlugins();
    mergePluginExports(
      r,
      { pipelinePlugins: { planner2: stubPipeline('planner') } },
      'pkg-a',
    );
    assert.equal(r.pipelinePlugins.has('planner2'), false);
    assert.match(
      r.errors[0].error,
      /name 'planner' differs from the key 'planner2'/,
    );
  });

  it('registers a factory without calling it, and records its source', () => {
    const r = emptyLoadedPlugins();
    let called = 0;
    const factory = () => {
      called++;
      return stubPipeline('ext');
    };
    assert.equal(
      mergePluginExports(
        r,
        { pipelinePluginFactories: { ext: factory } },
        'pkg-f',
      ),
      true,
    );
    assert.equal(r.pipelinePluginFactories?.get('ext'), factory);
    assert.equal(r.pipelinePluginSources.get('ext'), 'pkg-f');
    assert.equal(
      called,
      0,
      'the loader never calls a factory — only the server does',
    );
  });

  it('refuses a factory that is not a function', () => {
    const r = emptyLoadedPlugins();
    mergePluginExports(
      r,
      {
        pipelinePluginFactories: { ext: stubPipeline('ext') },
      } as unknown as PluginExports,
      'pkg-f',
    );
    assert.equal(r.pipelinePluginFactories?.has('ext'), false);
    assert.match(
      r.errors[0].error,
      /factory 'ext' from 'pkg-f' refused: expected a function/,
    );
  });

  it('a key is one namespace across instances and factories', () => {
    const r = emptyLoadedPlugins();
    mergePluginExports(
      r,
      { pipelinePlugins: { dag: stubPipeline('dag') } },
      'pkg-a',
    );
    mergePluginExports(
      r,
      { pipelinePluginFactories: { dag: () => stubPipeline('dag') } },
      'pkg-b',
    );
    assert.equal(r.pipelinePluginFactories?.has('dag'), false);
    assert.match(
      r.errors[0].error,
      /duplicate pipeline name 'dag' from 'pkg-b'.*'pkg-a'/,
    );
  });

  it('refuses a pipelinePlugins export that is not an object', () => {
    const r = emptyLoadedPlugins();
    mergePluginExports(
      r,
      { pipelinePlugins: [] } as unknown as PluginExports,
      'pkg-arr',
    );
    assert.match(
      r.errors[0].error,
      /'pipelinePlugins' from 'pkg-arr' must be an object/,
    );
  });
});
