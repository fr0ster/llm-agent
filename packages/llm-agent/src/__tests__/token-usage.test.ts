import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTokenUsage } from '../token-usage.js';

test('addTokenUsage preserves and sums reasoning tokens in totals and model entries', () => {
  const usage = { promptTokens: 2, completionTokens: 5, totalTokens: 7 };
  const withReasoning = {
    ...usage,
    reasoningTokens: 3,
    models: { model: { ...usage, reasoningTokens: 3, requests: 1 } },
  };

  assert.deepEqual(addTokenUsage(undefined, withReasoning), withReasoning);
  const sum = addTokenUsage(withReasoning, withReasoning);
  assert.equal(sum?.reasoningTokens, 6);
  assert.equal(sum?.models?.model.reasoningTokens, 6);
  assert.equal(sum?.totalTokens, 14);
  assert.equal(addTokenUsage(withReasoning, usage)?.reasoningTokens, 3);
  assert.equal(addTokenUsage(usage, withReasoning)?.reasoningTokens, 3);
  assert.equal(
    addTokenUsage(usage, { ...usage, reasoningTokens: 0 })?.reasoningTokens,
    0,
  );
  assert.deepEqual(addTokenUsage(undefined, usage), usage);
});
