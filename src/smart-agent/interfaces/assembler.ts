import type { Message } from '../../types.js';
import type {
  AssemblerError,
  CallOptions,
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
}
