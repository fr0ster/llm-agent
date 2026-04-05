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
  /** Model identifier used for usage tracking. */
  readonly model?: string;

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

  /**
   * Lightweight health check — verifies provider reachability and model
   * availability without sending a completion request (no token cost).
   *
   * Returns `true` when the configured model is available, `false` otherwise.
   */
  healthCheck?(options?: CallOptions): Promise<Result<boolean, LlmError>>;
}
