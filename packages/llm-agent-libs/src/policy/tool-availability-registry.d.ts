import type { LlmTool } from '@mcp-abap-adt/llm-agent';
export interface ToolBlockEntry {
  toolName: string;
  blockedUntil: number;
  reason: string;
}
export declare class ToolAvailabilityRegistry {
  private readonly defaultTtlMs;
  private readonly sessions;
  constructor(defaultTtlMs?: number);
  getBlockedToolNames(sessionId: string, now?: number): Set<string>;
  isBlocked(sessionId: string, toolName: string, now?: number): boolean;
  block(
    sessionId: string,
    toolName: string,
    reason: string,
    ttlMs?: number,
    now?: number,
  ): ToolBlockEntry;
  filterTools(
    sessionId: string,
    tools: LlmTool[],
    now?: number,
  ): {
    allowed: LlmTool[];
    blocked: string[];
  };
  private prune;
}
export declare function isToolContextUnavailableError(message: string): boolean;
//# sourceMappingURL=tool-availability-registry.d.ts.map
