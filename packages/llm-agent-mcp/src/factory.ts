import type {
  McpClientFactoryResult,
  McpConnectionConfig,
} from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter } from './adapter.js';
import type { MCPClientConfig } from './client.js';
import { MCPClientWrapper } from './client.js';

/** Pure mapping helper: converts a McpConnectionConfig to MCPClientWrapper constructor
 *  options. Exported for direct testing without network or ctor spying. */
export function toMcpClientWrapperConfig(
  config: McpConnectionConfig,
): MCPClientConfig {
  if (config.type === 'stdio') {
    return {
      transport: 'stdio',
      command: config.command,
      args: config.args ?? [],
    };
  }
  return {
    transport: 'auto',
    url: config.url,
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.requestHeadersStrategy
      ? { requestHeadersStrategy: config.requestHeadersStrategy }
      : {}),
  };
}

export async function createDefaultMcpClient(
  config: McpConnectionConfig,
): Promise<McpClientFactoryResult> {
  const wrapper = new MCPClientWrapper(toMcpClientWrapperConfig(config));

  await wrapper.connect();
  const client = new McpClientAdapter(wrapper);

  return {
    client,
    close: () => wrapper.disconnect?.() ?? Promise.resolve(),
  };
}
