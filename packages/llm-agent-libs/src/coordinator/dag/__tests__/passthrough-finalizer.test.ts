import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassthroughFinalizer } from '../passthrough-finalizer.js';

test('PassthroughFinalizer returns interpreterOutput verbatim (multi-terminal DAG)', async () => {
  const f = new PassthroughFinalizer();
  const joined = 'leaf-A output\n\nleaf-B output\n\nleaf-C output';
  const res = await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: joined,
    executionTrace: [
      { nodeId: 'a', goal: 'ga', output: 'leaf-A output' },
      { nodeId: 'b', goal: 'gb', output: 'leaf-B output' },
      { nodeId: 'c', goal: 'gc', output: 'leaf-C output' },
    ],
  });
  assert.equal(res.output, joined);
  assert.equal(res.usage, undefined);
  assert.equal(f.name, 'passthrough');
});
