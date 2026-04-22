import type {
  CallOptions,
  HistoryTurn,
  IHistorySummarizer,
  ILlm,
  LlmError,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';

const DEFAULT_PROMPT =
  'Summarize in one sentence: what the user requested and what was done. Include key identifiers (class names, table names, etc). Do not include greetings or filler.';

export class HistorySummarizer implements IHistorySummarizer {
  private readonly prompt: string;

  constructor(
    private readonly llm: ILlm,
    opts?: { prompt?: string },
  ) {
    this.prompt = opts?.prompt ?? DEFAULT_PROMPT;
  }

  async summarize(
    turn: HistoryTurn,
    options?: CallOptions,
  ): Promise<Result<string, LlmError>> {
    const toolSection =
      turn.toolCalls.length > 0
        ? `\nTools called: ${turn.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ')}` +
          `\nTool results: ${turn.toolResults.map((tr) => `${tr.tool}: ${tr.content.slice(0, 200)}`).join('; ')}`
        : '';

    const messages: Message[] = [
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
