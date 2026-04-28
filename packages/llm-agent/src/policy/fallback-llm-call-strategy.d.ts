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
import type { ILogger } from '../logger/types.js';
/**
 * Starts with streaming. On error, logs the cause and retries the same call
 * via non-streaming. All subsequent calls use non-streaming for this instance.
 */
export declare class FallbackLlmCallStrategy implements ILlmCallStrategy {
  private readonly logger?;
  private streamingDisabled;
  private readonly streaming;
  private readonly nonStreaming;
  constructor(logger?: ILogger | undefined);
  call(
    llm: ILlm,
    messages: Message[],
    tools: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
  private logFallback;
}
//# sourceMappingURL=fallback-llm-call-strategy.d.ts.map
