import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnPartial, StreamChunk } from '../streaming.js';

test('StreamChunk discriminated union accepts every kind', () => {
  const accept: OnPartial = (c: StreamChunk) => {
    switch (c.kind) {
      case 'content':
        return c.delta.length;
      case 'tool-call':
        return c.name.length;
      case 'node-start':
        return c.nodeId.length + c.goal.length;
      case 'node-end':
        return c.ok ? 1 : 0;
    }
  };
  accept({ kind: 'content', delta: 'x' });
  accept({ kind: 'tool-call', name: 'GetProgram' });
  accept({ kind: 'node-start', nodeId: 'a', goal: 'g' });
  accept({ kind: 'node-end', nodeId: 'a', ok: true });
  assert.equal(typeof accept, 'function');
});
