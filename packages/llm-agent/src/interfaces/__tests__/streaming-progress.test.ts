import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StepperRef, StreamChunk } from '../streaming.js';

test('StreamChunk progress variants carry StepperRef', () => {
  const ref: StepperRef = {
    stepperId: 's1',
    parentStepperId: 's0',
    name: 'security',
  };
  const accept = (c: StreamChunk): string => {
    switch (c.kind) {
      case 'content':
        return c.delta;
      case 'stepper-spawned':
        return c.source.stepperId + c.goal;
      case 'stepper-done':
        return c.source.stepperId + String(c.ok);
      case 'mcp-call':
        return c.source.stepperId + c.tool;
      case 'mcp-result':
        return c.source.stepperId + c.tool;
      case 'tokens-used':
        return c.source.stepperId + c.component;
      case 'llm-call-start':
        return c.source.stepperId + c.model;
      case 'llm-call-end':
        return c.source.stepperId + String(c.durationMs);
      default:
        return '';
    }
  };
  assert.equal(
    accept({ kind: 'stepper-spawned', source: ref, goal: 'g' }),
    's1g',
  );
  assert.equal(
    accept({ kind: 'mcp-call', source: ref, tool: 'GetProgram' }),
    's1GetProgram',
  );
  assert.equal(accept({ kind: 'content', delta: 'hi' }), 'hi');
});
