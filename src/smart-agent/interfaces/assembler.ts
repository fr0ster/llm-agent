import type { Message } from '../../types.js';
import type {
  AssemblerError,
  CallOptions,
  LlmTool,
  McpTool,
  RagResult,
  Result,
  Subprompt,
  ToolCallRecord,
} from './types.js';

export interface IContextAssembler {
  assemble(
    action: Subprompt,
    retrieved: {
      facts: RagResult[];
      feedback: RagResult[];
      state: RagResult[];
      tools: McpTool[];
    },
    toolResults: ToolCallRecord[],
    options?: CallOptions,
  ): Promise<Result<Message[], AssemblerError>>;

  /**
   * Augment an existing client message history with RAG context and merged tools.
   *
   * Used by the smart pipeline to preserve the client's conversation history
   * while appending agent-retrieved context to the system message and merging tools.
   */
  augment(
    clientMessages: Message[],
    ragContext: {
      facts: RagResult[];
      feedback: RagResult[];
      state: RagResult[];
    },
    additionalTools: LlmTool[],
    clientTools: LlmTool[],
  ): Promise<Result<{ messages: Message[]; tools: LlmTool[] }, AssemblerError>>;
}
