import {
  type CallOptions,
  type ILlm,
  type ILlmCallStrategy,
  LlmError,
  type LlmStreamChunk,
  type LlmTool,
  type LlmUsageAttribution,
  type Message,
  type Result,
  startOperation,
  terminalRunError,
  withOuterAttempt,
} from '@mcp-abap-adt/llm-agent';
import type { AnyLogger } from '../logger/normalise-logger.js';
import { normaliseLogger } from '../logger/normalise-logger.js';
import type { ILogger } from '../logger/types.js';
import { isCallerCancellation } from '../resilience/caller-cancellation.js';
import { NonStreamingLlmCallStrategy } from './non-streaming-llm-call-strategy.js';
import { StreamingLlmCallStrategy } from './streaming-llm-call-strategy.js';

/**
 * Starts with streaming. On error, logs the cause and retries the same call
 * via non-streaming. All subsequent calls use non-streaming for this instance.
 * Terminal failures and caller cancellation leave streaming enabled and end
 * the current call.
 */
export class FallbackLlmCallStrategy implements ILlmCallStrategy {
  private streamingDisabled = false;
  private readonly streaming = new StreamingLlmCallStrategy();
  private readonly nonStreaming = new NonStreamingLlmCallStrategy();
  private readonly logger?: ILogger;

  constructor(logger?: AnyLogger) {
    this.logger = logger ? normaliseLogger(logger) : undefined;
  }

  async *call(
    llm: ILlm,
    messages: Message[],
    tools: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    const op = startOperation(options);
    const initialOptions = { ...options, usageOp: { ...op } };
    const fallbackOptions = { ...options, usageOp: withOuterAttempt(op, 1) };
    if (this.streamingDisabled) {
      yield* this.nonStreaming.call(llm, messages, tools, initialOptions);
      return;
    }

    let failure: LlmUsageAttribution | undefined;
    try {
      for await (const chunk of this.streaming.call(
        llm,
        messages,
        tools,
        initialOptions,
      )) {
        if (!chunk.ok) {
          const terminal = terminalRunError(chunk.error);
          if (terminal) {
            yield { ok: false, error: terminal };
            return;
          }
          if (isCallerCancellation(options?.signal)) {
            yield chunk;
            return;
          }
          // Streaming returned a Result error — treat as streaming failure
          failure = chunk.error;
          this.logFallback(chunk.error.message, chunk.error);
          break;
        }
        yield chunk;
      }
    } catch (err) {
      const terminal = terminalRunError(err);
      if (terminal) {
        yield { ok: false, error: terminal };
        return;
      }
      // Streaming threw an exception (e.g. SSE disconnect, network error)
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isCallerCancellation(options?.signal)) {
        // The caller left — not a streaming failure.
        yield { ok: false, error: new LlmError(errMsg, 'ABORTED') };
        return;
      }
      this.logFallback(errMsg, err);
      failure =
        typeof err === 'object' && err !== null
          ? (err as LlmUsageAttribution)
          : {};
    }

    if (!failure) return;
    this.streamingDisabled = true;
    const { usage, model, usageByModel, usageCalls } = failure;
    yield {
      ok: true,
      value: {
        content: '',
        reset: true,
        ...(usage || model !== undefined || usageByModel || usageCalls
          ? { retryUsage: { usage, model, usageByModel, usageCalls } }
          : {}),
      },
    };
    yield* this.nonStreaming.call(llm, messages, tools, fallbackOptions);
  }

  private logFallback(message: string, err: unknown): void {
    // biome-ignore lint/suspicious/noExplicitAny: ErrorWithCause shape
    const cause = (err as any)?.cause;
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
