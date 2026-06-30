import type {
  CallOptions,
  ILlm,
  IRequestLogger,
  Message,
  OrchestratorError,
  Result,
} from '@mcp-abap-adt/llm-agent';

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
    opts,
  );
  return res.ok && res.value.content.trim() ? res.value.content.trim() : text;
}

/**
 * Summarize older history turns via the helper LLM, keeping the last 5 turns.
 * Module-scope so it can be injected as a strategy override.
 */
export async function summarizeHistory(
  deps: {
    helperLlm: ILlm | undefined;
    requestLogger: IRequestLogger;
    historySummaryPrompt?: string;
  },
  h: Message[],
  opts?: CallOptions,
): Promise<Result<Message[], OrchestratorError>> {
  if (!deps.helperLlm) return { ok: true, value: h };
  const toS = h.slice(0, -5);
  const rec = h.slice(-5);
  if (toS.length === 0) return { ok: true, value: h };
  const dp =
    'Summarize the conversation so far in 2-3 sentences. Focus on the user goals and the current status of the task. Keep technical SAP terms as is.';
  const summarizeStart = Date.now();
  const res = await deps.helperLlm.chat(
    [
      ...toS,
      {
        role: 'system' as const,
        content: deps.historySummaryPrompt || dp,
      },
    ],
    [],
    opts,
  );
  deps.requestLogger.logLlmCall({
    component: 'helper',
    model: deps.helperLlm.model ?? 'unknown',
    promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
    completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
    totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
    durationMs: Date.now() - summarizeStart,
    requestId: opts?.trace?.traceId,
  });
  if (!res.ok) return { ok: true, value: h };
  return {
    ok: true,
    value: [
      {
        role: 'system' as const,
        content: `Summary of previous conversation: ${res.value.content}`,
      },
      ...rec,
    ],
  };
}
