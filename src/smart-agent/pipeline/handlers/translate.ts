/**
 * TranslateHandler — translates non-ASCII RAG query text to English.
 *
 * Reads: `ctx.ragText`, `ctx.helperLlm` (or `ctx.mainLlm` as fallback)
 * Writes: `ctx.ragText`
 *
 * Skips translation when:
 * - `ragTranslationEnabled` is false
 * - Text is ASCII-only
 * - Text is shorter than 15 characters
 */

import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class TranslateHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    // ragTranslationEnabled removed from SmartAgentConfig in Task 4 — always translate

    ctx.isAscii = /^[\p{ASCII}]+$/u.test(ctx.ragText);

    if (ctx.isAscii || ctx.ragText.length < 15) {
      span.setAttribute('skipped', true);
      span.setAttribute('reason', ctx.isAscii ? 'ascii' : 'too_short');
      return true;
    }

    const prompt =
      ctx.config.ragTranslatePrompt ??
      'Translate the user request to English for search purposes. Preserve technical terms if present. Reply with only the expanded English terms, no explanation.';

    const llm = ctx.helperLlm || ctx.mainLlm;
    const chatStart = Date.now();
    const res = await llm.chat(
      [
        { role: 'system' as const, content: prompt },
        { role: 'user' as const, content: ctx.ragText },
      ],
      [],
      ctx.options,
    );
    ctx.requestLogger.logLlmCall({
      component: 'translate',
      model: llm.model ?? 'unknown',
      promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
      completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
      totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
      durationMs: Date.now() - chatStart,
    });

    if (res.ok && res.value.content.trim()) {
      ctx.ragText = res.value.content.trim();
      span.setAttribute('translated', true);
    }

    return true;
  }
}
