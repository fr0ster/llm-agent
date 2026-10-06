/**
 * SummarizeHandler — condenses conversation history using helper LLM.
 *
 * Reads: `ctx.history`, `ctx.helperLlm`
 * Writes: `ctx.history` (replaces with summarized version)
 *
 * Keeps the last 5 messages verbatim and summarizes the rest into a
 * single system message. Skips (no helper LLM configured, or history too
 * short) are capability / size decisions; a failed summarizer call fails the
 * stage.
 */

import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
import { rejectionError } from '../../agent/rag-helpers.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class SummarizeHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    if (!ctx.helperLlm) {
      span.setAttribute('skipped', true);
      span.setAttribute('reason', 'no_helper_llm');
      return true;
    }

    const limit =
      (config.limit as number) ?? ctx.config.historyAutoSummarizeLimit ?? 10;

    if (ctx.history.length <= limit) {
      span.setAttribute('skipped', true);
      span.setAttribute('reason', 'history_under_limit');
      return true;
    }

    const toSummarize = ctx.history.slice(0, -5);
    const recent = ctx.history.slice(-5);
    if (toSummarize.length === 0) return true;

    const prompt =
      ctx.config.historySummaryPrompt ??
      'Summarize the conversation so far in 2-3 sentences. Focus on the user goals and the current status of the task. Keep technical SAP terms as is.';

    const chatStart = Date.now();
    const helperLlm = ctx.helperLlm;
    let res: Awaited<ReturnType<typeof helperLlm.chat>>;
    try {
      res = await helperLlm.chat(
        [...toSummarize, { role: 'system' as const, content: prompt }],
        [],
        ctx.options,
      );
    } catch (err) {
      span.setStatus('error', String(err));
      ctx.error = rejectionError('summarize', err, 'LLM_ERROR');
      return false;
    }
    ctx.requestLogger.logLlmCall({
      // Stamp requestId so this helper-LLM call is attributed to the active
      // request's per-traceId delta — without it, history-summarization tokens
      // only show up in the session-cumulative aggregate and are missing from
      // `response.usage` (which is computed from the delta).
      requestId: ctx.options?.trace?.traceId,
      component: 'helper',
      model: ctx.helperLlm.model ?? 'unknown',
      promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
      completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
      totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
      durationMs: Date.now() - chatStart,
    });

    // Spec §10.5.6 L3: a failed summarizer is the stage's error — the full
    // history is not a summary.
    if (!res.ok) {
      span.setStatus('error', res.error.message);
      ctx.error = new OrchestratorError(
        `summarize: ${res.error.message}`,
        res.error.code,
      );
      return false;
    }

    ctx.history = [
      {
        role: 'system' as const,
        content: `Summary of previous conversation: ${res.value.content}`,
      },
      ...recent,
    ];

    span.setAttribute('summarized_count', toSummarize.length);
    return true;
  }
}
