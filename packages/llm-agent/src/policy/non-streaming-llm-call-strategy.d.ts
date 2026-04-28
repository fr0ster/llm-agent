import type {
  CallOptions,
  ILlm,
  ILlmCallStrategy,
  LlmError,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
/** Always uses chat(). Result is yielded as a single chunk. Errors propagate as-is. */
export declare class NonStreamingLlmCallStrategy implements ILlmCallStrategy {
  call(
    llm: ILlm,
    messages: Message[],
    tools: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
}
//# sourceMappingURL=non-streaming-llm-call-strategy.d.ts.map
