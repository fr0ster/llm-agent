import {
  type CallOptions,
  type ILlm,
  type ILlmCallStrategy,
  LlmError,
  type LlmStreamChunk,
  type LlmTool,
  type Message,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { ICounter } from '../interfaces/metrics.js';
import type { AnyLogger } from '../logger/normalise-logger.js';
import { normaliseLogger } from '../logger/normalise-logger.js';
import type { ILogger } from '../logger/types.js';
import { isCallerCancellation } from '../resilience/caller-cancellation.js';
import { NonStreamingLlmCallStrategy } from './non-streaming-llm-call-strategy.js';
import { StreamingLlmCallStrategy } from './streaming-llm-call-strategy.js';

/**
 * Starts with streaming. On error, logs the cause and retries the same call
 * via non-streaming. All subsequent calls use non-streaming for this instance.
 * A failure caused by the caller's cancellation (`isCallerCancellation`) is
 * passed through as-is: it says nothing about streaming, so streaming stays
 * enabled and nothing is retried.
 *
 * Each fallback is counted two ways (spec §10.5.12 U1): the warning carries
 * the stable event name `llm_streaming_fallback` with `cause` and a running
 * `fallbacks` count, and an injected `fallbackCount` counter is incremented
 * with the attribute `cause`. A cancellation is never counted.
 */
export class FallbackLlmCallStrategy implements ILlmCallStrategy {
  private streamingDisabled = false;
  private readonly streaming = new StreamingLlmCallStrategy();
  private readonly nonStreaming = new NonStreamingLlmCallStrategy();
  private readonly logger?: ILogger;

  private readonly fallbackCount?: ICounter;
  private fallbacks = 0;

  constructor(
    logger?: AnyLogger,
    options?: { readonly fallbackCount?: ICounter },
  ) {
    this.logger = logger ? normaliseLogger(logger) : undefined;
    this.fallbackCount = options?.fallbackCount;
  }

  async *call(
    llm: ILlm,
    messages: Message[],
    tools: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    if (this.streamingDisabled) {
      yield* this.nonStreaming.call(llm, messages, tools, options);
      return;
    }

    try {
      const chunks: Result<LlmStreamChunk, LlmError>[] = [];
      let hadError = false;

      for await (const chunk of this.streaming.call(
        llm,
        messages,
        tools,
        options,
      )) {
        if (!chunk.ok) {
          if (isCallerCancellation(options?.signal)) {
            yield chunk; // the caller left — not a streaming failure
            return;
          }
          // Streaming returned a Result error — treat as streaming failure
          hadError = true;
          this.logFallback('error', chunk.error.message, chunk.error);
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
    } catch (err: unknown) {
      // Streaming threw an exception (e.g. SSE disconnect, network error)
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isCallerCancellation(options?.signal)) {
        // The caller left — not a streaming failure.
        yield { ok: false, error: new LlmError(errMsg, 'ABORTED') };
        return;
      }
      this.logFallback('throw', errMsg, err);
      this.streamingDisabled = true;
      yield { ok: true, value: { content: '', reset: true } };
      yield* this.nonStreaming.call(llm, messages, tools, options);
    }
  }

  private logFallback(
    cause: 'error' | 'throw',
    message: string,
    err: unknown,
  ): void {
    this.fallbacks++;
    this.fallbackCount?.add(1, { cause });
    // biome-ignore lint/suspicious/noExplicitAny: ErrorWithCause shape
    const errCause = (err as any)?.cause;
    const causeDetail = errCause?.message || errCause;
    const causeCode = errCause?.code;
    const detail = causeDetail
      ? ` (cause: ${causeDetail}${causeCode ? `, code: ${causeCode}` : ''})`
      : '';
    this.logger?.log({
      type: 'warning',
      traceId: 'tool-loop',
      message: `llm_streaming_fallback cause=${cause} fallbacks=${this.fallbacks}: Streaming failed, falling back to non-streaming: ${message}${detail}`,
    });
  }
}
