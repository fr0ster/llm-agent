import type {
  McpClientFactoryResult,
  McpConnectionConfig,
} from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter } from './adapter.js';
import { MCPClientWrapper } from './client.js';

export async function createDefaultMcpClient(
  config: McpConnectionConfig,
): Promise<McpClientFactoryResult> {
  const wrapper =
    config.type === 'stdio'
      ? new MCPClientWrapper({
          transport: 'stdio',
          command: config.command,
          args: config.args ?? [],
        })
      : new MCPClientWrapper({
          transport: 'auto',
          url: config.url,
        });

  await wrapper.connect();
  const client = new McpClientAdapter(wrapper);

  return {
    client,
    close: () => wrapper.disconnect?.() ?? Promise.resolve(),
  };
}
