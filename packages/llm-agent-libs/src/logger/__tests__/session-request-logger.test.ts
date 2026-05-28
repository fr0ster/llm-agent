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
