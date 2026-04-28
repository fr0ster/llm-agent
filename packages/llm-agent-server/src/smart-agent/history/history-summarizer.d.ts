import type { CallOptions, HistoryTurn, IHistorySummarizer, ILlm, LlmError, Result } from '@mcp-abap-adt/llm-agent';
export declare class HistorySummarizer implements IHistorySummarizer {
    private readonly llm;
    private readonly prompt;
    constructor(llm: ILlm, opts?: {
        prompt?: string;
    });
    summarize(turn: HistoryTurn, options?: CallOptions): Promise<Result<string, LlmError>>;
}
//# sourceMappingURL=history-summarizer.d.ts.map