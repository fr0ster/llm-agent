/**
 * Task C7 — seam test: per-response `usage` triple is sourced from the
 * per-traceId request delta, not zeros.
 *
 * The integration in C4 (coordinator-usage-integration.test.ts) already
 * proves worker tokens reach `getSummary(traceId).byComponent` through the
 * coordinator. This test asserts the seam the agent uses to assemble the
 * final response `usage`: after a handler logs N tokens under a traceId,
 * `summaryToUsage(logger.getSummary(traceId))` is non-zero — which is what
 * agent.ts now spreads into the yielded `usage` (replacing the previous
 * `{0,0,0}` from the local `usage` accumulator on the coordinator path).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SessionRequestLogger,
  summaryToUsage,
} from '../session-request-logger.js';

test('per-response usage triple is built from the traceId delta (non-zero)', () => {
  const logger = new SessionRequestLogger();
  const traceId = 'trace-c7';

  // Agent: startRequest(traceId) at the top of process()
  logger.startRequest(traceId);

  // Handlers (tool-loop, translate, ...) log under that traceId
  logger.logLlmCall({
    component: 'tool-loop',
    model: 'm',
    promptTokens: 40,
    completionTokens: 10,
    totalTokens: 50,
    durationMs: 1,
    requestId: traceId,
  });
  logger.logLlmCall({
    component: 'translate',
    model: 'm',
    promptTokens: 8,
    completionTokens: 2,
    totalTokens: 10,
    durationMs: 1,
    requestId: traceId,
  });

  // Agent: at the response-assembly site
  const delta = logger.getSummary(traceId);
  const deltaUsage = summaryToUsage(delta);

  // Was {0,0,0} before C7 (agent only used the local `usage` accumulator
  // which is never populated on the coordinator path).
  assert.equal(deltaUsage.promptTokens, 48);
  assert.equal(deltaUsage.completionTokens, 12);
  assert.equal(deltaUsage.totalTokens, 60);

  // byModel is still surfaced (unchanged behavior).
  assert.ok(delta.byModel.m);
  assert.equal(delta.byModel.m.totalTokens, 60);

  // Agent: endRequest(traceId) — nested-safe, leaves the delta intact
  // so the server can read it from getSummary(traceId) before dropping.
  logger.endRequest(traceId);
  const afterEnd = logger.getSummary(traceId);
  assert.equal(afterEnd.byComponent['tool-loop'].totalTokens, 50);
});
