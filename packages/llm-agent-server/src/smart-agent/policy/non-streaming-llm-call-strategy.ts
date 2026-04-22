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
export class NonStreamingLlmCallStrategy implements ILlmCallStrategy {
  async *call(
    llm: ILlm,
    messages: Message[],
    tools: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    const result = await llm.chat(messages, tools, options);

    if (!result.ok) {
      yield result;
      return;
    }

    const response = result.value;
    yield {
      ok: true,
      value: {
        content: response.content,
        finishReason: response.finishReason,
        toolCalls: response.toolCalls,
        usage: response.usage,
      },
    };
  }
}
