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
  type ToolCallRecord,
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
}

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

/** McpToolResult content → string (JSON.stringify if object) */
function toolResultContent(result: McpToolResult): string {
  if (typeof result.content === 'string') {
    return result.content;
  }
  return JSON.stringify(result.content);
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
 *
 * Drop priority (lowest first):
 *   1st — tools (last entry first, no score)
 *   2nd — state (lowest score first)
 *   3rd — feedback (lowest score first)
 *   4th — facts (lowest score first)
 * action is never dropped.
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
  // Work on mutable copies (already sorted by caller)
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
    // Drop tools last entry first
    if (mutableTools.length > 0) {
      mutableTools = mutableTools.slice(0, -1);
      continue;
    }
    // Drop state lowest score first (already sorted desc, so last = lowest)
    if (mutableState.length > 0) {
      mutableState = mutableState.slice(0, -1);
      continue;
    }
    // Drop feedback lowest score first
    if (mutableFeedback.length > 0) {
      mutableFeedback = mutableFeedback.slice(0, -1);
      continue;
    }
    // Drop facts lowest score first
    if (mutableFacts.length > 0) {
      mutableFacts = mutableFacts.slice(0, -1);
      continue;
    }
    // Nothing left to drop
    break;
  }

  return {
    facts: mutableFacts,
    feedback: mutableFeedback,
    state: mutableState,
    tools: mutableTools,
  };
}

// ---------------------------------------------------------------------------
// ContextAssembler
// ---------------------------------------------------------------------------

export class ContextAssembler implements IContextAssembler {
  private readonly maxTokens: number | undefined;
  private readonly systemPromptPreamble: string | undefined;
  private readonly includeProvenance: boolean;

  constructor(config?: ContextAssemblerConfig) {
    this.maxTokens = config?.maxTokens;
    this.systemPromptPreamble = config?.systemPromptPreamble;
    this.includeProvenance = config?.includeProvenance ?? false;
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
      // 1. Check abort signal
      if (options?.signal?.aborted) {
        return { ok: false, error: new AssemblerError('Aborted', 'ABORTED') };
      }

      // 2. Sort facts, feedback, state by score descending (stable copy, no mutation)
      const sortedFacts = [...retrieved.facts].sort(
        (a, b) => b.score - a.score,
      );
      const sortedFeedback = [...retrieved.feedback].sort(
        (a, b) => b.score - a.score,
      );
      const sortedState = [...retrieved.state].sort(
        (a, b) => b.score - a.score,
      );
      let tools = [...retrieved.tools];

      let facts = sortedFacts;
      let feedback = sortedFeedback;
      let state = sortedState;

      // 3. Apply token budget if configured
      if (this.maxTokens !== undefined) {
        const actionTokens = estimateTokens(action.text);
        const budgeted = applyTokenBudget(
          facts,
          feedback,
          state,
          tools,
          actionTokens,
          this.maxTokens,
          this.includeProvenance,
        );
        facts = budgeted.facts;
        feedback = budgeted.feedback;
        state = budgeted.state;
        tools = budgeted.tools;
      }

      // 4. Build system content
      const systemContent = buildSystemContent(
        facts,
        feedback,
        state,
        tools,
        this.includeProvenance,
      );

      // 5. Assemble messages
      const messages: Message[] = [];

      // a. System message (only if preamble or content is non-empty)
      const preamble = this.systemPromptPreamble ?? '';
      if (preamble || systemContent) {
        const parts = [preamble, systemContent].filter(Boolean);
        messages.push({ role: 'system', content: parts.join('\n\n') });
      }

      // b. History or Action
      if (history.length > 0) {
        // Filter out existing system messages if we want our RAG-system message to be primary
        // or just append. Standard OpenAI practice is one system message at the top.
        const historyWithoutSystem = history.filter(m => m.role !== 'system');
        messages.push(...historyWithoutSystem);
      } else {
        messages.push({ role: 'user', content: action.text });
      }

      // 6. Return success
      return { ok: true, value: messages };
    } catch (err) {
      return {
        ok: false,
        error: new AssemblerError(String(err), 'ASSEMBLER_ERROR'),
      };
    }
  }
}
