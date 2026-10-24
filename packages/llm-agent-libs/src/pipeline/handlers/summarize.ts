/**
 * SummarizeHandler — condenses conversation history using helper LLM.
 *
 * Reads: `ctx.history`, `ctx.helperLlm`
 * Writes: `ctx.history` (replaces with summarized version)
 *
 * Keeps at least the last 5 messages, preserving whole tool exchanges,
 * and summarizes the rest into a
 * single system message. Skips silently if no helper LLM is available
 * or history is too short.
 */

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

    // Keep the entire tool exchange when the recent-message boundary lands
    // among its results. Both the helper request and retained history stay valid.
    let boundary = Math.max(0, ctx.history.length - 5);
    while (boundary > 0 && ctx.history[boundary]?.role === 'tool') {
      boundary--;
    }
    const toSummarize = ctx.history.slice(0, boundary);
    const recent = ctx.history.slice(boundary);
    if (toSummarize.length === 0) return true;

    const prompt =
      ctx.config.historySummaryPrompt ??
      'Summarize the conversation so far in 2-3 sentences. Focus on the user goals and the current status of the task. Keep technical SAP terms as is.';

    const chatStart = Date.now();
    const res = await ctx.helperLlm.chat(
      [...toSummarize, { role: 'system' as const, content: prompt }],
      [],
      ctx.options,
    );
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

    if (!res.ok) {
      // Non-fatal — keep original history
      span.setAttribute('fallback', true);
      return true;
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
