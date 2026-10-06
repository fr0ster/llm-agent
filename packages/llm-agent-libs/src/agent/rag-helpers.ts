import type {
  CallOptions,
  ILlm,
  IRequestLogger,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  OrchestratorError,
  RagError,
  SmartAgentError,
} from '@mcp-abap-adt/llm-agent';

/**
 * A store query that REJECTED is that store's failure, like an `ok: false`
 * (spec §10.5.4 R5/R6, §10.5.8 S-1/S-2): any SmartAgentError keeps its code
 * (a RagError, an open breaker, …); anything else is QUERY_ERROR.
 */
export function storeRejection(err: unknown): SmartAgentError {
  return err instanceof SmartAgentError
    ? err
    : new RagError(String(err), 'QUERY_ERROR');
}

/**
 * A helper call that REJECTED (the `Result` contract says it should not, but
 * a provider can) is the same failure as an `ok: false`: it keeps the typed
 * error's code and names the stage.
 */
export function rejectionError(
  stage: string,
  err: unknown,
  fallbackCode: string,
): OrchestratorError {
  if (err instanceof SmartAgentError) {
    return new OrchestratorError(`${stage}: ${err.message}`, err.code);
  }
  return new OrchestratorError(`${stage}: ${String(err)}`, fallbackCode);
}

/**
 * Translate a RAG query to English for search purposes. Skips ASCII-only and
 * very short inputs. Module-scope so it can be injected as a strategy override.
 * A failed LLM call (or an empty answer) is an error — never the untranslated
 * text standing in for a translation (spec §10.5.6 L1).
 */
export async function toEnglishForRag(
  deps: {
    helperLlm: ILlm | undefined;
    mainLlm: ILlm;
    ragTranslatePrompt?: string;
  },
  text: string,
  opts: CallOptions | undefined,
): Promise<Result<string, OrchestratorError>> {
  if (/^[\p{ASCII}]+$/u.test(text) || text.length < 15) {
    return { ok: true, value: text };
  }
  const dp =
    'Translate the user request to English for search purposes. Preserve technical terms if present. Reply with only the expanded English terms, no explanation.';
  const llm = deps.helperLlm || deps.mainLlm;
  let res: Awaited<ReturnType<ILlm['chat']>>;
  try {
    res = await llm.chat(
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
  } catch (err) {
    return { ok: false, error: rejectionError('translate', err, 'LLM_ERROR') };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: new OrchestratorError(
        `translate: ${res.error.message}`,
        res.error.code,
      ),
    };
  }
  const translated = res.value.content.trim();
  if (!translated) {
    return {
      ok: false,
      error: new OrchestratorError('translate: empty answer', 'LLM_ERROR'),
    };
  }
  return { ok: true, value: translated };
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
  let res: Awaited<ReturnType<ILlm['chat']>>;
  try {
    res = await deps.helperLlm.chat(
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
  } catch (err) {
    return { ok: false, error: rejectionError('summarize', err, 'LLM_ERROR') };
  }
  deps.requestLogger.logLlmCall({
    component: 'helper',
    model: deps.helperLlm.model ?? 'unknown',
    promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
    completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
    totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
    durationMs: Date.now() - summarizeStart,
    requestId: opts?.trace?.traceId,
  });
  // Spec §10.5.6 L3: a failed summarizer is an error — the full history is
  // not a summary.
  if (!res.ok) {
    return {
      ok: false,
      error: new OrchestratorError(
        `summarize: ${res.error.message}`,
        res.error.code,
      ),
    };
  }
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
