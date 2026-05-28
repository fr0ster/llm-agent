import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRequestLogger } from '../session-request-logger.js';

const call = (component: string, total: number, requestId?: string) => ({
  component: component as never,
  model: 'm',
  promptTokens: total,
  completionTokens: 0,
  totalTokens: total,
  durationMs: 1,
  requestId,
});

test('per-traceId delta isolates concurrent requests', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.startRequest('r2');
  log.logLlmCall(call('tool-loop', 10, 'r1'));
  log.logLlmCall(call('tool-loop', 5, 'r2'));
  assert.equal(log.getSummary('r1').byComponent['tool-loop'].totalTokens, 10);
  assert.equal(log.getSummary('r2').byComponent['tool-loop'].totalTokens, 5);
});

test('NESTED start does NOT clear an existing delta (coordinator tokens survive a worker start)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t'); // coordinator (depth 1)
  log.logLlmCall(call('translate', 7, 't')); // coordinator's own aux call
  log.startRequest('t'); // nested worker start (depth 2) — must NOT wipe
  log.logLlmCall(call('tool-loop', 30, 't')); // worker tokens
  assert.equal(log.getSummary('t').byComponent['translate'].totalTokens, 7);
  assert.equal(log.getSummary('t').byComponent['tool-loop'].totalTokens, 30);
});

test('NESTED end does NOT delete the delta (worker endRequest leaves it for the server)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t'); // coordinator (depth 1)
  log.startRequest('t'); // worker (depth 2)
  log.logLlmCall(call('tool-loop', 42, 't'));
  log.endRequest('t'); // worker end (depth 1) — bucket survives
  assert.equal(log.getSummary('t').byComponent['tool-loop'].totalTokens, 42);
  log.endRequest('t'); // coordinator end (depth 0) — STILL survives
  assert.equal(
    log.getSummary('t').byComponent['tool-loop'].totalTokens,
    42,
    'endRequest never deletes; only dropRequest frees',
  );
});

test('dropRequest frees the delta (server calls it after reading usage)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t');
  log.logLlmCall(call('tool-loop', 42, 't'));
  assert.equal(log.getSummary('t').byComponent['tool-loop'].totalTokens, 42);
  log.dropRequest('t');
  assert.equal(
    Object.keys(log.getSummary('t').byComponent).length,
    0,
    'delta freed; getSummary(t) now empty',
  );
});

test('session-cumulative sums across requests regardless of depth and survives end+drop', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.logLlmCall(call('tool-loop', 10, 'r1'));
  log.endRequest('r1');
  log.dropRequest('r1');
  log.startRequest('r2');
  log.logLlmCall(call('tool-loop', 7, 'r2'));
  log.endRequest('r2');
  log.dropRequest('r2');
  assert.equal(log.getSummary().byComponent['tool-loop'].totalTokens, 17);
});

test('reset clears session-cumulative + deltas (called on session evict)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.logLlmCall(call('tool-loop', 10, 'r1'));
  log.reset();
  assert.equal(Object.keys(log.getSummary().byComponent).length, 0);
});

test('calls without a requestId still land in session-cumulative', () => {
  const log = new SessionRequestLogger();
  log.logLlmCall(call('embedding', 4));
  assert.equal(log.getSummary().byComponent['embedding'].totalTokens, 4);
});

test('byCategory uses component-keyed CATEGORY_MAP — translate counts as auxiliary, not request (review MEDIUM #4)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t');
  // translate has no `scope` set on the entry. The bug treated this as 'request'.
  log.logLlmCall(call('translate', 9, 't'));
  log.logLlmCall(call('tool-loop', 11, 't'));
  const s = log.getSummary('t');
  assert.equal(s.byCategory.auxiliary?.totalTokens, 9, 'translate → auxiliary');
  assert.equal(s.byCategory.request?.totalTokens, 11, 'tool-loop → request');
});

test('classifier/query-expander/helper all categorize as auxiliary; embedding as initialization', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t');
  log.logLlmCall(call('classifier', 1, 't'));
  log.logLlmCall(call('query-expander', 2, 't'));
  log.logLlmCall(call('helper', 3, 't'));
  log.logLlmCall(call('embedding', 4, 't'));
  const s = log.getSummary('t');
  assert.equal(s.byCategory.auxiliary?.totalTokens, 6);
  assert.equal(s.byCategory.initialization?.totalTokens, 4);
  assert.equal(s.byCategory.request, undefined);
});

test('planner/reviewer categorize as auxiliary (HIGH: role LLM overhead, not main request)', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t');
  log.logLlmCall(call('planner', 5, 't'));
  log.logLlmCall(call('reviewer', 7, 't'));
  log.logLlmCall(call('tool-loop', 13, 't'));
  const s = log.getSummary('t');
  assert.equal(
    s.byCategory.auxiliary?.totalTokens,
    12,
    'planner+reviewer → auxiliary',
  );
  assert.equal(s.byCategory.request?.totalTokens, 13, 'tool-loop → request');
  assert.equal(s.byComponent.planner?.totalTokens, 5);
  assert.equal(s.byComponent.reviewer?.totalTokens, 7);
});
