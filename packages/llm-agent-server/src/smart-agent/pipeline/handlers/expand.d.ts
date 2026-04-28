/**
 * ExpandHandler — expands RAG query with synonyms and related terms.
 *
 * Reads: `ctx.ragText`, `ctx.queryExpander`
 * Writes: `ctx.ragText`
 *
 * Uses the injected IQueryExpander to broaden RAG queries.
 * Skipped when `queryExpansionEnabled` is false.
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class ExpandHandler implements IStageHandler {
    execute(ctx: PipelineContext, _config: Record<string, unknown>, span: ISpan): Promise<boolean>;
}
//# sourceMappingURL=expand.d.ts.map