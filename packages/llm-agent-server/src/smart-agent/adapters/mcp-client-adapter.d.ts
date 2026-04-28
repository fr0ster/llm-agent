/**
 * McpClientAdapter — wraps MCPClientWrapper as IMcpClient.
 */
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, McpError, type McpTool, type McpToolResult, type Result } from '@mcp-abap-adt/llm-agent';
import type { MCPClientWrapper } from '../../mcp/client.js';
export declare class McpClientAdapter implements IMcpClient {
    private readonly client;
    private toolsCache;
    private lastHealthy;
    constructor(client: MCPClientWrapper);
    listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>>;
    healthCheck(options?: CallOptions): Promise<Result<boolean, McpError>>;
    callTool(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<Result<McpToolResult, McpError>>;
}
//# sourceMappingURL=mcp-client-adapter.d.ts.map