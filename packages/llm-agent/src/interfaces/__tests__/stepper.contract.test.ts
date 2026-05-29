import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Budget,
  type IStepper,
  type IStepperInput,
  type IStepperResult,
  type RunIdentity,
  TokenLedger,
  type ToolSafetyPolicy,
} from '../stepper.js';

test('Stepper core types: minimal IStepper compiles and runs', async () => {
  const identity: RunIdentity = {
    traceId: 't',
    turnId: 'u',
    sessionId: 's',
    stepperId: 'n0',
  };
  const toolSafety: ToolSafetyPolicy = {
    mutationPolicy: 'confirm',
    knownReadOnlyTools: new Set(['GetProgram']),
  };
  const budget: Budget = { depthRemaining: 3, tokens: new TokenLedger(100000) };
  const stub: IStepper = {
    name: 'stub',
    async run(input: IStepperInput): Promise<IStepperResult> {
      assert.equal(input.identity.stepperId, 'n0');
      assert.equal(input.toolSafety.knownReadOnlyTools.has('GetProgram'), true);
      input.budget.tokens.spend({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
      return {
        status: 'ok',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  };
  const res = await stub.run({
    prompt: 'p',
    knowledgeRag: {} as never,
    toolsRag: {} as never,
    budget,
    identity,
    toolSafety,
  });
  assert.equal(res.status, 'ok');
  assert.equal(budget.tokens.remaining, 99985); // shared ledger decremented
});

test('TokenLedger.exhausted flips when remaining hits zero', () => {
  const l = new TokenLedger(20);
  assert.equal(l.exhausted(), false);
  l.spend({ promptTokens: 20, completionTokens: 0, totalTokens: 20 });
  assert.equal(l.exhausted(), true);
});
