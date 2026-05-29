import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnPartial, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { TemplateFinalizer } from '../template-finalizer.js';

test('TemplateFinalizer fires onPartial once with the rendered output', async () => {
  const f = new TemplateFinalizer();
  const chunks: StreamChunk[] = [];
  const op: OnPartial = (c) => chunks.push(c);
  const res = await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'IGNORED',
    executionTrace: [
      { nodeId: 'n1', goal: 'analyse', output: 'A body' },
      { nodeId: 'n2', goal: 'summarise', output: 'B body' },
    ],
    onPartial: op,
  });
  // Single chunk equal to the full rendered output.
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'content');
  assert.equal((chunks[0] as { delta: string }).delta, res.output);
});
