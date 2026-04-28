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
export declare function summarizeAndStore(
  args: SummarizeAndStoreArgs,
): Promise<void>;
export declare class HistoryUpsertHandler implements IStageHandler {
  execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean>;
}
//# sourceMappingURL=history-upsert.d.ts.map
