import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InterpretContext, OnPartial } from '../../index.js';

test('InterpretContext exposes optional onPartial', () => {
  const op: OnPartial = () => {};
  const ctx: InterpretContext = {
    inputText: 'x',
    workers: new Map(),
    sessionId: 's',
    errorStrategy: { onNodeFailure: 'abort' },
    onPartial: op,
  };
  assert.equal(typeof ctx.onPartial, 'function');
});
