import { MCPClientWrapper } from '../mcp/client.js';
import { McpClientAdapter } from './adapters/mcp-client-adapter.js';
export async function createDefaultMcpClient(config) {
    const wrapper = config.type === 'stdio'
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
//# sourceMappingURL=mcp-client-factory.js.map