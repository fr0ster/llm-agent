/**
 * ExpandHandler — expands RAG query with synonyms and related terms.
 *
 * Reads: `ctx.ragText`, `ctx.queryExpander`
 * Writes: `ctx.ragText`
 *
 * Uses the injected IQueryExpander to broaden RAG queries.
 * Skipped when `queryExpansionEnabled` is false.
 */

import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
import { rejectionError } from '../../agent/rag-helpers.js';
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

    let result: Awaited<ReturnType<typeof ctx.queryExpander.expand>>;
    try {
      result = await ctx.queryExpander.expand(ctx.ragText, ctx.options);
    } catch (err) {
      span.setStatus('error', String(err));
      ctx.error = rejectionError('expand', err, 'QUERY_EXPAND_ERROR');
      return false;
    }
    // Spec §10.5.6 L2: a failed expander is the stage's error, with its code.
    if (!result.ok) {
      span.setStatus('error', result.error.message);
      ctx.error = new OrchestratorError(
        `expand: ${result.error.message}`,
        result.error.code,
      );
      return false;
    }
    ctx.ragText = result.value;
    span.setAttribute('expanded', true);

    return true;
  }
}
