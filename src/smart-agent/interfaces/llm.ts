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

  streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
}
