import type { CallOptions, McpError, McpTool, McpToolResult, Result } from './types.js';
export interface IMcpClient {
    listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>>;
    callTool(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<Result<McpToolResult, McpError>>;
    /**
     * Lightweight health check — verifies the MCP server is reachable
     * without triggering a full tools/list request.
     *
     * Optional: when not implemented, the caller should fall back
     * to a simple connectivity assumption or listTools().
     */
    healthCheck?(options?: CallOptions): Promise<Result<boolean, McpError>>;
}
//# sourceMappingURL=mcp-client.d.ts.map