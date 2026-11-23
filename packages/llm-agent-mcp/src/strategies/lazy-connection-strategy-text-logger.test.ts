import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ITextLogger,
  type McpConnectionConfig,
  McpError,
  MODEL_CONTEXT_EXCEEDED,
} from '@mcp-abap-adt/llm-agent';
import { LazyConnectionStrategy } from './lazy-connection-strategy.js';

function recordingTextLogger(): {
  logger: ITextLogger;
  calls: Array<{ level: string; message: string }>;
} {
  const calls: Array<{ level: string; message: string }> = [];
  const push = (level: string) => (message: string) => {
    calls.push({ level, message });
  };
  return {
    calls,
    logger: {
      info: push('info'),
      error: push('error'),
      warn: push('warn'),
      debug: push('debug'),
    },
  };
}

describe('LazyConnectionStrategy with a text logger', () => {
  it('stores a normalised logger and reports a failed connection through it', async () => {
    const { logger, calls } = recordingTextLogger();
    const config: McpConnectionConfig = {
      type: 'stdio',
      command: 'no-such-command-xyz',
    };

    const strategy = new LazyConnectionStrategy(
      [config],
      { logger, cooldownMs: 0 },
      async () => {
        throw new Error('connect refused');
      },
    );

    await strategy.resolve([]);

    assert.ok(calls.length > 0, 'the text logger received the failure');
    assert.ok(
      calls.every((c) => ['info', 'warn', 'error', 'debug'].includes(c.level)),
      'every call used a real level, i.e. the event was mapped',
    );
  });
});

for (const operation of ['connection', 'health check']) {
  it(`lazy MCP discovery surfaces overflow from ${operation}`, async () => {
    const overflow = new McpError('Prompt too long', MODEL_CONTEXT_EXCEEDED);
    const strategy = new LazyConnectionStrategy(
      [{ type: 'stdio', command: 'unused' }],
      {},
      async () => {
        if (operation === 'connection')
          throw new Error('Connect failed', { cause: overflow });
        return {
          client: {
            async listTools() {
              return { ok: false, error: overflow };
            },
            async callTool() {
              return { ok: true, value: { content: 'ok' } };
            },
          },
        };
      },
    );
    if (operation === 'health check') await strategy.resolve([]);
    await assert.rejects(strategy.resolve([]), (error) => error === overflow);
  });
}
