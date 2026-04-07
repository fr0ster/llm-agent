import type { Message } from '../../types.js';

/**
 * Strategy for compacting tool results in tool-loop message history.
 *
 * Called before each LLM iteration (after the first) to reduce payload size.
 * Implementations decide which tool results to keep full and which to summarize.
 */
export interface IToolResultCompactor {
  compact(
    messages: Message[],
    currentIteration: number,
  ): Promise<Message[]> | Message[];
}
