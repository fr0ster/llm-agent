/**
 * HistoryUpsertHandler — post-tool-loop pipeline stage.
 *
 * After tool-loop completes, this stage:
 * 1. Calls IHistorySummarizer to produce a compact turn summary.
 * 2. Upserts the summary to the history RAG store.
 * 3. Pushes the summary to the recency memory buffer.
 *
 * A failed summarizer or a failed store write fails the stage with that
 * component's code (spec §10.5.6 L4) — nothing raw is stored as if it were a
 * summary. The `summarizeAndStore` helper is exported for unit testing.
 */

import type {
  CallOptions,
  HistoryTurn,
  IHistoryMemory,
  IHistorySummarizer,
  IRag,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError, SmartAgentError } from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export interface SummarizeAndStoreArgs {
  turn: HistoryTurn;
  summarizer: IHistorySummarizer;
  memory: IHistoryMemory;
  rag: IRag;
  sessionId: string;
  options?: CallOptions;
  log?: (msg: string, data?: unknown) => void;
}

export async function summarizeAndStore(
  args: SummarizeAndStoreArgs,
): Promise<Result<void, OrchestratorError>> {
  const { turn, summarizer, memory, rag, sessionId, options, log } = args;

  const result = await summarizer.summarize(turn, options);
  if (!result.ok) {
    log?.('history_summarize_failed', { error: result.error.message });
    return {
      ok: false,
      error: new OrchestratorError(
        `history-upsert: ${result.error.message}`,
        result.error.code,
      ),
    };
  }
  const summary = result.value;

  const ragWriter = rag.writer?.();
  if (!ragWriter) {
    log?.('history_upsert_failed', { error: 'RAG writer not available' });
  } else {
    // The owner goes into the metadata: the history store is queried with
    // scope 'session', and every store filters on metadata.sessionId (and
    // userId for scope 'user'). An untagged record is invisible to its own
    // session — and, before stores honoured the filter, visible to all.
    const upsertResult = await ragWriter.upsertRaw(
      `turn:${sessionId}:${turn.turnIndex}`,
      summary,
      {
        sessionId,
        ...(options?.userId !== undefined ? { userId: options.userId } : {}),
      },
      options,
    );
    if (!upsertResult.ok) {
      log?.('history_upsert_failed', { error: upsertResult.error.message });
      return {
        ok: false,
        error: new OrchestratorError(
          `history-upsert: ${upsertResult.error.message}`,
          upsertResult.error.code,
        ),
      };
    }
  }

  memory.pushRecent(sessionId, summary);
  return { ok: true, value: undefined };
}

export class HistoryUpsertHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    if (!ctx.historySummarizer || !ctx.historyMemory) {
      span.setAttribute('skipped', true);
      return true;
    }
    if (!ctx.config.semanticHistoryEnabled) {
      span.setAttribute('skipped', true);
      return true;
    }

    const historyRag = ctx.ragStores.history;
    if (!historyRag) {
      span.setAttribute('skipped', true);
      return true;
    }

    try {
      const turn: HistoryTurn = {
        sessionId: ctx.sessionId,
        turnIndex: Date.now(),
        userText: ctx.inputText,
        assistantText: ctx.assistantText ?? '',
        toolCalls: [],
        toolResults: [],
        timestamp: Date.now(),
      };

      const stored = await summarizeAndStore({
        turn,
        summarizer: ctx.historySummarizer,
        memory: ctx.historyMemory,
        rag: historyRag,
        sessionId: ctx.sessionId,
        options: ctx.options,
        log: (msg, data) =>
          ctx.options?.sessionLogger?.logStep(
            msg,
            data as Record<string, unknown>,
          ),
      });

      if (!stored.ok) {
        span.setStatus('error', stored.error.message);
        ctx.error = stored.error;
        return false;
      }
      span.setStatus('ok');
    } catch (err) {
      // A rejection (summarizer or store) is the same failure as `ok: false`.
      span.setStatus('error', 'history upsert failed');
      ctx.error =
        err instanceof SmartAgentError
          ? new OrchestratorError(`history-upsert: ${err.message}`, err.code)
          : new OrchestratorError(
              `history-upsert: ${String(err)}`,
              'PIPELINE_ERROR',
            );
      return false;
    }

    return true;
  }
}
