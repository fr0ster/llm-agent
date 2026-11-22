import type {
  CallOptions,
  ILlm,
  IRequestLogger,
  Message,
  OrchestratorError,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { terminalRunError } from '@mcp-abap-adt/llm-agent';

/**
 * Translate a RAG query to English for search purposes. Skips ASCII-only and
 * very short inputs. Module-scope so it can be injected as a strategy override.
 */
export async function toEnglishForRag(
  deps: {
    helperLlm: ILlm | undefined;
    mainLlm: ILlm;
    ragTranslatePrompt?: string;
  },
  text: string,
  opts: CallOptions | undefined,
): Promise<string> {
  if (/^[\p{ASCII}]+$/u.test(text) || text.length < 15) return text;
  const dp =
    'Translate the user request to English for search purposes. Preserve technical terms if present. Reply with only the expanded English terms, no explanation.';
  const llm = deps.helperLlm || deps.mainLlm;
  const res = await llm.chat(
    [
      {
        role: 'system' as const,
        content: deps.ragTranslatePrompt || dp,
      },
      { role: 'user' as const, content: text },
    ],
    [],
    { ...opts, usage: opts?.usage?.with({ role: 'translate' }) },
  );
  if (!res.ok) {
    const terminal = terminalRunError(res.error);
    if (terminal) throw terminal;
  }
  return res.ok && res.value.content.trim() ? res.value.content.trim() : text;
}

/** @deprecated history is no longer summarized; full history is kept */
export async function summarizeHistory(
  _deps: {
    helperLlm: ILlm | undefined;
    requestLogger: IRequestLogger;
    /** @deprecated history is no longer summarized; full history is kept */
    historySummaryPrompt?: string;
  },
  history: Message[],
  _opts?: CallOptions,
): Promise<Result<Message[], OrchestratorError>> {
  return { ok: true, value: history };
}
