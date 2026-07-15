import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IStepBudget,
  IStepExecutionControl,
  StepControlDecision,
} from '@mcp-abap-adt/llm-agent';

test('IStepExecutionControl / IStepBudget shape compiles', () => {
  const ctrl = new AbortController();
  const budget: IStepBudget = {
    signal: ctrl.signal,
    shouldContinueRound: () => ({ continue: true }),
    canExecuteTool: (s) =>
      s.toolCallCount + 1 > 3
        ? { continue: false, reason: 'maxToolCalls' }
        : { continue: true },
    dispose: () => {},
  };
  const control: IStepExecutionControl = { beginStep: () => budget };
  const d: StepControlDecision = budget.canExecuteTool({
    round: 0,
    toolCallCount: 3,
    elapsedMs: 0,
  });
  assert.equal(d.continue, false);
  assert.equal(typeof control.beginStep, 'function');
});
