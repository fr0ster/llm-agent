import type { Message } from '../types.js';
import type {
  AssemblerError,
  CallOptions,
  McpTool,
  RagResult,
  Result,
  Subprompt,
  ToolCallRecord,
} from './types.js';
export type HistoryEntry = Message | ToolCallRecord;
export interface IContextAssembler {
  assemble(
    action: Subprompt,
    retrieved: {
      ragResults: Record<string, RagResult[]>;
      tools: McpTool[];
      recentActions?: string[];
    },
    history: HistoryEntry[],
    options?: CallOptions,
  ): Promise<Result<Message[], AssemblerError>>;
}
//# sourceMappingURL=assembler.d.ts.map
