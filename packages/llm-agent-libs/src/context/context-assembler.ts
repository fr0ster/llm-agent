import type {
  HistoryEntry,
  IContextAssembler,
  Message,
} from '@mcp-abap-adt/llm-agent';
import {
  AssemblerError,
  type CallOptions,
  formatTrustTag,
  type McpTool,
  type RagResult,
  type Result,
  type Subprompt,
  type ToolCallRecord,
  type ToolTrust,
  toModelToolMessage,
  toModelToolMessages,
} from '@mcp-abap-adt/llm-agent';

import { validateTimeZone, withRequestTime } from './request-time.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ContextAssemblerConfig {
  /** Resolve trust for model-facing tool history without changing stored records. */
  toolTrust?: ToolTrust;
  /** Deployment IANA time zone for request dates. Default: UTC. */
  timeZone?: string;
  /** chars/4 token budget. No limit when undefined. */
  maxTokens?: number;
  /** Host base and function prompt forming the static system prefix. */
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
  history: 'Relevant History',
};

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** Type guard: ToolCallRecord has `call` and `result`, Message has `role`. */
function isToolCallRecord(item: HistoryEntry): item is ToolCallRecord {
  return (
    typeof item === 'object' &&
    item !== null &&
    'call' in item &&
    'result' in item
  );
}

/** Approximate token count: ceil(text.length / 4) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Single RagResult → "- <text> [score: 0.92]" (provenance) or "- <text>" */
function formatRagEntry(r: RagResult, provenance: boolean): string {
  const tag =
    typeof r.metadata.trust === 'number'
      ? `${formatTrustTag(typeof r.metadata.source === 'string' ? r.metadata.source : undefined, r.metadata.trust)} `
      : '';
  if (provenance) {
    return `- ${tag}${r.text} [score: ${r.score.toFixed(2)}]`;
  }
  return `- ${tag}${r.text}`;
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

/** Combine retrieved sections into request content */
function buildRequestContent(
  ragResults: Record<string, RagResult[]>,
  provenance: boolean,
  sectionHeaders: Record<string, string>,
  recentActions?: string[],
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

  if (recentActions && recentActions.length > 0) {
    const section = buildSection(
      'Recent Actions',
      recentActions.map((a) => `- ${a}`),
    );
    if (section) sections.push(section);
  }

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
  actionTokens: number,
  maxTokens: number,
  provenance: boolean,
  sectionHeaders: Record<string, string>,
  recentActions?: string[],
): Record<string, RagResult[]> {
  const mutableResults: Record<string, RagResult[]> = {};
  for (const [key, arr] of Object.entries(ragResults)) {
    mutableResults[key] = [...arr];
  }

  const storeKeys = Object.keys(mutableResults);

  const totalTokens = (): number => {
    const content = buildRequestContent(
      mutableResults,
      provenance,
      sectionHeaders,
      recentActions,
    );
    return actionTokens + estimateTokens(content);
  };

  while (totalTokens() > maxTokens) {
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

  return mutableResults;
}

// ---------------------------------------------------------------------------
// ContextAssembler
// ---------------------------------------------------------------------------

export class ContextAssembler implements IContextAssembler {
  private readonly timeZone: string;
  private readonly maxTokens: number | undefined;
  private readonly systemPromptPreamble: string | undefined;
  private readonly includeProvenance: boolean;
  private readonly showReasoning: boolean;
  private readonly reasoningInstruction: string | undefined;
  private readonly sectionHeaders: Record<string, string>;
  private readonly historyRecencyWindow: number | undefined;
  private readonly toolTrust: ToolTrust | undefined;

  constructor(config?: ContextAssemblerConfig) {
    this.toolTrust = config?.toolTrust;
    this.timeZone = config?.timeZone ?? 'UTC';
    validateTimeZone(this.timeZone);
    this.maxTokens = config?.maxTokens;
    this.systemPromptPreamble = config?.systemPromptPreamble;
    this.includeProvenance = config?.includeProvenance ?? false;
    this.showReasoning = config?.showReasoning ?? false;
    this.reasoningInstruction = config?.reasoningInstruction;
    this.sectionHeaders = {
      ...DEFAULT_SECTION_HEADERS,
      ...config?.sectionHeaders,
    };
    this.historyRecencyWindow = config?.historyRecencyWindow;
  }

  async assemble(
    action: Subprompt,
    retrieved: {
      ragResults: Record<string, RagResult[]>;
      tools: McpTool[];
      recentActions?: string[];
    },
    history: HistoryEntry[],
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
      let finalResults = sortedResults;

      if (this.maxTokens !== undefined) {
        finalResults = applyTokenBudget(
          sortedResults,
          estimateTokens(action.text),
          this.maxTokens,
          this.includeProvenance,
          this.sectionHeaders,
          retrieved.recentActions,
        );
      }

      const requestContent = buildRequestContent(
        finalResults,
        this.includeProvenance,
        this.sectionHeaders,
        retrieved.recentActions,
      );
      const messages: Message[] = [];

      const preamble = this.systemPromptPreamble ?? '';
      const toolGuidance =
        'Use available tools when they can accomplish the task. When an action is impossible with available tools — say so clearly and do not attempt it.';
      const parts = [
        preamble,
        toolGuidance,
        this.showReasoning
          ? this.reasoningInstruction || DEFAULT_REASONING_INSTRUCTION
          : '',
      ].filter(Boolean);
      messages.push({ role: 'system', content: parts.join('\n\n') });

      // Separate regular messages from tool call records
      const regularMessages: Message[] = [];
      const toolMessages: Message[] = [];

      for (const item of history) {
        if (isToolCallRecord(item)) {
          const raw = item.result.content;
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
          toolMessages.push(
            toModelToolMessage(
              {
                role: 'tool',
                content: `${item.call.name}: ${text}`,
              },
              this.toolTrust,
              item.call.name,
            ),
          );
        } else if (item.role !== 'system') {
          regularMessages.push(item);
        }
      }

      // Apply recency window — keep only the last N messages from client history.
      // Older messages are excluded; they are available via RAG stores if needed.
      // Resolve tool names before their assistant declarations can be windowed out.
      const modelHistory = toModelToolMessages(regularMessages, this.toolTrust);
      const windowedMessages =
        this.historyRecencyWindow !== undefined &&
        modelHistory.length > this.historyRecencyWindow
          ? modelHistory.slice(-this.historyRecencyWindow)
          : modelHistory;

      if (windowedMessages.length > 0) {
        messages.push(...windowedMessages);
      } else {
        messages.push({ role: 'user', content: action.text });
      }
      if (requestContent) {
        let index = messages.length - 1;
        while (index >= 0 && messages[index].role !== 'user') index--;
        if (index >= 0)
          messages[index] = {
            ...messages[index],
            content: `${requestContent}\n\n${messages[index].content}`,
          };
        else messages.push({ role: 'user', content: requestContent });
      }
      messages.push(...toolMessages);

      return {
        ok: true,
        value: withRequestTime(
          messages,
          options?.requestStartedAt,
          this.timeZone,
          action.text,
        ),
      };
    } catch (err) {
      return {
        ok: false,
        error: new AssemblerError(String(err), 'ASSEMBLER_ERROR'),
      };
    }
  }
}
