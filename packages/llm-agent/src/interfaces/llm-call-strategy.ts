import type { Message } from '../types.js';
import type { ILlm } from './llm.js';
import type {
  CallOptions,
  LlmError,
  LlmStreamChunk,
  LlmTool,
  Result,
} from './types.js';

/**
 * Strategy for how the tool-loop calls the LLM.
 *
 * Implementations decide whether to use streaming, non-streaming,
 * or a combination (e.g. auto-fallback).
 */
export interface ILlmCallStrategy {
  call(
    llm: ILlm,
    messages: Message[],
    tools: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
}
