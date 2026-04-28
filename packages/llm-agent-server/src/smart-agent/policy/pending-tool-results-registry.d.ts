import type { Message } from '@mcp-abap-adt/llm-agent';
export interface PendingToolResult {
    toolCallId: string;
    toolName: string;
    text: string;
}
export interface PendingToolCallsEntry {
    assistantMessage: Message;
    promise: Promise<PendingToolResult[]>;
    createdAt: number;
}
export declare class PendingToolResultsRegistry {
    private readonly ttlMs;
    private readonly sessions;
    constructor(ttlMs?: number);
    set(sessionId: string, entry: PendingToolCallsEntry): void;
    has(sessionId: string, now?: number): boolean;
    consume(sessionId: string, now?: number): Promise<{
        assistantMessage: Message;
        results: PendingToolResult[];
    } | null>;
    get size(): number;
    private pruneAll;
}
//# sourceMappingURL=pending-tool-results-registry.d.ts.map