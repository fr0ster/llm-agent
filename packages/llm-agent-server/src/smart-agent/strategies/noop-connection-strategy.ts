import type { CallOptions, IMcpClient } from '@mcp-abap-adt/llm-agent';
import type {
  IMcpConnectionStrategy,
  McpConnectionResult,
} from '../interfaces/mcp-connection-strategy.js';

export class NoopConnectionStrategy implements IMcpConnectionStrategy {
  async resolve(
    currentClients: IMcpClient[],
    _options?: CallOptions,
  ): Promise<McpConnectionResult> {
    return { clients: currentClients, toolsChanged: false };
  }
}
