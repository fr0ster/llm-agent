import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '@mcp-abap-adt/llm-agent-libs';
import { makeLogUsage } from '../controller-coordinator-handler.js';

test('logUsage routes per-role usage into the request logger with model + requestId', () => {
  const logger = new SessionRequestLogger();
  logger.startRequest('r1');
  const models = { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' };
  const logUsage = makeLogUsage(logger, 'r1', models);
  const u: LlmUsage = {
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
  };
  logUsage('planner', u);
  logUsage('finalizer', u);
  logUsage('evaluator', u);
  const s = logger.getSummary('r1');
  assert.equal(s.byComponent.planner?.totalTokens, 12);
  assert.equal(s.byComponent.finalizer?.totalTokens, 12);
  // planner + finalizer share the planner model:
  assert.equal(s.byModel['m-plan'].requests, 2);
  assert.equal(s.byModel['m-eval'].totalTokens, 12);
});

test('logUsage is a no-op on undefined usage', () => {
  const logger = new SessionRequestLogger();
  logger.startRequest('r2');
  makeLogUsage(logger, 'r2', { evaluator: 'a', planner: 'b', executor: 'c' })(
    'planner',
    undefined,
  );
  assert.equal(logger.getSummary('r2').totals.totalTokens, 0);
});
