/**
 * PresentHandler — stream final response via presentation LLM.
 *
 * When a `presentationLlm` is configured, this stage re-generates the
 * tool-loop's final response through a faster/cheaper LLM for reduced
 * latency. When no presentation LLM is configured, it yields the
 * tool-loop content as-is (benign no-op).
 *
 * Reads: `ctx.toolLoopContent`, `ctx.toolLoopMessages`, `ctx.presentationLlm`,
 *        `ctx.config.presentationSystemPrompt`
 * Writes: yields chunks via `ctx.yield()`
 *
 * ## Config
 *
 * | Field         | Type   | Default        | Description                          |
 * |---------------|--------|----------------|--------------------------------------|
 * | `systemPrompt`| string | from ctx.config| Override presentation system prompt   |
 */

import type { LlmFinishReason } from '../../interfaces/types.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class PresentHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    parentSpan: ISpan,
  ): Promise<boolean> {
    const presentationLlm = ctx.presentationLlm;

    // External tool call path — tool-loop already yielded finishReason: 'tool_calls'.
    // Nothing to present; running the presentation LLM would produce garbage.
    if (!ctx.toolLoopContent && ctx.toolLoopMessages.length === 0) {
      return true;
    }

    // No presentation LLM — yield toolLoopContent as-is (no-op fallback)
    if (!presentationLlm) {
      if (ctx.toolLoopContent) {
        ctx.yield({ ok: true, value: { content: ctx.toolLoopContent } });
      }
      return true;
    }

    // Build presentation prompt
    const systemPrompt =
      (config.systemPrompt as string) ??
      ctx.config.presentationSystemPrompt ??
      'Present the information clearly and concisely.';

    // Build messages: tool-loop conversation + mainLlm's draft + presentation instruction
    const messages = [
      ...ctx.toolLoopMessages,
      ...(ctx.toolLoopContent
        ? [{ role: 'assistant' as const, content: ctx.toolLoopContent }]
        : []),
      { role: 'user' as const, content: systemPrompt },
    ];

    const presentSpan = ctx.tracer.startSpan('smart_agent.present', {
      parent: parentSpan,
      attributes: { 'llm.presentation': true },
    });

    const presentStart = Date.now();

    try {
      const stream = presentationLlm.streamChat(messages, [], ctx.options);

      let _content = '';
      let finishReason: LlmFinishReason | undefined;
      const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      for await (const chunkResult of stream) {
        if (ctx.options?.signal?.aborted) {
          presentSpan.setStatus('error', 'aborted');
          presentSpan.end();
          if (ctx.toolLoopContent) {
            ctx.yield({ ok: true, value: { content: ctx.toolLoopContent } });
          }
          return true;
        }
        if (!chunkResult.ok) {
          // Presentation LLM failed — fall back to toolLoopContent
          presentSpan.setStatus('error', chunkResult.error.message);
          presentSpan.end();
          ctx.logger?.log({
            type: 'pipeline_done',
            traceId: ctx.options?.trace?.traceId ?? 'present',
            stopReason: 'stop',
            iterations: 0,
            toolCallCount: 0,
            durationMs: Date.now() - presentStart,
          });
          if (ctx.toolLoopContent) {
            ctx.yield({ ok: true, value: { content: ctx.toolLoopContent } });
          }
          return true;
        }

        const chunk = chunkResult.value;
        if (chunk.content) {
          _content += chunk.content;
          ctx.yield({ ok: true, value: { content: chunk.content } });
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage) {
          usage.promptTokens += chunk.usage.promptTokens;
          usage.completionTokens += chunk.usage.completionTokens;
          usage.totalTokens += chunk.usage.totalTokens;
          ctx.sessionManager.addTokens(chunk.usage.totalTokens);
        }
      }

      presentSpan.setStatus('ok');
      presentSpan.end();

      const duration = Date.now() - presentStart;
      ctx.timing.push({ phase: 'present', duration });

      ctx.yield({
        ok: true,
        value: {
          content: '',
          finishReason: finishReason ?? 'stop',
          usage,
          timing: [{ phase: 'present', duration }],
        },
      });
    } catch (err) {
      // Unexpected error — fall back to toolLoopContent (graceful degradation)
      presentSpan.setStatus(
        'error',
        err instanceof Error ? err.message : String(err),
      );
      presentSpan.end();
      ctx.logger?.log({
        type: 'pipeline_done',
        traceId: ctx.options?.trace?.traceId ?? 'present',
        stopReason: 'stop',
        iterations: 0,
        toolCallCount: 0,
        durationMs: Date.now() - presentStart,
      });
      if (ctx.toolLoopContent) {
        ctx.yield({ ok: true, value: { content: ctx.toolLoopContent } });
      }
    }

    return true;
  }
}
