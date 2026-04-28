"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.queryExpander = exports.stageHandlers = void 0;
// ---------------------------------------------------------------------------
// Stage handler 1: request-timer-start — records pipeline start time
// ---------------------------------------------------------------------------
class RequestTimerStartHandler {
    async execute(ctx, _config, span) {
        // Store start time on the context for the end handler to read
        ctx._timerStartMs = Date.now();
        span.setAttribute('timer.started', true);
        return true;
    }
}
// ---------------------------------------------------------------------------
// Stage handler 2: request-timer-end — logs total pipeline duration
// ---------------------------------------------------------------------------
class RequestTimerEndHandler {
    async execute(ctx, _config, span) {
        const startMs = ctx._timerStartMs;
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
const SYNONYMS = {
    table: ['database table', 'DB table', 'transparent table'],
    report: ['program', 'executable', 'ABAP report'],
    class: ['ABAP class', 'OO class', 'object'],
    bapi: ['BAPI', 'Business API', 'RFC function module'],
};
class DomainQueryExpander {
    async expand(query, _options) {
        const words = query.toLowerCase().split(/\s+/);
        const expansions = [];
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
exports.stageHandlers = {
    'request-timer-start': new RequestTimerStartHandler(),
    'request-timer-end': new RequestTimerEndHandler(),
};
exports.queryExpander = new DomainQueryExpander();
//# sourceMappingURL=06-multi-export.js.map