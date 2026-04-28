import { AssemblerError } from '@mcp-abap-adt/llm-agent';
export const DEFAULT_REASONING_INSTRUCTION = `IMPORTANT: Always start your response with a brief <reasoning> block.
Explain:
1. Which tools you selected and why.
2. How you interpreted the retrieved context.
3. Your step-by-step strategy for the current turn.
The reasoning block must be visible to the user and placed at the very beginning.`;
const DEFAULT_SECTION_HEADERS = {
  facts: 'Known Facts',
  feedback: 'Feedback',
  state: 'Current State',
  history: 'Relevant History',
};
// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------
/** Type guard: ToolCallRecord has `call` and `result`, Message has `role`. */
function isToolCallRecord(item) {
  return (
    typeof item === 'object' &&
    item !== null &&
    'call' in item &&
    'result' in item
  );
}
/** Approximate token count: ceil(text.length / 4) */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
/** Single RagResult → "- <text> [score: 0.92]" (provenance) or "- <text>" */
function formatRagEntry(r, provenance) {
  if (provenance) {
    return `- ${r.text} [score: ${r.score.toFixed(2)}]`;
  }
  return `- ${r.text}`;
}
/** Header + entries → "## Header\n- e1\n- e2" or '' if entries empty */
function buildSection(header, entries) {
  if (entries.length === 0) return '';
  return `## ${header}\n${entries.join('\n')}`;
}
/** Derive a display header from a store key (e.g. 'my_store' → 'My Store') */
function titleCase(key) {
  return key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
/** Combine all sections into system message content */
function buildSystemContent(
  ragResults,
  provenance,
  sectionHeaders,
  recentActions,
) {
  const sections = [];
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
  ragResults,
  actionTokens,
  maxTokens,
  provenance,
  sectionHeaders,
  recentActions,
) {
  const mutableResults = {};
  for (const [key, arr] of Object.entries(ragResults)) {
    mutableResults[key] = [...arr];
  }
  const storeKeys = Object.keys(mutableResults);
  const totalTokens = () => {
    const content = buildSystemContent(
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
export class ContextAssembler {
  maxTokens;
  systemPromptPreamble;
  includeProvenance;
  showReasoning;
  reasoningInstruction;
  sectionHeaders;
  historyRecencyWindow;
  constructor(config) {
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
  async assemble(action, retrieved, history, options) {
    try {
      if (options?.signal?.aborted) {
        return { ok: false, error: new AssemblerError('Aborted', 'ABORTED') };
      }
      // Sort all RAG results by score descending
      const sortedResults = {};
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
      const systemContent = buildSystemContent(
        finalResults,
        this.includeProvenance,
        this.sectionHeaders,
        retrieved.recentActions,
      );
      const messages = [];
      const preamble = this.systemPromptPreamble ?? '';
      const toolGuidance =
        'Use available tools when they can accomplish the task. When an action is impossible with available tools — say so clearly and do not attempt it.';
      if (preamble || systemContent || this.showReasoning) {
        const parts = [
          preamble,
          toolGuidance,
          this.showReasoning
            ? this.reasoningInstruction || DEFAULT_REASONING_INSTRUCTION
            : '',
          systemContent,
        ].filter(Boolean);
        messages.push({ role: 'system', content: parts.join('\n\n') });
      }
      // Separate regular messages from tool call records
      const regularMessages = [];
      const toolMessages = [];
      for (const item of history) {
        if (isToolCallRecord(item)) {
          const raw = item.result.content;
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
          toolMessages.push({
            role: 'tool',
            content: `${item.call.name}: ${text}`,
          });
        } else if (item.role !== 'system') {
          regularMessages.push(item);
        }
      }
      // Apply recency window — keep only the last N messages from client history.
      // Older messages are excluded; they are available via RAG stores if needed.
      const windowedMessages =
        this.historyRecencyWindow !== undefined &&
        regularMessages.length > this.historyRecencyWindow
          ? regularMessages.slice(-this.historyRecencyWindow)
          : regularMessages;
      if (windowedMessages.length > 0) {
        messages.push(...windowedMessages);
      } else {
        messages.push({ role: 'user', content: action.text });
      }
      messages.push(...toolMessages);
      return { ok: true, value: messages };
    } catch (err) {
      return {
        ok: false,
        error: new AssemblerError(String(err), 'ASSEMBLER_ERROR'),
      };
    }
  }
}
//# sourceMappingURL=context-assembler.js.map
