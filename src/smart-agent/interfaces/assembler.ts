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
      ragResults: Record<string, RagResult[]>;
      tools: McpTool[];
    },
    history: Message[],
    options?: CallOptions,
  ): Promise<Result<Message[], AssemblerError>>;
}
