import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summaryToUsage } from '../session-request-logger.js';

test('summaryToUsage sums all components into prompt/completion/total', () => {
  const usage = summaryToUsage({
    byModel: {},
    byCategory: {},
    ragQueries: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    byComponent: {
      'tool-loop': {
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        requests: 1,
      },
      translate: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
        requests: 1,
      },
    },
  });
  assert.deepEqual(usage, {
    promptTokens: 110,
    completionTokens: 44,
    totalTokens: 154,
  });
});
