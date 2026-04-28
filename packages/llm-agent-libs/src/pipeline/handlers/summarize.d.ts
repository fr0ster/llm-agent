/**
 * SummarizeHandler — condenses conversation history using helper LLM.
 *
 * Reads: `ctx.history`, `ctx.helperLlm`
 * Writes: `ctx.history` (replaces with summarized version)
 *
 * Keeps the last 5 messages verbatim and summarizes the rest into a
 * single system message. Skips silently if no helper LLM is available
 * or history is too short.
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class SummarizeHandler implements IStageHandler {
    execute(ctx: PipelineContext, config: Record<string, unknown>, span: ISpan): Promise<boolean>;
}
//# sourceMappingURL=summarize.d.ts.map