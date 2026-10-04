/**
 * `withAbort` must leave the caller's signal exactly as it found it: the
 * `abort` listener is removed after resolve, reject and abort alike.
 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { SmartAgentError } from '@mcp-abap-adt/llm-agent';
import { withAbort } from '../with-abort.js';

const err = () => new SmartAgentError('aborted', 'ABORTED');
const count = (s: AbortSignal) => getEventListeners(s, 'abort').length;

test('listener count returns to start after resolve', async () => {
  const c = new AbortController();
  const before = count(c.signal);
  assert.equal(await withAbort(Promise.resolve(1), c.signal, err), 1);
  assert.equal(count(c.signal), before);
});

test('listener count returns to start after reject', async () => {
  const c = new AbortController();
  const before = count(c.signal);
  await assert.rejects(
    withAbort(Promise.reject(new Error('x')), c.signal, err),
    /x/,
  );
  assert.equal(count(c.signal), before);
});

test('listener count returns to start after abort', async () => {
  const c = new AbortController();
  const before = count(c.signal);
  const p = withAbort(new Promise<never>(() => {}), c.signal, err);
  assert.equal(count(c.signal), before + 1);
  c.abort();
  await assert.rejects(p, /aborted/);
  assert.equal(count(c.signal), before);
});

test('many calls on one signal do not accumulate listeners', async () => {
  const c = new AbortController();
  for (let i = 0; i < 50; i++)
    await withAbort(Promise.resolve(i), c.signal, err);
  assert.equal(count(c.signal), 0);
});
