import type { IRequestLogger, LlmCallEntry, RagQueryEntry, RequestSummary, ToolCallEntry } from '@mcp-abap-adt/llm-agent';
export declare class DefaultRequestLogger implements IRequestLogger {
    private initLlmCalls;
    private requestLlmCalls;
    private ragQueryEntries;
    private toolCallEntries;
    private requestStartMs;
    private requestDurationMs;
    startRequest(): void;
    endRequest(): void;
    logLlmCall(entry: LlmCallEntry): void;
    logRagQuery(entry: RagQueryEntry): void;
    logToolCall(entry: ToolCallEntry): void;
    getSummary(): RequestSummary;
    reset(): void;
}
//# sourceMappingURL=default-request-logger.d.ts.map