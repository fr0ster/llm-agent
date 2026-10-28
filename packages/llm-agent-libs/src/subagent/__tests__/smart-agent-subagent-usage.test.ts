import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TokenUsage } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../../agent.js';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';

test('SmartAgentSubAgent retains per-model usage including requests', async () => {
  const usage: TokenUsage = {
    promptTokens: 2,
    completionTokens: 3,
    totalTokens: 5,
    models: {
      model: {
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
        requests: 2,
      },
    },
  };
  const agent: Pick<SmartAgent, 'process' | 'maxToolCalls'> = {
    maxToolCalls: 10,
    async process() {
      return {
        ok: true,
        value: {
          content: 'ok',
          iterations: 1,
          toolCallCount: 0,
          stopReason: 'stop',
          usage,
        },
      };
    },
  };
  assert.deepEqual(
    (await new SmartAgentSubAgent('w', agent).run({ task: 'work' })).usage,
    usage,
  );
});

test('SmartAgentSubAgent forwards the tool-call count callback', async () => {
  const onToolCallCount = (_count: number, _max?: number): void => {};
  const agent: Pick<SmartAgent, 'process' | 'maxToolCalls'> = {
    maxToolCalls: 40,
    async process(_input, options) {
      assert.equal(options?.onToolCallCount, onToolCallCount);
      return {
        ok: true,
        value: {
          content: 'ok',
          iterations: 1,
          toolCallCount: 0,
          stopReason: 'stop',
        },
      };
    },
  };
  await new SmartAgentSubAgent('w', agent).run({
    task: 'work',
    onToolCallCount,
  });
});
