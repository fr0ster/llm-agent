import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnPartial, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { PassthroughFinalizer } from '../passthrough-finalizer.js';

test('PassthroughFinalizer fires onPartial once with the full output', async () => {
  const f = new PassthroughFinalizer();
  const chunks: StreamChunk[] = [];
  const op: OnPartial = (c) => chunks.push(c);
  const res = await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'HELLO',
    executionTrace: [],
    onPartial: op,
  });
  assert.equal(res.output, 'HELLO');
  assert.deepEqual(chunks, [{ kind: 'content', delta: 'HELLO' }]);
});

test('PassthroughFinalizer without onPartial returns output silently', async () => {
  const f = new PassthroughFinalizer();
  const res = await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'X',
    executionTrace: [],
  });
  assert.equal(res.output, 'X');
});
