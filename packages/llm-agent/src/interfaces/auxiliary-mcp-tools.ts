import type {
  CallOptions,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from './types.js';

/**
 * Pipeline-level auxiliary/service MCP tools (e.g. `wait`). A NARROW seam,
 * deliberately NOT `extends IMcpClient`: no `healthCheck`, and OUTSIDE the MCP
 * fail-loud classifier — auxiliary tools are in-process, so "unavailable" does
 * not apply; an auxiliary error is always a tool-level result.
 *
 * Contributed at pipeline creation and consumer-swappable via
 * `IPipelineContext.auxiliaryMcpTools`. RAG is NOT exposed through this seam.
 */
export interface IAuxiliaryMcpTools {
  listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>>;
}
