import type {
  IMcpClient,
  IMcpServer,
  McpClientDescriptor,
} from '@mcp-abap-adt/llm-agent';

/** Preserve descriptors when reusing clients whose lifetime belongs to the host. */
export function borrowMcpServers(
  clients: IMcpClient[],
  descriptors: readonly McpClientDescriptor[] | undefined,
): IMcpServer[] {
  return clients.map((client, i) => ({
    descriptor: descriptors?.[i],
    async start() {
      return client;
    },
    async stop() {},
  }));
}
