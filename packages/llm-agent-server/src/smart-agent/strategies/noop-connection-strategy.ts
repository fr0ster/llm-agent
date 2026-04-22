import type { IMcpClient } from '../interfaces/mcp-client.js';
import type {
  IMcpConnectionStrategy,
  McpConnectionResult,
} from '../interfaces/mcp-connection-strategy.js';
import type { CallOptions } from '../interfaces/types.js';

export class NoopConnectionStrategy implements IMcpConnectionStrategy {
  async resolve(
    currentClients: IMcpClient[],
    _options?: CallOptions,
  ): Promise<McpConnectionResult> {
    return { clients: currentClients, toolsChanged: false };
  }
}
