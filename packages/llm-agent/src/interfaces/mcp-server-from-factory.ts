import type { IMcpClient } from './mcp-client.js';
import type {
  McpClientDescriptor,
  McpClientFactory,
  McpConnectionConfig,
} from './mcp-connection-strategy.js';
import type { IMcpServer } from './mcp-server.js';

/**
 * Builds an `IMcpServer` from the existing `McpClientFactory`, so the default
 * implementation and anything already written against it keep working.
 *
 * `stop()` is the `close` the factory returned; a factory that returns none
 * has nothing to stop.
 *
 * **Single-use.** Once stopped, this instance cannot be started again —
 * reconnection is `IMcpConnectionStrategy`'s job, not a restarted server's.
 * A `stop()` before any `start()` is a no-op and leaves the instance usable.
 */
export function mcpServerFromFactory(
  factory: McpClientFactory,
  config: McpConnectionConfig,
  descriptor?: McpClientDescriptor,
): IMcpServer {
  let state: 'idle' | 'started' | 'stopped' = 'idle';
  let close: (() => Promise<void> | void) | undefined;

  return {
    ...(descriptor ? { descriptor } : {}),
    async start(): Promise<IMcpClient> {
      if (state === 'started') throw new Error('IMcpServer already started');
      if (state === 'stopped')
        throw new Error('IMcpServer already stopped; build a new one');
      const result = await factory(config);
      state = 'started';
      close = result.close;
      return result.client;
    },
    async stop(): Promise<void> {
      const pending = close;
      close = undefined;
      if (state === 'started') state = 'stopped';
      if (pending) await pending();
    },
  };
}
