import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ITextLogger, McpConnectionConfig } from '@mcp-abap-adt/llm-agent';
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
