import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TokenUsage } from './interfaces/types.js';
import { addTokenUsage } from './token-usage.js';

const a: TokenUsage = {
  promptTokens: 2,
  completionTokens: 3,
  totalTokens: 5,
  models: {
    a: { promptTokens: 2, completionTokens: 3, totalTokens: 5, requests: 1 },
  },
};
test('addTokenUsage preserves absence and copies a single operand deeply', () => {
  assert.equal(addTokenUsage(), undefined);
  for (const copy of [addTokenUsage(a), addTokenUsage(undefined, a)]) {
    assert.deepEqual(copy, a);
    assert.notEqual(copy, a);
    assert.notEqual(copy?.models, a.models);
    assert.notEqual(copy?.models?.a, a.models?.a);
  }
});
test('addTokenUsage sums totals, shared models and requests, retaining distinct models', () => {
  const b: TokenUsage = {
    promptTokens: 4,
    completionTokens: 6,
    totalTokens: 10,
    models: {
      a: { promptTokens: 2, completionTokens: 3, totalTokens: 5, requests: 2 },
      b: { promptTokens: 2, completionTokens: 3, totalTokens: 5, requests: 1 },
    },
  };
  assert.deepEqual(addTokenUsage(a, b), {
    promptTokens: 6,
    completionTokens: 9,
    totalTokens: 15,
    models: {
      a: { promptTokens: 4, completionTokens: 6, totalTokens: 10, requests: 3 },
      b: b.models?.b,
    },
  });
  assert.equal(a.models?.a.requests, 1);
  assert.equal(
    addTokenUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
      ?.models,
    undefined,
  );
});

test('cache reads and creations survive totals and per-model aggregation without double-counting input', () => {
  const cached = {
    ...a,
    cachedInputTokens: 1,
    cacheCreationInputTokens: 2,
    models: {
      a: {
        ...a.models?.a,
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
        requests: 1,
        cachedInputTokens: 1,
        cacheCreationInputTokens: 2,
      },
    },
  };
  const sum = addTokenUsage(cached, cached);
  assert.equal(sum?.cachedInputTokens, 2);
  assert.equal(sum?.cacheCreationInputTokens, 4);
  assert.equal(sum?.models?.a.cachedInputTokens, 2);
  assert.equal(sum?.models?.a.cacheCreationInputTokens, 4);
  assert.equal(sum?.totalTokens, 10);
  assert.equal(addTokenUsage(a)?.cachedInputTokens, undefined);
  assert.equal(addTokenUsage(a)?.cacheCreationInputTokens, undefined);
});
