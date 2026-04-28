/**
 * NonStreamingLlm — ILlm decorator that converts streamChat() to chat().
 *
 * When a provider's streaming is unreliable, wrap it with this adapter.
 * chat() works as-is. streamChat() calls chat() and yields the result
 * as a single chunk.
 */
import type {
  CallOptions,
  ILlm,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
export declare class NonStreamingLlm implements ILlm {
  private readonly inner;
  healthCheck?: ILlm['healthCheck'];
  getModels?: ILlm['getModels'];
  constructor(inner: ILlm);
  get model(): string | undefined;
  chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>>;
  streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
}
//# sourceMappingURL=non-streaming-llm.d.ts.map
