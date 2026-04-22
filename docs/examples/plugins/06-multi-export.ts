/**
 * Plugin: multi-export — demonstrates a plugin that registers multiple types.
 *
 * A single plugin file can export any combination of:
 *   - stageHandlers     (pipeline stage handlers)
 *   - embedderFactories (RAG embedder factories)
 *   - reranker          (replaces default reranker)
 *   - queryExpander     (replaces default query expander)
 *   - outputValidator   (replaces default output validator)
 *
 * This example registers two stage handlers and a query expander.
 *
 * Usage in YAML:
 *   pluginDir: ./plugins
 *   pipeline:
 *     version: "1"
 *     stages:
 *       - { id: timing-start, type: request-timer-start }
 *       - { id: classify, type: classify }
 *       # ... other stages ...
 *       - { id: timing-end, type: request-timer-end }
 */

import type { ISpan, IStageHandler, PipelineContext } from '@mcp-abap-adt/llm-agent-server';
import type { CallOptions, IQueryExpander, RagError, Result } from '@mcp-abap-adt/llm-agent';

// ---------------------------------------------------------------------------
// Stage handler 1: request-timer-start — records pipeline start time
// ---------------------------------------------------------------------------

class RequestTimerStartHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    // Store start time on the context for the end handler to read
    (ctx as unknown as Record<string, unknown>)._timerStartMs = Date.now();
    span.setAttribute('timer.started', true);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Stage handler 2: request-timer-end — logs total pipeline duration
// ---------------------------------------------------------------------------

class RequestTimerEndHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const startMs = (ctx as unknown as Record<string, unknown>)._timerStartMs as
      | number
      | undefined;
    if (startMs) {
      const durationMs = Date.now() - startMs;
      span.setAttribute('timer.durationMs', durationMs);
      ctx.options?.sessionLogger?.logStep('pipeline_total_duration', {
        durationMs,
        sessionId: ctx.sessionId,
      });
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Query expander: adds domain-specific synonyms
// ---------------------------------------------------------------------------

/** Domain synonym map — extend with your own terms */
const SYNONYMS: Record<string, string[]> = {
  table: ['database table', 'DB table', 'transparent table'],
  report: ['program', 'executable', 'ABAP report'],
  class: ['ABAP class', 'OO class', 'object'],
  bapi: ['BAPI', 'Business API', 'RFC function module'],
};

class DomainQueryExpander implements IQueryExpander {
  async expand(
    query: string,
    _options?: CallOptions,
  ): Promise<Result<string, RagError>> {
    const words = query.toLowerCase().split(/\s+/);
    const expansions: string[] = [];

    for (const word of words) {
      const syns = SYNONYMS[word];
      if (syns) {
        expansions.push(...syns);
      }
    }

    if (expansions.length === 0) {
      return { ok: true, value: query };
    }

    // Append synonyms to broaden RAG recall
    return { ok: true, value: `${query} ${expansions.join(' ')}` };
  }
}

// ---------------------------------------------------------------------------
// Plugin exports — all registered in a single file
// ---------------------------------------------------------------------------

export const stageHandlers = {
  'request-timer-start': new RequestTimerStartHandler(),
  'request-timer-end': new RequestTimerEndHandler(),
};

export const queryExpander = new DomainQueryExpander();
