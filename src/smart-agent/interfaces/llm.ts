import type { Message } from '../../types.js';
import type {
  CallOptions,
  LlmError,
  LlmResponse,
  LlmTool,
  Result,
} from './types.js';

export interface ILlm {
  chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>>;
}
