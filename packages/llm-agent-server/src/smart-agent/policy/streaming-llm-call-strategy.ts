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

/** Always uses streamChat(). Errors propagate as-is. */
export class StreamingLlmCallStrategy implements ILlmCallStrategy {
  async *call(
    llm: ILlm,
    messages: Message[],
    tools: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    yield* llm.streamChat(messages, tools, options);
  }
}
