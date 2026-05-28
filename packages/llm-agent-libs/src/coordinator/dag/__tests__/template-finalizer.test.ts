import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TemplateFinalizer } from '../template-finalizer.js';

test('TemplateFinalizer joins trace into deterministic markdown', async () => {
  const f = new TemplateFinalizer();
  const res = await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'IGNORED',
    executionTrace: [
      { nodeId: 'n1', goal: 'analyse', output: 'A body' },
      { nodeId: 'n2', goal: 'summarise', output: 'B body' },
    ],
  });
  assert.equal(
    res.output,
    '# Node n1 — analyse\nA body\n\n# Node n2 — summarise\nB body\n\n',
  );
  assert.equal(res.usage, undefined);
  assert.equal(f.name, 'template');
});
