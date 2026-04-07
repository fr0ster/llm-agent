import type { Message } from '../../types.js';
import type { ILlm } from '../interfaces/llm.js';
import type { ILlmCallStrategy } from '../interfaces/llm-call-strategy.js';
import type {
  CallOptions,
  LlmError,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '../interfaces/types.js';

/** Always uses streamChat(). Errors propagate as-is. */
export class StreamingLlmCallStrategy implements ILlmCallStrategy {
  async *call(
    llm: ILlm,
    messages: Message[],
    tools: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    yield* llm.streamChat(messages, tools, options);
  }
}
