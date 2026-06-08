import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRequestLogger } from '../session-request-logger.js';

test('request-scoped embedding is categorized as request, not initialization', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t1');
  log.logLlmCall({
    component: 'embedding',
    model: 'embedder',
    promptTokens: 8,
    completionTokens: 0,
    totalTokens: 8,
    durationMs: 0,
    scope: 'request',
    requestId: 't1',
  });
  const s = log.getSummary('t1');
  assert.equal(s.byCategory.request?.totalTokens, 8);
  assert.equal(s.byCategory.initialization, undefined);
});

test('embedding without request scope stays initialization', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t2');
  log.logLlmCall({
    component: 'embedding',
    model: 'embedder',
    promptTokens: 8,
    completionTokens: 0,
    totalTokens: 8,
    durationMs: 0,
    requestId: 't2',
  });
  assert.equal(log.getSummary('t2').byCategory.initialization?.totalTokens, 8);
});
