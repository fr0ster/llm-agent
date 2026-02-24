import type { Message } from '../../types.js';
import type {
  CallOptions,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Result,
} from './types.js';

export interface ILlm {
  chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>>;

  /**
   * Stream a chat response as an async generator of typed chunks.
   * Optional — providers that do not support streaming omit this method.
   * The caller must check for its presence before using it.
   *
   * Chunk order:
   *   text / tool_calls chunks (zero or more)
   *   → usage chunk (if provider sends it)
   *   → done chunk (always last)
   */
  streamChat?(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncGenerator<LlmStreamChunk, void, unknown>;
}
