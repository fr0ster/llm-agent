import type {
  HistoryEntry,
  IContextAssembler,
  Message,
} from '@mcp-abap-adt/llm-agent';
import {
  AssemblerError,
  type CallOptions,
  type McpTool,
  type RagResult,
  type Result,
  type Subprompt,
} from '@mcp-abap-adt/llm-agent';
export interface ContextAssemblerConfig {
  /** chars/4 token budget. No limit when undefined. */
  maxTokens?: number;
  /** Preamble prepended before context sections in system message. */
  systemPromptPreamble?: string;
  /** Emit RAG scores as annotations for observability. Default: false. */
  includeProvenance?: boolean;
  /**
   * When true, instructions are added to the system prompt asking the LLM
   * to explain its reasoning.
   */
  showReasoning?: boolean;
  /**
   * Optional custom reasoning instruction.
   */
  reasoningInstruction?: string;
  /**
   * Display name mapping for RAG store keys → section headers.
   * Default: `{ facts: 'Known Facts', feedback: 'Feedback', state: 'Current State' }`.
   * Unknown keys are title-cased automatically.
   */
  sectionHeaders?: Record<string, string>;
  /**
   * Maximum number of recent messages to include from client history.
   * Only the last N non-system messages are passed to the LLM.
   * Older messages are excluded — they are available via RAG if needed.
   * When undefined, all messages are included (backward compatible).
   */
  historyRecencyWindow?: number;
}
export declare const DEFAULT_REASONING_INSTRUCTION =
  'IMPORTANT: Always start your response with a brief <reasoning> block.\nExplain:\n1. Which tools you selected and why.\n2. How you interpreted the retrieved context.\n3. Your step-by-step strategy for the current turn.\nThe reasoning block must be visible to the user and placed at the very beginning.';
export declare class ContextAssembler implements IContextAssembler {
  private readonly maxTokens;
  private readonly systemPromptPreamble;
  private readonly includeProvenance;
  private readonly showReasoning;
  private readonly reasoningInstruction;
  private readonly sectionHeaders;
  private readonly historyRecencyWindow;
  constructor(config?: ContextAssemblerConfig);
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
//# sourceMappingURL=context-assembler.d.ts.map
