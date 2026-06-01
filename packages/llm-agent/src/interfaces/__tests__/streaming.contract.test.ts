import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnPartial, StreamChunk } from '../streaming.js';

test('StreamChunk discriminated union accepts every kind', () => {
  const accept: OnPartial = (c: StreamChunk) => {
    switch (c.kind) {
      case 'content':
        return c.delta.length;
      case 'stepper-spawned':
        return c.source.stepperId.length + c.goal.length;
      case 'stepper-done':
        return c.ok ? 1 : 0;
      case 'mcp-call':
        return c.source.stepperId.length + c.tool.length;
      case 'mcp-result':
        return c.durationMs;
      case 'tokens-used':
        return c.delta.totalTokens ?? 0;
      case 'llm-call-start':
        return c.model.length;
      case 'llm-call-end':
        return c.durationMs;
    }
  };
  const ref = { stepperId: 'abc', name: 'root' };
  accept({ kind: 'content', delta: 'x' });
  accept({ kind: 'stepper-spawned', source: ref, goal: 'g' });
  accept({ kind: 'stepper-done', source: ref, ok: true });
  accept({ kind: 'mcp-call', source: ref, tool: 'GetProgram' });
  accept({
    kind: 'mcp-result',
    source: ref,
    tool: 'GetProgram',
    durationMs: 10,
  });
  accept({
    kind: 'tokens-used',
    source: ref,
    component: 'interpreter',
    delta: { promptTokens: 1, completionTokens: 1 },
  });
  accept({
    kind: 'llm-call-start',
    source: ref,
    component: 'interpreter',
    model: 'gpt-4o',
  });
  accept({
    kind: 'llm-call-end',
    source: ref,
    component: 'interpreter',
    durationMs: 100,
  });
  assert.equal(typeof accept, 'function');
});
