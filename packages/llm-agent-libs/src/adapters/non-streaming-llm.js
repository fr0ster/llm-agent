/**
 * NonStreamingLlm — ILlm decorator that converts streamChat() to chat().
 *
 * When a provider's streaming is unreliable, wrap it with this adapter.
 * chat() works as-is. streamChat() calls chat() and yields the result
 * as a single chunk.
 */
export class NonStreamingLlm {
  inner;
  healthCheck;
  getModels;
  constructor(inner) {
    this.inner = inner;
    if (inner.healthCheck) {
      this.healthCheck = inner.healthCheck.bind(inner);
    }
    if (inner.getModels) {
      this.getModels = inner.getModels.bind(inner);
    }
  }
  get model() {
    return this.inner.model;
  }
  chat(messages, tools, options) {
    return this.inner.chat(messages, tools, options);
  }
  async *streamChat(messages, tools, options) {
    const result = await this.inner.chat(messages, tools, options);
    if (!result.ok) {
      yield result;
      return;
    }
    yield {
      ok: true,
      value: {
        content: result.value.content,
        finishReason: result.value.finishReason,
        toolCalls: result.value.toolCalls,
        usage: result.value.usage,
      },
    };
  }
}
//# sourceMappingURL=non-streaming-llm.js.map
