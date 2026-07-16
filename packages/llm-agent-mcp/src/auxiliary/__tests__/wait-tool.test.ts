import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_WAIT_MAX_SECONDS, makeWaitTool } from '../wait-tool.js';

test('makeWaitTool def has name wait and a real JSON Schema', () => {
  const { def } = makeWaitTool();
  assert.equal(def.name, 'wait');
  assert.match(def.description, /Maximum 60 seconds/);
  assert.deepEqual(def.inputSchema, {
    type: 'object',
    properties: { seconds: { type: 'number', minimum: 0 } },
    required: ['seconds'],
    additionalProperties: false,
  });
  assert.equal(DEFAULT_WAIT_MAX_SECONDS, 60);
});

test('wait handler waits the requested seconds and returns a text result', async () => {
  const { handler } = makeWaitTool();
  const t0 = Date.now();
  const r = await handler({ seconds: 0.05 });
  assert.ok(r.ok);
  assert.equal(r.value.content as string, 'Waited 0.05s');
  assert.ok(Date.now() - t0 >= 40);
});

test('wait handler clamps to maxSeconds and notes the cap', async () => {
  const { handler } = makeWaitTool(0.02);
  const r = await handler({ seconds: 5 });
  assert.ok(r.ok);
  assert.equal(r.value.content, 'Waited 0.02s (requested 5, capped at 0.02)');
});

test('wait handler rejects invalid seconds with a tool-level error (not thrown)', async () => {
  const { handler } = makeWaitTool();
  const r = await handler({ seconds: 'soon' as unknown as number });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error.message, /non-negative number/);
});

test('wait handler propagates abort (rejects, not returns)', async () => {
  const { handler } = makeWaitTool();
  const ctrl = new AbortController();
  const p = handler({ seconds: 100 }, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(p);
});
