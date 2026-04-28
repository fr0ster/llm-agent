import type { CallOptions, LlmError, Result } from './types.js';
export interface HistoryTurn {
    sessionId: string;
    turnIndex: number;
    userText: string;
    assistantText: string;
    toolCalls: Array<{
        name: string;
        arguments: unknown;
    }>;
    toolResults: Array<{
        tool: string;
        content: string;
    }>;
    timestamp: number;
}
export interface IHistorySummarizer {
    summarize(turn: HistoryTurn, options?: CallOptions): Promise<Result<string, LlmError>>;
}
//# sourceMappingURL=history-summarizer.d.ts.map