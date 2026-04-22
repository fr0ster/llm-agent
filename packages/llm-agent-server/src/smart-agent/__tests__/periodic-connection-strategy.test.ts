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
import { PeriodicConnectionStrategy } from '../strategies/periodic-connection-strategy.js';

// ---------------------------------------------------------------------------
// Test double helpers
// ---------------------------------------------------------------------------

const httpConfig: McpConnectionConfig = {
  type: 'http',
  url: 'http://host-a/mcp',
};

function makeHealthyClient(): IMcpClient {
  return {
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
      return { ok: true, value: true };
    },
  };
}

function makeSuccessFactory(): McpClientFactory & {
  callCount: number;
  closeCalls: number;
} {
  let callCount = 0;
  let closeCalls = 0;
  const factory = async (
    _config: McpConnectionConfig,
  ): Promise<McpClientFactoryResult> => {
    callCount++;
    return {
      client: makeHealthyClient(),
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeriodicConnectionStrategy', () => {
  it('background probe runs and updates cache', async () => {
    const factory = makeSuccessFactory();
    const strategy = new PeriodicConnectionStrategy(
      [httpConfig],
      50,
      undefined,
      factory,
    );

    // Wait for the first probe to complete
    await wait(80);

    const result = await strategy.resolve([]);

    assert.equal(result.clients.length, 1, 'should have one connected client');
    assert.ok(factory.callCount >= 1, 'factory should have been called');

    await strategy.dispose();
  });

  it('resolve() returns cached clients without blocking', async () => {
    const factory = makeSuccessFactory();
    const strategy = new PeriodicConnectionStrategy(
      [httpConfig],
      50,
      undefined,
      factory,
    );

    await wait(80);

    const start = Date.now();
    const result = await strategy.resolve([]);
    const elapsed = Date.now() - start;

    // resolve() should be near-instant (no blocking I/O)
    assert.ok(elapsed < 50, `resolve() should be fast, took ${elapsed}ms`);
    assert.equal(result.clients.length, 1);

    await strategy.dispose();
  });

  it('toolsChanged: true when list changed since last resolve() call, false on second call', async () => {
    const factory = makeSuccessFactory();
    const strategy = new PeriodicConnectionStrategy(
      [httpConfig],
      200,
      undefined,
      factory,
    );

    // Wait for probe to run and populate cache
    await wait(80);

    // First resolve after recovery — should report toolsChanged: true
    const first = await strategy.resolve([]);
    assert.equal(first.clients.length, 1);
    assert.equal(
      first.toolsChanged,
      true,
      'first resolve after probe should report toolsChanged: true',
    );

    // Second resolve — no new probe yet, toolsChanged should be false
    const second = await strategy.resolve([]);
    assert.equal(second.clients.length, 1);
    assert.equal(
      second.toolsChanged,
      false,
      'second resolve without new probe should report toolsChanged: false',
    );

    await strategy.dispose();
  });

  it('dispose() stops interval and closes clients', async () => {
    const factory = makeSuccessFactory();
    const strategy = new PeriodicConnectionStrategy(
      [httpConfig],
      50,
      undefined,
      factory,
    );

    await wait(80);

    const callCountBeforeDispose = factory.callCount;

    await strategy.dispose();

    // After dispose, interval should be cleared — wait and verify no more calls
    await wait(120);

    assert.equal(
      factory.callCount,
      callCountBeforeDispose,
      'no more factory calls after dispose',
    );
    assert.ok(factory.closeCalls >= 1, 'close handles should have been called');
  });
});
