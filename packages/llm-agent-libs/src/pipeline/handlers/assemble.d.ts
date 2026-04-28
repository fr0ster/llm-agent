/**
 * AssembleHandler — builds the final LLM context from action + retrieved + history.
 *
 * Reads: `ctx.subprompts`, `ctx.ragResults`, `ctx.mcpTools` (selected), `ctx.history`
 * Writes: `ctx.assembledMessages`
 *
 * Merges multiple action subprompts into a single action, then delegates
 * to the injected IContextAssembler.
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class AssembleHandler implements IStageHandler {
  execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean>;
}
//# sourceMappingURL=assemble.d.ts.map
