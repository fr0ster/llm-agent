import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SessionRequestLogger,
  summaryToUsage,
} from '../session-request-logger.js';

test('summaryToUsage sums all components into prompt/completion/total', () => {
  const usage = summaryToUsage({
    totals: {
      promptTokens: 110,
      completionTokens: 44,
      totalTokens: 154,
      requests: 2,
    },
    byModel: {},
    byCategory: {},
    ragQueries: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    byComponent: {
      'tool-loop': {
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        requests: 1,
      },
      translate: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
        requests: 1,
      },
    },
  });
  assert.deepEqual(usage, {
    promptTokens: 110,
    completionTokens: 44,
    totalTokens: 154,
  });
});

test('getSummary().totals equals sum of byComponent entries (multi-component DAG path)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r');
  log.logLlmCall({
    component: 'planner',
    model: 'm',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    durationMs: 1,
    requestId: 'r',
  });
  log.logLlmCall({
    component: 'tool-loop',
    model: 'm',
    promptTokens: 200,
    completionTokens: 80,
    totalTokens: 280,
    durationMs: 1,
    requestId: 'r',
  });
  log.logLlmCall({
    component: 'finalizer',
    model: 'm',
    promptTokens: 30,
    completionTokens: 10,
    totalTokens: 40,
    durationMs: 1,
    requestId: 'r',
  });

  const s = log.getSummary('r');

  // totals must equal sum of byComponent
  assert.equal(
    s.totals.promptTokens,
    s.byComponent.planner.promptTokens +
      s.byComponent['tool-loop'].promptTokens +
      s.byComponent.finalizer.promptTokens,
    'totals.promptTokens === sum(byComponent.promptTokens)',
  );
  assert.equal(
    s.totals.completionTokens,
    s.byComponent.planner.completionTokens +
      s.byComponent['tool-loop'].completionTokens +
      s.byComponent.finalizer.completionTokens,
    'totals.completionTokens === sum(byComponent.completionTokens)',
  );
  assert.equal(
    s.totals.totalTokens,
    s.byComponent.planner.totalTokens +
      s.byComponent['tool-loop'].totalTokens +
      s.byComponent.finalizer.totalTokens,
    'totals.totalTokens === sum(byComponent.totalTokens)',
  );
  assert.equal(
    s.totals.requests,
    s.byComponent.planner.requests +
      s.byComponent['tool-loop'].requests +
      s.byComponent.finalizer.requests,
    'totals.requests === sum(byComponent.requests)',
  );

  // Concrete expected values
  assert.equal(s.totals.promptTokens, 330);
  assert.equal(s.totals.completionTokens, 140);
  assert.equal(s.totals.totalTokens, 470);
  assert.equal(s.totals.requests, 3);

  // totals must not be null
  assert.notEqual(s.totals, null);
});

test('getSummary().totals is all-zero when no LLM calls have been logged (empty logger)', () => {
  const log = new SessionRequestLogger();
  const s = log.getSummary();
  assert.deepEqual(s.totals, {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
  });
  assert.deepEqual(s.byComponent, {});
});

test('session-cumulative getSummary() totals equals sum of all byComponent (no double-counting)', () => {
  const log = new SessionRequestLogger();
  // Two separate requests
  log.startRequest('r1');
  log.logLlmCall({
    component: 'tool-loop',
    model: 'm',
    promptTokens: 50,
    completionTokens: 20,
    totalTokens: 70,
    durationMs: 1,
    requestId: 'r1',
  });
  log.endRequest('r1');
  log.dropRequest('r1');

  log.startRequest('r2');
  log.logLlmCall({
    component: 'planner',
    model: 'm',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    durationMs: 1,
    requestId: 'r2',
  });
  log.endRequest('r2');
  log.dropRequest('r2');

  // Session cumulative (no requestId)
  const s = log.getSummary();
  assert.equal(s.totals.promptTokens, 60, 'cumulative totals.promptTokens');
  assert.equal(
    s.totals.completionTokens,
    25,
    'cumulative totals.completionTokens',
  );
  assert.equal(s.totals.totalTokens, 85, 'cumulative totals.totalTokens');
  assert.equal(s.totals.requests, 2, 'cumulative totals.requests');
});
