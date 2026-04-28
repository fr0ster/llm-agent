import type {
  CallOptions,
  IMcpClient,
  IMcpConnectionStrategy,
  McpConnectionResult,
} from '@mcp-abap-adt/llm-agent';

export class NoopConnectionStrategy implements IMcpConnectionStrategy {
  async resolve(
    currentClients: IMcpClient[],
    _options?: CallOptions,
  ): Promise<McpConnectionResult> {
    return { clients: currentClients, toolsChanged: false };
  }
}
