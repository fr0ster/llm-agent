import type { McpToolResult } from '../interfaces/types.js';

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
