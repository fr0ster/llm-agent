import type { IHistoryMemory } from '@mcp-abap-adt/llm-agent';
export declare class HistoryMemory implements IHistoryMemory {
    private readonly maxSize;
    private readonly sessions;
    constructor(opts?: {
        maxSize?: number;
    });
    pushRecent(sessionId: string, summary: string): void;
    getRecent(sessionId: string, limit: number): string[];
    clear(sessionId: string): void;
}
//# sourceMappingURL=history-memory.d.ts.map