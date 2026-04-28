const DEFAULT_PROMPT =
  'Summarize in one sentence: what the user requested and what was done. Include key identifiers (class names, table names, etc). Do not include greetings or filler.';
export class HistorySummarizer {
  llm;
  prompt;
  constructor(llm, opts) {
    this.llm = llm;
    this.prompt = opts?.prompt ?? DEFAULT_PROMPT;
  }
  async summarize(turn, options) {
    const toolSection =
      turn.toolCalls.length > 0
        ? `\nTools called: ${turn.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ')}` +
          `\nTool results: ${turn.toolResults.map((tr) => `${tr.tool}: ${tr.content.slice(0, 200)}`).join('; ')}`
        : '';
    const messages = [
      { role: 'system', content: this.prompt },
      {
        role: 'user',
        content: `User request: ${turn.userText}\nAssistant response: ${turn.assistantText}${toolSection}`,
      },
    ];
    const result = await this.llm.chat(messages, undefined, options);
    if (!result.ok) return result;
    return { ok: true, value: result.value.content.trim() };
  }
}
//# sourceMappingURL=history-summarizer.js.map
