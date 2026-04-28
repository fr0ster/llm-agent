/** Always uses chat(). Result is yielded as a single chunk. Errors propagate as-is. */
export class NonStreamingLlmCallStrategy {
  async *call(llm, messages, tools, options) {
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
//# sourceMappingURL=non-streaming-llm-call-strategy.js.map
