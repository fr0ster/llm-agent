import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IMcpClient,
  McpClientFactory,
  McpClientFactoryResult,
  McpConnectionConfig,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
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

  it('forwards clientDescriptors and configuredSlotCount from the wrapped Lazy strategy', async () => {
    const namedConfig: McpConnectionConfig = {
      type: 'http',
      url: 'http://host-a/mcp',
      name: 'Alpha',
    };
    const factory = makeSuccessFactory();
    const strategy = new PeriodicConnectionStrategy(
      [namedConfig],
      200,
      undefined,
      factory,
    );

    try {
      await wait(80);

      const result = await strategy.resolve([]);

      assert.deepEqual(result.clientDescriptors, [
        { slotIndex: 0, label: 'Alpha' },
      ]);
      assert.equal(result.configuredSlotCount, 1);
    } finally {
      await strategy.dispose();
    }
  });

  it('toolsChanged is bidirectional across probes — reflects drop, gain, and same-slot reconnect', async () => {
    function makeToggleClient(): IMcpClient & { healthy: boolean } {
      let healthy = true;
      return {
        get healthy() {
          return healthy;
        },
        set healthy(value: boolean) {
          healthy = value;
        },
        async listTools(): Promise<Result<McpTool[], McpError>> {
          return { ok: true, value: [] };
        },
        async callTool(): Promise<Result<McpToolResult, McpError>> {
          return { ok: true, value: { content: 'ok' } };
        },
        async healthCheck(): Promise<Result<boolean, McpError>> {
          return healthy
            ? { ok: true, value: true }
            : { ok: false, error: { message: 'down' } as McpError };
        },
      };
    }

    let reconnectable = true;
    let current = makeToggleClient();
    const factory: McpClientFactory = async () => {
      if (!reconnectable) {
        throw new Error('unreachable');
      }
      current = makeToggleClient();
      return { client: current };
    };

    // Large interval — the automatic timer must not fire during the test; each
    // probe is triggered manually via the private `_probe()` for determinism.
    const strategy = new PeriodicConnectionStrategy(
      [httpConfig],
      10_000_000,
      undefined,
      factory,
    );
    // biome-ignore lint/suspicious/noExplicitAny: test white-box access to force a deterministic probe cycle
    const probe = () => (strategy as any)._probe() as Promise<void>;

    // try/finally: the interval is set to a huge delay (never fires on its
    // own) so a thrown assertion MUST still reach dispose(), or the dangling
    // timer keeps the process — and the test run — alive.
    try {
      // Baseline: the constructor's initial probe connects the slot.
      const baseline = await strategy.resolve([]);
      assert.equal(baseline.clients.length, 1);

      // (a) drop — health fails, reconnect also fails.
      current.healthy = false;
      reconnectable = false;
      await probe();
      const dropped = await strategy.resolve([]);
      assert.equal(dropped.clients.length, 0);
      assert.equal(dropped.toolsChanged, true, 'drop must flip toolsChanged');

      // (b) gain — reconnect succeeds.
      reconnectable = true;
      await probe();
      const gained = await strategy.resolve([]);
      assert.equal(gained.clients.length, 1);
      assert.equal(gained.toolsChanged, true, 'gain must flip toolsChanged');

      // (c) same-slot reconnect within one probe — healthy before and after,
      // but the client instance is replaced.
      const priorClient = current;
      current.healthy = false;
      await probe();
      const reconnected = await strategy.resolve([]);
      assert.equal(reconnected.clients.length, 1);
      assert.notEqual(
        current,
        priorClient,
        'sanity check: new client instance',
      );
      assert.equal(
        reconnected.toolsChanged,
        true,
        'same-slot reconnect must flip toolsChanged',
      );

      // (d) no change.
      await probe();
      const stable = await strategy.resolve([]);
      assert.equal(stable.clients.length, 1);
      assert.equal(
        stable.toolsChanged,
        false,
        'no change must NOT flip toolsChanged',
      );
    } finally {
      await strategy.dispose();
    }
  });
});
