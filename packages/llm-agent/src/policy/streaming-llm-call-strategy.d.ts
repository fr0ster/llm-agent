import type { CallOptions, ILlm, ILlmCallStrategy, LlmError, LlmStreamChunk, LlmTool, Message, Result } from '@mcp-abap-adt/llm-agent';
/** Always uses streamChat(). Errors propagate as-is. */
export declare class StreamingLlmCallStrategy implements ILlmCallStrategy {
    call(llm: ILlm, messages: Message[], tools: LlmTool[], options?: CallOptions): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
}
//# sourceMappingURL=streaming-llm-call-strategy.d.ts.map