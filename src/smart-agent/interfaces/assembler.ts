import type { Message } from '../../types.js';
import type {
  AssemblerError,
  CallOptions,
  McpTool,
  RagResult,
  Result,
  Subprompt,
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
    history: Message[],
    options?: CallOptions,
  ): Promise<Result<Message[], AssemblerError>>;
}
