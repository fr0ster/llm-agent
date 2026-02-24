import type { Message } from '../../types.js';
import type { IContextAssembler } from '../interfaces/assembler.js';
import {
  AssemblerError,
  type CallOptions,
  type McpTool,
  type McpToolResult,
  type RagResult,
  type Result,
  type Subprompt,
} from '../interfaces/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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
}

export const DEFAULT_REASONING_INSTRUCTION = `IMPORTANT: Always start your response with a brief <reasoning> block.
Explain: 
1. Which tools you selected and why.
2. How you interpreted the retrieved context.
3. Your step-by-step strategy for the current turn.
The reasoning block must be visible to the user and placed at the very beginning.`;

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** Approximate token count: ceil(text.length / 4) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Single RagResult → "- <text> [score: 0.92]" (provenance) or "- <text>" */
function formatRagEntry(r: RagResult, provenance: boolean): string {
  if (provenance) {
    return `- ${r.text} [score: ${r.score.toFixed(2)}]`;
  }
  return `- ${r.text}`;
}

/** Header + entries → "## Header\n- e1\n- e2" or '' if entries empty */
function buildSection(header: string, entries: string[]): string {
  if (entries.length === 0) return '';
  return `## ${header}\n${entries.join('\n')}`;
}

/** Combine all sections into system message content */
function buildSystemContent(
  facts: RagResult[],
  feedback: RagResult[],
  state: RagResult[],
  tools: McpTool[],
  provenance: boolean,
): string {
  const sections: string[] = [];

  const factsSection = buildSection(
    'Known Facts',
    facts.map((r) => formatRagEntry(r, provenance)),
  );
  if (factsSection) sections.push(factsSection);

  const feedbackSection = buildSection(
    'Feedback',
    feedback.map((r) => formatRagEntry(r, provenance)),
  );
  if (feedbackSection) sections.push(feedbackSection);

  const stateSection = buildSection(
    'Current State',
    state.map((r) => formatRagEntry(r, provenance)),
  );
  if (stateSection) sections.push(stateSection);

  const toolsSection = buildSection(
    'Available Tools',
    tools.map((t) => `- ${t.name}: ${t.description}`),
  );
  if (toolsSection) sections.push(toolsSection);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Token budgeting
// ---------------------------------------------------------------------------

/**
 * Drop entries until total token count fits within budget.
 */
function applyTokenBudget(
  facts: RagResult[],
  feedback: RagResult[],
  state: RagResult[],
  tools: McpTool[],
  actionTokens: number,
  maxTokens: number,
  provenance: boolean,
): {
  facts: RagResult[];
  feedback: RagResult[];
  state: RagResult[];
  tools: McpTool[];
} {
  let mutableFacts = [...facts];
  let mutableFeedback = [...feedback];
  let mutableState = [...state];
  let mutableTools = [...tools];

  const totalTokens = (): number => {
    const content = buildSystemContent(
      mutableFacts,
      mutableFeedback,
      mutableState,
      mutableTools,
      provenance,
    );
    return actionTokens + estimateTokens(content);
  };

  while (totalTokens() > maxTokens) {
    if (mutableTools.length > 0) { mutableTools = mutableTools.slice(0, -1); continue; }
    if (mutableState.length > 0) { mutableState = mutableState.slice(0, -1); continue; }
    if (mutableFeedback.length > 0) { mutableFeedback = mutableFeedback.slice(0, -1); continue; }
    if (mutableFacts.length > 0) { mutableFacts = mutableFacts.slice(0, -1); continue; }
    break;
  }

  return { facts: mutableFacts, feedback: mutableFeedback, state: mutableState, tools: mutableTools };
}

// ---------------------------------------------------------------------------
// ContextAssembler
// ---------------------------------------------------------------------------

export class ContextAssembler implements IContextAssembler {
  private readonly maxTokens: number | undefined;
  private readonly systemPromptPreamble: string | undefined;
  private readonly includeProvenance: boolean;
  private readonly showReasoning: boolean;
  private readonly reasoningInstruction: string | undefined;

  constructor(config?: ContextAssemblerConfig) {
    this.maxTokens = config?.maxTokens;
    this.systemPromptPreamble = config?.systemPromptPreamble;
    this.includeProvenance = config?.includeProvenance ?? false;
    this.showReasoning = config?.showReasoning ?? false;
    this.reasoningInstruction = config?.reasoningInstruction;
  }

  async assemble(
    action: Subprompt,
    retrieved: {
      facts: RagResult[];
      feedback: RagResult[];
      state: RagResult[];
      tools: McpTool[];
    },
    history: Message[],
    options?: CallOptions,
  ): Promise<Result<Message[], AssemblerError>> {
    try {
      if (options?.signal?.aborted) {
        return { ok: false, error: new AssemblerError('Aborted', 'ABORTED') };
      }

      const sortedFacts = [...retrieved.facts].sort((a, b) => b.score - a.score);
      const sortedFeedback = [...retrieved.feedback].sort((a, b) => b.score - a.score);
      const sortedState = [...retrieved.state].sort((a, b) => b.score - a.score);
      const tools = [...retrieved.tools];

      let finalFacts = sortedFacts;
      let finalFeedback = sortedFeedback;
      let finalState = sortedState;
      let finalTools = tools;

      if (this.maxTokens !== undefined) {
        const budgeted = applyTokenBudget(sortedFacts, sortedFeedback, sortedState, tools, estimateTokens(action.text), this.maxTokens, this.includeProvenance);
        finalFacts = budgeted.facts;
        finalFeedback = budgeted.feedback;
        finalState = budgeted.state;
        finalTools = budgeted.tools;
      }

      const systemContent = buildSystemContent(finalFacts, finalFeedback, finalState, finalTools, this.includeProvenance);
      const messages: Message[] = [];

      const preamble = this.systemPromptPreamble ?? '';
      if (preamble || systemContent || this.showReasoning) {
        const parts = [
          preamble,
          this.showReasoning ? (this.reasoningInstruction || DEFAULT_REASONING_INSTRUCTION) : '',
          systemContent
        ].filter(Boolean);
        messages.push({ role: 'system', content: parts.join('\n\n') });
      }

      if (history.length > 0) {
        messages.push(...history.filter(m => m.role !== 'system'));
      } else {
        messages.push({ role: 'user', content: action.text });
      }

      return { ok: true, value: messages };
    } catch (err) {
      return { ok: false, error: new AssemblerError(String(err), 'ASSEMBLER_ERROR') };
    }
  }
}
