import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  IMcpServer,
  LlmStreamChunk,
  LlmTool,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

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
        value: { content: 'ok', toolCalls: [], finishReason: 'stop' as const },
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

function stubServer(id: string, log: string[]): IMcpServer {
  return {
    async start() {
      log.push(`start:${id}`);
      return stubMcpClient(id);
    },
    async stop() {
      log.push(`stop:${id}`);
    },
  };
}

describe('SmartAgentBuilder.withMcpServers()', () => {
  it('starts every server and hands its client to the agent', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const log: string[] = [];

    const handle = await new SmartAgentBuilder({})
      .withMainLlm(stubLlm())
      .withMcpServers([stubServer('a', log), stubServer('b', log)])
      .build();

    try {
      assert.deepEqual(log, ['start:a', 'start:b']);
      const health = await handle.agent.healthCheck();
      assert.ok(health.ok);
      assert.equal(health.value.mcp.length, 2);
    } finally {
      await handle.close();
    }

    assert.deepEqual(log, ['start:a', 'start:b', 'stop:a', 'stop:b']);
  });

  it('a half-filled descriptor set throws instead of renaming tools behind the caller', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const log: string[] = [];
    const described: IMcpServer = {
      descriptor: { slotIndex: 0, label: 'abap' },
      async start() {
        return stubMcpClient('d');
      },
      async stop() {},
    };

    // One server carries a descriptor, one does not. Dropping the pair would
    // silently re-namespace `abap__Search` to `s0__Search`, so this is a
    // caller bug and must be loud.
    await assert.rejects(
      () =>
        new SmartAgentBuilder({})
          .withMainLlm(stubLlm())
          .withMcpServers([described, stubServer('e', log)])
          .build(),
      /descriptor/i,
    );

    // The descriptor check runs before the start loop, so nothing started.
    assert.deepEqual(log, []);
  });

  it('withMcpServers and withMcpClients together are a configuration error', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const log: string[] = [];

    await assert.rejects(
      () =>
        new SmartAgentBuilder({})
          .withMainLlm(stubLlm())
          .withMcpClients([stubMcpClient('c')])
          .withMcpServers([stubServer('a', log)])
          .build(),
      /withMcpClients/,
    );
  });

  it('a start that fails half-way stops what already started, and rethrows the original error', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const log: string[] = [];
    const failing: IMcpServer = {
      async start() {
        throw new Error('spawn failed');
      },
      async stop() {
        log.push('stop:failing');
      },
    };

    await assert.rejects(
      () =>
        new SmartAgentBuilder({})
          .withMainLlm(stubLlm())
          .withMcpServers([stubServer('a', log), failing])
          .build(),
      /spawn failed/,
    );

    // The first server is stopped; the one whose start() threw was never
    // registered, so its stop() is not called.
    assert.deepEqual(log, ['start:a', 'stop:a']);
  });

  it('withMcpClients is untouched: nothing is started, nothing is stopped', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');

    const handle = await new SmartAgentBuilder({})
      .withMainLlm(stubLlm())
      .withMcpClients([stubMcpClient('c')])
      .build();

    try {
      const health = await handle.agent.healthCheck();
      assert.ok(health.ok);
      assert.equal(health.value.mcp.length, 1);
    } finally {
      await handle.close();
    }
  });
});
