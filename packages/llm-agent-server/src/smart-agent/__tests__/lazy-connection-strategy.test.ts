import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IMcpClient,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type {
  McpClientFactory,
  McpClientFactoryResult,
  McpConnectionConfig,
} from '../interfaces/mcp-connection-strategy.js';
import { LazyConnectionStrategy } from '../strategies/lazy-connection-strategy.js';

// ---------------------------------------------------------------------------
// Test double helpers
// ---------------------------------------------------------------------------

const httpConfig: McpConnectionConfig = {
  type: 'http',
  url: 'http://host-a/mcp',
};
const http2Config: McpConnectionConfig = {
  type: 'http',
  url: 'http://host-b/mcp',
};

function makeHealthyClient(): IMcpClient & { healthCallCount: number } {
  let healthCallCount = 0;
  return {
    get healthCallCount() {
      return healthCallCount;
    },
    async listTools(): Promise<Result<McpTool[], McpError>> {
      return { ok: true, value: [] };
    },
    async callTool(
      _name: string,
      _args: Record<string, unknown>,
      _options?: CallOptions,
    ): Promise<Result<McpToolResult, McpError>> {
      return { ok: true, value: { content: 'ok' } };
    },
    async healthCheck(): Promise<Result<boolean, McpError>> {
      healthCallCount++;
      return { ok: true, value: true };
    },
  };
}

function makeClientWithoutHealthCheck(): IMcpClient & {
  listToolsCallCount: number;
} {
  let listToolsCallCount = 0;
  return {
    get listToolsCallCount() {
      return listToolsCallCount;
    },
    async listTools(): Promise<Result<McpTool[], McpError>> {
      listToolsCallCount++;
      return { ok: true, value: [] };
    },
    async callTool(): Promise<Result<McpToolResult, McpError>> {
      return { ok: true, value: { content: 'ok' } };
    },
  };
}

function makeSuccessFactory(
  client?: IMcpClient,
): McpClientFactory & { callCount: number; closeCalls: number } {
  let callCount = 0;
  let closeCalls = 0;
  const factory = async (
    _config: McpConnectionConfig,
  ): Promise<McpClientFactoryResult> => {
    callCount++;
    return {
      client: client ?? makeHealthyClient(),
      close: async () => {
        closeCalls++;
      },
    };
  };
  Object.defineProperty(factory, 'callCount', { get: () => callCount });
  Object.defineProperty(factory, 'closeCalls', { get: () => closeCalls });
  return factory as McpClientFactory & {
    callCount: number;
    closeCalls: number;
  };
}

function makeFailingFactory(): McpClientFactory & { callCount: number } {
  let callCount = 0;
  const factory = async (
    _config: McpConnectionConfig,
  ): Promise<McpClientFactoryResult> => {
    callCount++;
    throw new Error('Connection refused');
  };
  Object.defineProperty(factory, 'callCount', { get: () => callCount });
  return factory as McpClientFactory & { callCount: number };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LazyConnectionStrategy', () => {
  it('returns current clients when all healthy', async () => {
    const client = makeHealthyClient();
    const factory = makeSuccessFactory(client);

    // Pre-seed by resolving once (no clients yet, so factory is called)
    const strategy = new LazyConnectionStrategy(
      [httpConfig],
      undefined,
      factory,
    );
    const first = await strategy.resolve([]);
    assert.equal(first.clients.length, 1);
    const factoryCallsAfterFirst = factory.callCount;

    // Second resolve — client is already in slot and healthy
    const second = await strategy.resolve([]);
    assert.equal(second.clients.length, 1);
    // Factory should not have been called again
    assert.equal(factory.callCount, factoryCallsAfterFirst);
    assert.ok(
      client.healthCallCount > 0,
      'healthCheck should have been called',
    );
  });

  it('attempts reconnect when clients are empty', async () => {
    const factory = makeSuccessFactory();
    const strategy = new LazyConnectionStrategy(
      [httpConfig],
      undefined,
      factory,
    );

    const result = await strategy.resolve([]);

    assert.equal(result.clients.length, 1);
    assert.equal(factory.callCount, 1);
  });

  it('respects cooldown — factory called only once when cooldown not expired', async () => {
    const factory = makeFailingFactory();
    const strategy = new LazyConnectionStrategy(
      [httpConfig],
      { cooldownMs: 60000 },
      factory,
    );

    // First call — attempts factory (fails)
    const r1 = await strategy.resolve([]);
    assert.equal(r1.clients.length, 0);
    assert.equal(factory.callCount, 1);

    // Second call immediately — cooldown not expired, factory must NOT be called again
    const r2 = await strategy.resolve([]);
    assert.equal(r2.clients.length, 0);
    assert.equal(factory.callCount, 1);
  });

  it('reconnects only the failed endpoint when one slot is healthy and one is missing', async () => {
    const healthyClient = makeHealthyClient();

    let factoryCallCount = 0;
    const factory: McpClientFactory = async (config) => {
      factoryCallCount++;
      // Only succeed for the second config
      if (config.url === http2Config.url) {
        return { client: makeHealthyClient() };
      }
      throw new Error('should not be called for healthy slot');
    };

    // Bootstrap: pre-seed first slot with a healthy client directly
    const strategy = new LazyConnectionStrategy(
      [httpConfig, http2Config],
      { cooldownMs: 0 },
      factory,
    );

    // Access internal slots to pre-seed (white-box setup for this test)
    // biome-ignore lint/suspicious/noExplicitAny: test white-box access
    const slots = (strategy as any)._slots as Array<{
      config: McpConnectionConfig;
      client?: IMcpClient;
      closeHandle?: () => Promise<void> | void;
      lastAttempt: number;
      healthy: boolean;
    }>;
    slots[0].client = healthyClient;
    slots[0].healthy = true;

    const result = await strategy.resolve([]);

    assert.equal(result.clients.length, 2);
    // Factory should have been called only for the second slot (missing client)
    assert.equal(factoryCallCount, 1);
  });

  it('returns toolsChanged: true on successful reconnect (default skipRevectorize: false)', async () => {
    const factory = makeSuccessFactory();
    const strategy = new LazyConnectionStrategy(
      [httpConfig],
      undefined,
      factory,
    );

    const result = await strategy.resolve([]);

    assert.equal(result.toolsChanged, true);
  });

  it('returns toolsChanged: false when skipRevectorize: true', async () => {
    const factory = makeSuccessFactory();
    const strategy = new LazyConnectionStrategy(
      [httpConfig],
      { skipRevectorize: true },
      factory,
    );

    const result = await strategy.resolve([]);

    assert.equal(result.toolsChanged, false);
    assert.equal(result.clients.length, 1);
  });

  it('deduplicates concurrent resolve() calls — factory called only once', async () => {
    let callCount = 0;
    let resolveFactory!: () => void;
    const factory: McpClientFactory = (_config) => {
      callCount++;
      return new Promise<McpClientFactoryResult>((resolve) => {
        resolveFactory = () => resolve({ client: makeHealthyClient() });
      });
    };

    const strategy = new LazyConnectionStrategy(
      [httpConfig],
      undefined,
      factory,
    );

    // Fire two concurrent resolves
    const p1 = strategy.resolve([]);
    const p2 = strategy.resolve([]);

    // Unblock the factory
    resolveFactory();

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(callCount, 1, 'factory must be called exactly once');
    assert.equal(r1.clients.length, 1);
    assert.equal(r2.clients.length, 1);
    // Both promises must resolve to the same object (same deduped promise)
    assert.equal(r1, r2);
  });

  it('dispose() calls all close handles', async () => {
    let closeCalls = 0;
    const closeHandle = async () => {
      closeCalls++;
    };
    const factory: McpClientFactory = async () => ({
      client: makeHealthyClient(),
      close: closeHandle,
    });

    const strategy = new LazyConnectionStrategy(
      [httpConfig, http2Config],
      { cooldownMs: 0 },
      factory,
    );

    await strategy.resolve([]);
    await strategy.dispose();

    assert.equal(closeCalls, 2);
  });

  it('falls back to listTools() when healthCheck is not available', async () => {
    const client = makeClientWithoutHealthCheck();
    const factory = makeSuccessFactory(client);

    const strategy = new LazyConnectionStrategy(
      [httpConfig],
      undefined,
      factory,
    );

    // First resolve seeds the slot
    await strategy.resolve([]);
    assert.equal(factory.callCount, 1);

    // Second resolve — client exists but has no healthCheck, should use listTools
    const listCallsBefore = client.listToolsCallCount;
    await strategy.resolve([]);
    assert.equal(
      client.listToolsCallCount,
      listCallsBefore + 1,
      'listTools should be called as health fallback',
    );
    // Factory should not have been called again
    assert.equal(factory.callCount, 1);
  });

  it('does not throw when factory fails — returns empty clients', async () => {
    const factory = makeFailingFactory();
    const strategy = new LazyConnectionStrategy(
      [httpConfig],
      { cooldownMs: 0 },
      factory,
    );

    // Should never throw
    const result = await assert.doesNotReject(strategy.resolve([]));
    void result;

    const r = await strategy.resolve([]);
    // After cooldown=0, factory will be retried each call, but never throws outward
    assert.equal(r.clients.length, 0);
  });
});
