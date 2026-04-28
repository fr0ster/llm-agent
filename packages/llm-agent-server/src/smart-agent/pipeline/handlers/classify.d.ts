/**
 * ClassifyHandler — decomposes user input into typed subprompts.
 *
 * Reads: `ctx.inputText`
 * Writes: `ctx.subprompts`, `ctx.isSapRequired`, `ctx.shouldRetrieve`
 *
 * When classification is disabled (`config.classificationEnabled === false`),
 * the input is treated as a single action subprompt.
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class ClassifyHandler implements IStageHandler {
    execute(ctx: PipelineContext, _config: Record<string, unknown>, span: ISpan): Promise<boolean>;
    /**
     * Update control flags based on classified subprompts.
     * These flags are used by `when` conditions on downstream stages.
     */
    private _updateControlFlags;
}
//# sourceMappingURL=classify.d.ts.map