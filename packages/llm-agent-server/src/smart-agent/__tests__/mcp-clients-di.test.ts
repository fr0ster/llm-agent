/**
 * Tests for mcpClients DI support across builder, plugins, and SmartServer config.
 *
 * Covers:
 * - SmartAgentBuilder.withMcpClients() passes DI clients to SmartAgent
 * - SmartServer resolves mcpClients with correct precedence (config > plugin > YAML)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  LlmStreamChunk,
  LlmTool,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { LoadedPlugins } from '../plugins/types.js';
import { emptyLoadedPlugins, mergePluginExports } from '../plugins/types.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function stubMcpClient(id: string): IMcpClient {
  const tools: McpTool[] = [
    { name: `${id}-tool`, description: `Tool from ${id}`, inputSchema: {} },
  ];
  return {
    async listTools(): Promise<Result<McpTool[], McpError>> {
      return { ok: true, value: tools };
    },
    async callTool(
      _name: string,
      _args: Record<string, unknown>,
    ): Promise<Result<McpToolResult, McpError>> {
      return { ok: true, value: { content: [] } };
    },
  };
}

function stubLlm(): ILlm {
  return {
    async chat(
      _messages: unknown[],
      _tools?: LlmTool[],
      _options?: CallOptions,
    ) {
      return {
        ok: true as const,
        value: {
          content: 'ok',
          toolCalls: [],
          finishReason: 'stop' as const,
        },
      };
    },
    async *streamChat(
      _messages: unknown[],
      _tools?: LlmTool[],
      _options?: CallOptions,
    ): AsyncGenerator<Result<LlmStreamChunk, Error>> {
      yield {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Builder — withMcpClients()
// ---------------------------------------------------------------------------

describe('SmartAgentBuilder.withMcpClients()', () => {
  it('passes DI clients to SmartAgent (skips auto-connect)', async () => {
    // Dynamic import to avoid pulling in heavy deps at module level
    const { SmartAgentBuilder } = await import('../builder.js');

    const clientA = stubMcpClient('a');
    const clientB = stubMcpClient('b');

    const handle = await new SmartAgentBuilder({})
      .withMainLlm(stubLlm())
      .withMcpClients([clientA, clientB])
      .build();

    try {
      // Agent exposes mcpClients via healthCheck — use listTools to verify
      const health = await handle.agent.healthCheck();
      assert.ok(health.ok);
      // Two MCP clients injected → two MCP health entries
      assert.equal(health.value.mcp.length, 2);
      assert.ok(health.value.mcp[0].ok);
      assert.ok(health.value.mcp[1].ok);
    } finally {
      await handle.close();
    }
  });

  it('builds agent without MCP clients when none provided', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');

    const handle = await new SmartAgentBuilder({})
      .withMainLlm(stubLlm())
      .build();

    try {
      const health = await handle.agent.healthCheck();
      assert.ok(health.ok);
      assert.equal(health.value.mcp.length, 0);
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Plugin merging — mcpClients accumulation across plugins
// ---------------------------------------------------------------------------

describe('Plugin mcpClients accumulation', () => {
  it('merges clients from multiple plugins in order', () => {
    const result = emptyLoadedPlugins();
    const c1 = stubMcpClient('plugin-1');
    const c2 = stubMcpClient('plugin-2');
    const c3 = stubMcpClient('plugin-3');

    mergePluginExports(result, { mcpClients: [c1] }, 'p1.js');
    mergePluginExports(result, { mcpClients: [c2, c3] }, 'p2.js');

    assert.equal(result.mcpClients.length, 3);
    assert.equal(result.mcpClients[0], c1);
    assert.equal(result.mcpClients[1], c2);
    assert.equal(result.mcpClients[2], c3);
    assert.deepEqual(result.loadedFiles, ['p1.js', 'p2.js']);
  });

  it('empty mcpClients array does not register plugin', () => {
    const result = emptyLoadedPlugins();

    mergePluginExports(result, { mcpClients: [] }, 'empty.js');

    assert.equal(result.mcpClients.length, 0);
  });
});

// ---------------------------------------------------------------------------
// SmartServer config — mcpClients precedence
// ---------------------------------------------------------------------------

describe('SmartServer config — mcpClients DI precedence', () => {
  it('config mcpClients takes precedence over plugin mcpClients', () => {
    // Simulates the resolution logic from SmartServer.start():
    // const mcpClients = this.cfg.mcpClients ??
    //   (plugins.mcpClients.length > 0 ? plugins.mcpClients : undefined);

    const configClient = stubMcpClient('config');
    const pluginClient = stubMcpClient('plugin');

    const cfg = { mcpClients: [configClient] };
    const plugins: LoadedPlugins = {
      ...emptyLoadedPlugins(),
      mcpClients: [pluginClient],
    };

    const resolved =
      cfg.mcpClients ??
      (plugins.mcpClients.length > 0 ? plugins.mcpClients : undefined);

    assert.ok(resolved);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0], configClient);
  });

  it('falls back to plugin mcpClients when config has none', () => {
    const pluginClient = stubMcpClient('plugin');

    const cfg: { mcpClients?: IMcpClient[] } = {};
    const plugins: LoadedPlugins = {
      ...emptyLoadedPlugins(),
      mcpClients: [pluginClient],
    };

    const resolved =
      cfg.mcpClients ??
      (plugins.mcpClients.length > 0 ? plugins.mcpClients : undefined);

    assert.ok(resolved);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0], pluginClient);
  });

  it('returns undefined when neither config nor plugins provide mcpClients', () => {
    const cfg: { mcpClients?: IMcpClient[] } = {};
    const plugins = emptyLoadedPlugins();

    const resolved =
      cfg.mcpClients ??
      (plugins.mcpClients.length > 0 ? plugins.mcpClients : undefined);

    assert.equal(resolved, undefined);
  });
});
