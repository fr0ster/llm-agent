import type { McpToolResult } from '@mcp-abap-adt/llm-agent';
import type { IToolCache } from './types.js';
export declare class ToolCache implements IToolCache {
  private readonly map;
  private readonly ttlMs;
  constructor(opts?: {
    ttlMs?: number;
  });
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
  private _key;
}
//# sourceMappingURL=tool-cache.d.ts.map
