import { stampRagOwner, terminalRunError } from '@mcp-abap-adt/llm-agent';
import {
  type CallerResolution,
  callerResolutionKey,
  resolveCallerIdentity,
} from '../../policy/caller-identity.js';
/**
 * HistoryUpsertHandler — post-tool-loop pipeline stage.
 *
 * After tool-loop completes, this stage:
 * 1. Calls IHistorySummarizer to produce a compact turn summary.
 * 2. Upserts the summary to the history RAG store.
 * 3. Pushes the summary to the recency memory buffer.
 *
 * Recoverable failures are logged and fall back to the original turn text
 * when summarization fails. Terminal errors are propagated.
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
  identity?: CallerResolution;
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
  const identity = args.identity ?? resolveCallerIdentity(options, sessionId);

  const result = await summarizer.summarize(turn, options);
  if (!result.ok) {
    const terminal = terminalRunError(result.error);
    if (terminal) throw terminal;
    log?.('history_summarize_failed', { error: result.error.message });
  }
  const summary = result.ok
    ? result.value
    : `${turn.userText} → ${turn.assistantText}`;

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
      stampRagOwner({}, { scope: 'session', sessionId }),
      options,
    );
    if (!upsertResult.ok) {
      const terminal = terminalRunError(upsertResult.error);
      if (terminal) throw terminal;
      log?.('history_upsert_failed', { error: upsertResult.error.message });
    }
  }

  const memoryKey = callerResolutionKey(identity);
  if (memoryKey !== undefined) memory.pushRecent(memoryKey, summary);
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

      await summarizeAndStore({
        identity: ctx.callerResolution,
        turn,
        summarizer: ctx.historySummarizer,
        memory: ctx.historyMemory,
        rag: historyRag.rag,
        sessionId: ctx.sessionId,
        options: ctx.options,
        log: (msg, data) =>
          ctx.options?.sessionLogger?.logStep(
            msg,
            data as Record<string, unknown>,
          ),
      });

      span.setStatus('ok');
    } catch (error) {
      const terminal = terminalRunError(error);
      if (terminal) throw terminal;
      span.setStatus('error', 'history upsert failed');
    }

    return true;
  }
}
