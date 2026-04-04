import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../agent.js';
import type { IMcpClient } from '../interfaces/mcp-client.js';
import type {
  IMcpConnectionStrategy,
  McpConnectionResult,
} from '../interfaces/mcp-connection-strategy.js';
import type { CallOptions } from '../interfaces/types.js';
import { makeDefaultDeps, makeMcpClient } from '../testing/index.js';

describe('SmartAgent MCP reconnection', () => {
  it('calls strategy.resolve() before listing tools', async () => {
    let resolveCalled = false;
    const newClient = makeMcpClient([
      { name: 'TestTool', description: 'test', inputSchema: {} },
    ]);
    const strategy: IMcpConnectionStrategy = {
      async resolve(
        _current: IMcpClient[],
        _opts?: CallOptions,
      ): Promise<McpConnectionResult> {
        resolveCalled = true;
        return { clients: [newClient], toolsChanged: false };
      },
    };
    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'hello', finishReason: 'stop' }],
    });
    deps.connectionStrategy = strategy;
    const agent = new SmartAgent(deps, { maxIterations: 1 });
    await agent.process('test');
    assert.ok(resolveCalled, 'Strategy resolve should have been called');
  });

  it('starts with empty clients and recovers via strategy', async () => {
    const tool = {
      name: 'RecoveredTool',
      description: 'recovered',
      inputSchema: {},
    };
    const newClient = makeMcpClient([tool]);
    const strategy: IMcpConnectionStrategy = {
      async resolve(
        _current: IMcpClient[],
        _opts?: CallOptions,
      ): Promise<McpConnectionResult> {
        return { clients: [newClient], toolsChanged: false };
      },
    };
    const { deps } = makeDefaultDeps({
      mcpClients: [],
      llmResponses: [{ content: 'hello', finishReason: 'stop' }],
    });
    deps.connectionStrategy = strategy;
    const agent = new SmartAgent(deps, { maxIterations: 1 });
    const result = await agent.process('test');
    assert.ok(result.ok);
  });

  it('does not call strategy when none configured', async () => {
    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'hello', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, { maxIterations: 1 });
    const result = await agent.process('test');
    assert.ok(result.ok);
  });
});
