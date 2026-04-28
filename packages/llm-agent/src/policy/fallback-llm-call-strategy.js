import { NonStreamingLlmCallStrategy } from './non-streaming-llm-call-strategy.js';
import { StreamingLlmCallStrategy } from './streaming-llm-call-strategy.js';
/**
 * Starts with streaming. On error, logs the cause and retries the same call
 * via non-streaming. All subsequent calls use non-streaming for this instance.
 */
export class FallbackLlmCallStrategy {
  logger;
  streamingDisabled = false;
  streaming = new StreamingLlmCallStrategy();
  nonStreaming = new NonStreamingLlmCallStrategy();
  constructor(logger) {
    this.logger = logger;
  }
  async *call(llm, messages, tools, options) {
    if (this.streamingDisabled) {
      yield* this.nonStreaming.call(llm, messages, tools, options);
      return;
    }
    try {
      const chunks = [];
      let hadError = false;
      for await (const chunk of this.streaming.call(
        llm,
        messages,
        tools,
        options,
      )) {
        if (!chunk.ok) {
          // Streaming returned a Result error — treat as streaming failure
          hadError = true;
          this.logFallback(chunk.error.message, chunk.error);
          break;
        }
        chunks.push(chunk);
        yield chunk;
      }
      if (hadError) {
        this.streamingDisabled = true;
        // Retry the same call non-streaming — chunks already yielded are
        // partial content that the consumer may have streamed to the client.
        // We yield a reset signal so the consumer can discard partial state.
        yield { ok: true, value: { content: '', reset: true } };
        yield* this.nonStreaming.call(llm, messages, tools, options);
      }
    } catch (err) {
      // Streaming threw an exception (e.g. SSE disconnect, network error)
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logFallback(errMsg, err);
      this.streamingDisabled = true;
      yield { ok: true, value: { content: '', reset: true } };
      yield* this.nonStreaming.call(llm, messages, tools, options);
    }
  }
  logFallback(message, err) {
    // biome-ignore lint/suspicious/noExplicitAny: ErrorWithCause shape
    const cause = err?.cause;
    const causeDetail = cause?.message || cause;
    const causeCode = cause?.code;
    const detail = causeDetail
      ? ` (cause: ${causeDetail}${causeCode ? `, code: ${causeCode}` : ''})`
      : '';
    this.logger?.log({
      type: 'warning',
      traceId: 'tool-loop',
      message: `Streaming failed, falling back to non-streaming: ${message}${detail}`,
    });
  }
}
//# sourceMappingURL=fallback-llm-call-strategy.js.map
