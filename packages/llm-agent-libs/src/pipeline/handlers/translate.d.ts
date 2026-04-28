/**
 * TranslateHandler — translates non-ASCII RAG query text to English.
 *
 * Reads: `ctx.ragText`, `ctx.helperLlm` (or `ctx.mainLlm` as fallback)
 * Writes: `ctx.ragText`
 *
 * Skips translation when:
 * - Text is ASCII-only
 * - Text is shorter than 15 characters
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class TranslateHandler implements IStageHandler {
    execute(ctx: PipelineContext, _config: Record<string, unknown>, span: ISpan): Promise<boolean>;
}
//# sourceMappingURL=translate.d.ts.map