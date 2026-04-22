import type { McpToolResult } from '@mcp-abap-adt/llm-agent';

export interface IToolCache {
  get(
    toolName: string,
    args: Record<string, unknown>,
  ): McpToolResult | undefined;
  set(
    toolName: string,
    args: Record<string, unknown>,
    result: McpToolResult,
  ): void;
  clear(): void;
}
