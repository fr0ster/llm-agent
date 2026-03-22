import type { Message } from '../../types.js';
import type { IContextAssembler } from '../interfaces/assembler.js';
import {
  AssemblerError,
  type CallOptions,
  type McpTool,
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
  /**
   * Display name mapping for RAG store keys → section headers.
   * Default: `{ facts: 'Known Facts', feedback: 'Feedback', state: 'Current State' }`.
   * Unknown keys are title-cased automatically.
   */
  sectionHeaders?: Record<string, string>;
}

export const DEFAULT_REASONING_INSTRUCTION = `IMPORTANT: Always start your response with a brief <reasoning> block.
Explain:
1. Which tools you selected and why.
2. How you interpreted the retrieved context.
3. Your step-by-step strategy for the current turn.
The reasoning block must be visible to the user and placed at the very beginning.`;

const DEFAULT_SECTION_HEADERS: Record<string, string> = {
  facts: 'Known Facts',
  feedback: 'Feedback',
  state: 'Current State',
};

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

/** Derive a display header from a store key (e.g. 'my_store' → 'My Store') */
function titleCase(key: string): string {
  return key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Combine all sections into system message content */
function buildSystemContent(
  ragResults: Record<string, RagResult[]>,
  tools: McpTool[],
  provenance: boolean,
  sectionHeaders: Record<string, string>,
): string {
  const sections: string[] = [];

  for (const [key, results] of Object.entries(ragResults)) {
    const header = sectionHeaders[key] ?? titleCase(key);
    const section = buildSection(
      header,
      results.map((r) => formatRagEntry(r, provenance)),
    );
    if (section) sections.push(section);
  }

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
 * Trims stores in reverse insertion order, then tools last.
 */
function applyTokenBudget(
  ragResults: Record<string, RagResult[]>,
  tools: McpTool[],
  actionTokens: number,
  maxTokens: number,
  provenance: boolean,
  sectionHeaders: Record<string, string>,
): {
  ragResults: Record<string, RagResult[]>;
  tools: McpTool[];
} {
  const mutableResults: Record<string, RagResult[]> = {};
  for (const [key, arr] of Object.entries(ragResults)) {
    mutableResults[key] = [...arr];
  }
  let mutableTools = [...tools];

  const storeKeys = Object.keys(mutableResults);

  const totalTokens = (): number => {
    const content = buildSystemContent(
      mutableResults,
      mutableTools,
      provenance,
      sectionHeaders,
    );
    return actionTokens + estimateTokens(content);
  };

  while (totalTokens() > maxTokens) {
    // First trim tools
    if (mutableTools.length > 0) {
      mutableTools = mutableTools.slice(0, -1);
      continue;
    }
    // Then trim stores in reverse order
    let trimmed = false;
    for (let i = storeKeys.length - 1; i >= 0; i--) {
      const key = storeKeys[i];
      if (mutableResults[key].length > 0) {
        mutableResults[key] = mutableResults[key].slice(0, -1);
        trimmed = true;
        break;
      }
    }
    if (!trimmed) break;
  }

  return { ragResults: mutableResults, tools: mutableTools };
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
  private readonly sectionHeaders: Record<string, string>;

  constructor(config?: ContextAssemblerConfig) {
    this.maxTokens = config?.maxTokens;
    this.systemPromptPreamble = config?.systemPromptPreamble;
    this.includeProvenance = config?.includeProvenance ?? false;
    this.showReasoning = config?.showReasoning ?? false;
    this.reasoningInstruction = config?.reasoningInstruction;
    this.sectionHeaders = {
      ...DEFAULT_SECTION_HEADERS,
      ...config?.sectionHeaders,
    };
  }

  async assemble(
    action: Subprompt,
    retrieved: {
      ragResults: Record<string, RagResult[]>;
      tools: McpTool[];
    },
    history: Message[],
    options?: CallOptions,
  ): Promise<Result<Message[], AssemblerError>> {
    try {
      if (options?.signal?.aborted) {
        return { ok: false, error: new AssemblerError('Aborted', 'ABORTED') };
      }

      // Sort all RAG results by score descending
      const sortedResults: Record<string, RagResult[]> = {};
      for (const [key, results] of Object.entries(retrieved.ragResults)) {
        sortedResults[key] = [...results].sort((a, b) => b.score - a.score);
      }
      const tools = [...retrieved.tools];

      let finalResults = sortedResults;
      let finalTools = tools;

      if (this.maxTokens !== undefined) {
        const budgeted = applyTokenBudget(
          sortedResults,
          tools,
          estimateTokens(action.text),
          this.maxTokens,
          this.includeProvenance,
          this.sectionHeaders,
        );
        finalResults = budgeted.ragResults;
        finalTools = budgeted.tools;
      }

      const systemContent = buildSystemContent(
        finalResults,
        finalTools,
        this.includeProvenance,
        this.sectionHeaders,
      );
      const messages: Message[] = [];

      const preamble = this.systemPromptPreamble ?? '';
      if (preamble || systemContent || this.showReasoning) {
        const parts = [
          preamble,
          this.showReasoning
            ? this.reasoningInstruction || DEFAULT_REASONING_INSTRUCTION
            : '',
          systemContent,
        ].filter(Boolean);
        messages.push({ role: 'system', content: parts.join('\n\n') });
      }

      if (history.length > 0) {
        messages.push(...history.filter((m) => m.role !== 'system'));
      } else {
        messages.push({ role: 'user', content: action.text });
      }

      return { ok: true, value: messages };
    } catch (err) {
      return {
        ok: false,
        error: new AssemblerError(String(err), 'ASSEMBLER_ERROR'),
      };
    }
  }
}
