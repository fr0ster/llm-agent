import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ISubAgentResult, StopReason } from './index.js';

// These exhaustive switches deliberately contain only origin/main members.
function stopReason(reason: StopReason): string {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
    case 'iteration_limit':
    case 'tool_call_limit':
      return reason;
    default:
      return reason satisfies never;
  }
}
function status(value: ISubAgentResult['status']): string | undefined {
  switch (value) {
    case undefined:
    case 'complete':
    case 'awaiting-external':
      return value;
    default:
      return value satisfies never;
  }
}
test('original public union members remain exhaustive', () => {
  assert.equal(stopReason('stop'), 'stop');
  assert.equal(status('complete'), 'complete');
});
