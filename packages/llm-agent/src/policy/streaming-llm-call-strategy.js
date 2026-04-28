/** Always uses streamChat(). Errors propagate as-is. */
export class StreamingLlmCallStrategy {
    async *call(llm, messages, tools, options) {
        yield* llm.streamChat(messages, tools, options);
    }
}
//# sourceMappingURL=streaming-llm-call-strategy.js.map