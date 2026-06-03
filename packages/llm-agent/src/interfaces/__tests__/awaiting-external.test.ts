import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InterpretResult, NodeResult } from '../interpreter.js';
import type { ISubAgentResult } from '../subagent.js';

test('awaiting-external types compile + round-trip', () => {
  const nr: NodeResult = {
    nodeId: 'n0',
    output: '',
    status: 'awaiting-external',
    durationMs: 0,
  };
  const r: ISubAgentResult = {
    output: '',
    status: 'awaiting-external',
    pendingExternalToolCalls: [
      { id: 'ext:0123456789abcdef', name: 'rag_add', arguments: {} },
    ],
  };
  const ir: InterpretResult = {
    nodeResults: { n0: nr },
    ok: true,
    output: '',
    executionOrder: ['n0'],
    pendingExternalToolCalls: r.pendingExternalToolCalls,
  };
  assert.equal(ir.pendingExternalToolCalls?.length, 1);
  assert.equal(nr.status, 'awaiting-external');
  assert.equal(r.status, 'awaiting-external');
});
