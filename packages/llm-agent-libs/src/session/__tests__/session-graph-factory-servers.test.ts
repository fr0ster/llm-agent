import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type IMcpClient,
  type IMcpServer,
  InMemoryRagProvider,
  type IRagRegistry,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { SessionGraphFactory } from '../session-graph-factory.js';

function makeRagRegistry(): IRagRegistry {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return reg;
}

function stubClient(): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool() {
      return { ok: true as const, value: { content: [] } };
    },
  } as unknown as IMcpClient;
}

function stubServer(id: string, log: string[]): IMcpServer {
  return {
    async start() {
      log.push(`start:${id}`);
      return stubClient();
    },
    async stop() {
      log.push(`stop:${id}`);
    },
  };
}

test('mcpServerFactory receives the identity, and its clients reach buildAgent', async () => {
  const log: string[] = [];
  const seen: string[] = [];
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    mcpServerFactory: (identity) => {
      seen.push(identity.sessionId);
      return [stubServer('a', log)];
    },
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async (parts) => {
      assert.equal(parts.mcpClients.length, 1);
      return undefined;
    },
  });

  await factory.build({ sessionId: 's1' });
  assert.deepEqual(seen, ['s1']);
  assert.deepEqual(log, ['start:a']);
});

test('teardown runs closePipeline, then closeSession, then onDispose, then stop', async () => {
  const order: string[] = [];
  const ragRegistry = {
    closeSession: async () => {
      order.push('closeSession');
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagRegistry;

  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    mcpServerFactory: () => [
      {
        async start() {
          return stubClient();
        },
        async stop() {
          order.push('stop');
        },
      },
    ],
    closePipeline: async () => {
      order.push('closePipeline');
    },
    onDispose: async () => {
      order.push('onDispose');
    },
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async () => undefined,
  });

  const graph = await factory.build({ sessionId: 's1' });
  await graph.dispose();

  assert.deepEqual(order, [
    'closePipeline',
    'closeSession',
    'onDispose',
    'stop',
  ]);
});

test('a throwing closePipeline does not block closeSession, onDispose or stop', async () => {
  const order: string[] = [];
  const ragRegistry = {
    closeSession: async () => {
      order.push('closeSession');
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagRegistry;

  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    mcpServerFactory: () => [
      {
        async start() {
          return stubClient();
        },
        async stop() {
          order.push('stop');
        },
      },
    ],
    closePipeline: async () => {
      throw new Error('pipeline still draining');
    },
    onDispose: async () => {
      order.push('onDispose');
    },
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async () => undefined,
  });

  const graph = await factory.build({ sessionId: 's1' });
  await graph.dispose();

  assert.deepEqual(order, ['closeSession', 'onDispose', 'stop']);
});

test('without mcpServerFactory nothing changes: mcpClientFactory is used and no stop runs', async () => {
  const order: string[] = [];
  const ragRegistry = {
    closeSession: async () => {
      order.push('closeSession');
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagRegistry;

  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [stubClient()],
    onDispose: async () => {
      order.push('onDispose');
    },
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async (parts) => {
      assert.equal(parts.mcpClients.length, 1);
      return undefined;
    },
  });

  const graph = await factory.build({ sessionId: 's1' });
  await graph.dispose();

  assert.deepEqual(order, ['closeSession', 'onDispose']);
});

test('adopting mcpServerFactory alone compiles and runs: no deprecated stub needed', async () => {
  const factory = new SessionGraphFactory({
    mcpServerFactory: () => [
      {
        async start() {
          return stubClient();
        },
        async stop() {},
      },
    ],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async (parts) => {
      assert.equal(parts.mcpClients.length, 1);
      return undefined;
    },
  });

  const graph = await factory.build({ sessionId: 's1' });
  await graph.dispose();
});

test('no factory at all is a configuration error, named in the message', async () => {
  const factory = new SessionGraphFactory({
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
  });

  await assert.rejects(
    () => factory.build({ sessionId: 's1' }),
    /mcpServerFactory/,
  );
});

test('a partly-filled descriptor set throws before any server is started', async () => {
  let started = 0;
  const factory = new SessionGraphFactory({
    mcpServerFactory: () => [
      {
        descriptor: { slotIndex: 0, label: 'abap' },
        async start() {
          started++;
          return stubClient();
        },
        async stop() {},
      },
      {
        async start() {
          started++;
          return stubClient();
        },
        async stop() {},
      },
    ],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
  });

  await assert.rejects(() => factory.build({ sessionId: 's1' }), /descriptor/i);
  assert.equal(started, 0);
});

test('a start that fails half-way stops the servers already started', async () => {
  const log: string[] = [];
  const factory = new SessionGraphFactory({
    mcpServerFactory: () => [
      {
        async start() {
          log.push('start:a');
          return stubClient();
        },
        async stop() {
          log.push('stop:a');
        },
      },
      {
        async start(): Promise<IMcpClient> {
          throw new Error('spawn failed');
        },
        async stop() {
          log.push('stop:b');
        },
      },
    ],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
  });

  await assert.rejects(
    () => factory.build({ sessionId: 's1' }),
    /spawn failed/,
  );
  assert.deepEqual(log, ['start:a', 'stop:a']);
});

test('a failing stop is surfaced, not thrown', async () => {
  const warnings: string[] = [];
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    mcpServerFactory: () => [
      {
        async start() {
          return stubClient();
        },
        async stop() {
          throw new Error('boom');
        },
      },
    ],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
    logger: {
      log: (e) => {
        if (e.type === 'warning') warnings.push(e.message);
      },
    },
  });

  const graph = await factory.build({ sessionId: 's1' });
  await graph.dispose();
  assert.equal(
    warnings.some((m) => m.includes('boom')),
    true,
  );
});
