import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type {
  IMcpClient,
  McpClientFactory,
  McpConnectionConfig,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { isMcpUnavailable } from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter } from '../adapter.js';
import { MCPClientWrapper } from '../client.js';
import { toMcpError } from '../error-mapping.js';
import { LazyConnectionStrategy } from '../strategies/lazy-connection-strategy.js';

// Spec §10.5.3 M1, M2, M3b — a server that is down is an error, never a
// cached tool list and never a healthy slot.

const TOOL = { name: 't1', description: 'd', inputSchema: { type: 'object' } };

describe('M1 MCPClientWrapper.listTools — no cached list after a failed reconnect', () => {
  it('rejects with a mapped unavailable error after a successful first listing', async () => {
    const w = new MCPClientWrapper({
      transport: 'stream-http',
      url: 'http://localhost:9/mcp',
    });
    let down = false;
    const sdkClient = {
      listTools: async () => {
        if (down) throw new Error('fetch failed');
        return { tools: [TOOL] };
      },
      close: async () => {},
    };
    const internals = w as unknown as {
      client: unknown;
      connect(): Promise<void>;
      disconnect(): Promise<void>;
    };
    internals.client = sdkClient;
    internals.connect = async () => {
      internals.client = sdkClient;
    };
    internals.disconnect = async () => {
      internals.client = null;
    };

    const first = await w.listTools();
    assert.equal(first.length, 1);

    down = true;
    // The wrapper warns before its reconnect; keep the test output clean.
    const warn = mock.method(console, 'warn', () => {});
    try {
      await assert.rejects(w.listTools(), (err: unknown) => {
        assert.ok(isMcpUnavailable(toMcpError(err)), String(err));
        return true;
      });
    } finally {
      warn.mock.restore();
    }
    assert.equal(warn.mock.callCount(), 1);
  });
});

describe('M2 McpClientAdapter — the tools cache answers only while healthy', () => {
  it('after a failed health probe, listTools asks the server and fails MCP_NOT_CONNECTED', async () => {
    let down = false;
    const wrapper = {
      listTools: async () => {
        if (down) throw new Error('Not connected');
        return [TOOL];
      },
      ping: async () => {
        if (down) throw new Error('Not connected');
      },
    } as unknown as MCPClientWrapper;
    const adapter = new McpClientAdapter(wrapper);

    const first = await adapter.listTools();
    assert.ok(first.ok);

    down = true;
    const health = await adapter.healthCheck();
    assert.ok(!health.ok);

    const r = await adapter.listTools();
    assert.ok(!r.ok, 'a cached list after a failed probe');
    assert.equal(r.error.code, 'MCP_NOT_CONNECTED');
  });

  it('after a failed call, listTools asks the server again', async () => {
    let down = false;
    let lists = 0;
    const wrapper = {
      listTools: async () => {
        lists++;
        if (down) throw new Error('Not connected');
        return [TOOL];
      },
      callTool: async () => {
        throw new Error('Not connected');
      },
    } as unknown as MCPClientWrapper;
    const adapter = new McpClientAdapter(wrapper);
    assert.ok((await adapter.listTools()).ok);
    down = true;
    const call = await adapter.callTool('t1', {});
    assert.ok(!call.ok);
    const r = await adapter.listTools();
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'MCP_NOT_CONNECTED');
    assert.equal(lists, 2);
  });

  it('while healthy, the cache still answers (unchanged)', async () => {
    let lists = 0;
    const wrapper = {
      listTools: async () => {
        lists++;
        return [TOOL];
      },
      ping: async () => {},
    } as unknown as MCPClientWrapper;
    const adapter = new McpClientAdapter(wrapper);
    assert.ok((await adapter.listTools()).ok);
    assert.ok((await adapter.healthCheck()).ok);
    assert.ok((await adapter.listTools()).ok);
    assert.equal(lists, 1);
  });
});

describe('M3b LazyConnectionStrategy — healthCheck value false is not healthy', () => {
  it('a client answering { ok: true, value: false } is left out and isReady() is false', async () => {
    let healthy = true;
    const client: IMcpClient = {
      async listTools(): Promise<Result<McpTool[], McpError>> {
        return { ok: true, value: [] };
      },
      async callTool(): Promise<Result<McpToolResult, McpError>> {
        return { ok: true, value: { content: 'ok' } };
      },
      async healthCheck(): Promise<Result<boolean, McpError>> {
        return { ok: true, value: healthy };
      },
    };
    const factory: McpClientFactory = async () => ({ client });
    const config: McpConnectionConfig = { type: 'http', url: 'http://a/mcp' };
    const strategy = new LazyConnectionStrategy(
      [config],
      { cooldownMs: 60_000 },
      factory,
    );

    const first = await strategy.resolve();
    assert.equal(first.clients.length, 1);
    assert.equal(strategy.isReady(), true);

    healthy = false;
    const second = await strategy.resolve();
    assert.equal(second.clients.length, 0);
    assert.equal(second.configuredSlotCount, 1);
    assert.equal(strategy.isReady(), false);
  });
});
