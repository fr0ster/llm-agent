import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IMcpClient,
  IMcpServer,
  IRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { buildSessionLifecycle } from '../index.js';

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

const ragRegistry = {
  closeSession: async () => ({ ok: true as const, value: undefined }),
} as unknown as IRagRegistry;

const base = {
  idleTtlMs: 60_000,
  maxSessions: 4,
  cookieName: 'sid',
  mcpClients: [] as IMcpClient[],
  toolsRag: undefined,
  ragRegistry,
  buildAgent: async () => undefined,
};

describe('buildSessionLifecycle — per-session MCP servers', () => {
  it('forwards buildPerSessionMcpServers, identity and all, ahead of the client builder', async () => {
    const seen: string[] = [];
    let clientBuilderCalls = 0;

    const lifecycle = buildSessionLifecycle({
      ...base,
      buildPerSessionMcpClients: () => {
        clientBuilderCalls++;
        return { clients: [stubClient()], close: async () => {} };
      },
      buildPerSessionMcpServers: (identity): IMcpServer[] => {
        seen.push(identity.sessionId);
        return [
          {
            async start() {
              return stubClient();
            },
            async stop() {},
          },
        ];
      },
    });

    try {
      await lifecycle.acquire('s1');
      assert.deepEqual(seen, ['s1']);
      assert.equal(clientBuilderCalls, 0);
    } finally {
      await lifecycle.disposeAll();
    }
  });

  it('mcpSharedClient does not suppress the server factory', async () => {
    const seen: string[] = [];

    const lifecycle = buildSessionLifecycle({
      ...base,
      mcpSharedClient: true,
      buildPerSessionMcpServers: (identity): IMcpServer[] => {
        seen.push(identity.sessionId);
        return [
          {
            async start() {
              return stubClient();
            },
            async stop() {},
          },
        ];
      },
    });

    try {
      await lifecycle.acquire('s1');
      // `mcpSharedClient` only ever gated `buildPerSessionMcpClients`; a
      // caller wanting one shared server returns the same instance each time.
      assert.deepEqual(seen, ['s1']);
    } finally {
      await lifecycle.disposeAll();
    }
  });

  it('without it, the existing per-session client builder still runs', async () => {
    let clientBuilderCalls = 0;

    const lifecycle = buildSessionLifecycle({
      ...base,
      buildPerSessionMcpClients: () => {
        clientBuilderCalls++;
        return { clients: [stubClient()], close: async () => {} };
      },
    });

    try {
      await lifecycle.acquire('s1');
      assert.equal(clientBuilderCalls, 1);
    } finally {
      await lifecycle.disposeAll();
    }
  });
});
