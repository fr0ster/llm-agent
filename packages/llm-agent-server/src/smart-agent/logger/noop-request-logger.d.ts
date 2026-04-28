import type { IRequestLogger, LlmCallEntry, RagQueryEntry, RequestSummary, ToolCallEntry } from '@mcp-abap-adt/llm-agent';
export declare class NoopRequestLogger implements IRequestLogger {
    logLlmCall(_entry: LlmCallEntry): void;
    logRagQuery(_entry: RagQueryEntry): void;
    logToolCall(_entry: ToolCallEntry): void;
    startRequest(): void;
    endRequest(): void;
    getSummary(): RequestSummary;
    reset(): void;
}
//# sourceMappingURL=noop-request-logger.d.ts.map