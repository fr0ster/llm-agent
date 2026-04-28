/**
 * HistoryUpsertHandler — post-tool-loop pipeline stage.
 *
 * After tool-loop completes, this stage:
 * 1. Calls IHistorySummarizer to produce a compact turn summary.
 * 2. Upserts the summary to the history RAG store.
 * 3. Pushes the summary to the recency memory buffer.
 *
 * All operations are best-effort — failures are logged but never block the
 * response. The `summarizeAndStore` helper is exported for unit testing.
 */

import type {
  CallOptions,
  HistoryTurn,
  IHistoryMemory,
  IHistorySummarizer,
  IRag,
} from '@mcp-abap-adt/llm-agent';
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
): Promise<void> {
  const { turn, summarizer, memory, rag, sessionId, options, log } = args;

  const result = await summarizer.summarize(turn, options);
  const summary = result.ok
    ? result.value
    : `${turn.userText} → ${turn.assistantText}`;

  if (!result.ok) {
    log?.('history_summarize_failed', { error: result.error.message });
  }

  const ragWriter = rag.writer?.();
  if (!ragWriter) {
    log?.('history_upsert_failed', { error: 'RAG writer not available' });
  } else {
    const upsertResult = await ragWriter.upsertRaw(
      `turn:${sessionId}:${turn.turnIndex}`,
      summary,
      {},
      options,
    );
    if (!upsertResult.ok) {
      log?.('history_upsert_failed', { error: upsertResult.error.message });
    }
  }

  memory.pushRecent(sessionId, summary);
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
        assistantText: '',
        toolCalls: [],
        toolResults: [],
        timestamp: Date.now(),
      };

      await summarizeAndStore({
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

      span.setStatus('ok');
    } catch {
      span.setStatus('error', 'history upsert failed');
    }

    return true;
  }
}
