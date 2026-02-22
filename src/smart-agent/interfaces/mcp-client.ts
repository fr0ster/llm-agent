import type {
  CallOptions,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from './types.js';

export interface IMcpClient {
  listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>>;

  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>>;
}
