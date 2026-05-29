import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';

// Reentrancy contract (spec A.5/A.6): two concurrent runs of ONE session share
// the session logger but keep separate per-traceId deltas — no cross-talk — and
// nested worker start/end under one traceId must not corrupt that traceId's delta.
test('concurrent same-session requests keep independent per-traceId deltas', () => {
  const logger = new SessionRequestLogger(); // shared by the session graph
  logger.startRequest('trace-A');
  logger.startRequest('trace-B');
  logger.logLlmCall({
    component: 'tool-loop' as never,
    model: 'm',
    promptTokens: 11,
    completionTokens: 0,
    totalTokens: 11,
    durationMs: 1,
    requestId: 'trace-A',
  });
  logger.logLlmCall({
    component: 'tool-loop' as never,
    model: 'm',
    promptTokens: 22,
    completionTokens: 0,
    totalTokens: 22,
    durationMs: 1,
    requestId: 'trace-B',
  });
  assert.equal(
    logger.getSummary('trace-A').byComponent['tool-loop'].totalTokens,
    11,
  );
  assert.equal(
    logger.getSummary('trace-B').byComponent['tool-loop'].totalTokens,
    22,
  );
  assert.equal(logger.getSummary().byComponent['tool-loop'].totalTokens, 33);
});

test('nested worker start/end under one traceId does not corrupt the delta', () => {
  const logger = new SessionRequestLogger();
  logger.startRequest('t'); // coordinator
  logger.logLlmCall({
    component: 'translate' as never,
    model: 'm',
    promptTokens: 5,
    completionTokens: 0,
    totalTokens: 5,
    durationMs: 1,
    requestId: 't',
  });
  logger.startRequest('t'); // worker (nested)
  logger.logLlmCall({
    component: 'tool-loop' as never,
    model: 'm',
    promptTokens: 40,
    completionTokens: 0,
    totalTokens: 40,
    durationMs: 1,
    requestId: 't',
  });
  logger.endRequest('t'); // worker end
  logger.endRequest('t'); // coordinator end
  assert.equal(logger.getSummary('t').byComponent['translate'].totalTokens, 5);
  assert.equal(logger.getSummary('t').byComponent['tool-loop'].totalTokens, 40);
  logger.dropRequest('t');
  assert.equal(Object.keys(logger.getSummary('t').byComponent).length, 0);
});
