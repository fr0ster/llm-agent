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

export class ExpandHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    if (!ctx.config.queryExpansionEnabled) {
      span.setAttribute('skipped', true);
      return true;
    }

    const result = await ctx.queryExpander.expand(ctx.ragText, ctx.options);
    if (result.ok) {
      ctx.ragText = result.value;
      span.setAttribute('expanded', true);
    }

    return true;
  }
}
