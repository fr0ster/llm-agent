import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentCallOptions } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../../agent.js';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';

test('SmartAgentSubAgent maps stop to complete with partial output and a stopped marker', async () => {
  const stop = new AbortController();
  const hard = new AbortController();
  const agent = {
    async process(_input: unknown, options: AgentCallOptions) {
      assert.equal(options.stopSignal, stop.signal);
      assert.equal(options.signal, hard.signal);
      return {
        ok: true,
        value: { content: 'partial', stopReason: 'stop', stopped: true },
      };
    },
  } as unknown as SmartAgent;
  const result = await new SmartAgentSubAgent('worker', agent).run({
    task: 'work',
    stopSignal: stop.signal,
    signal: hard.signal,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.stopped, true);
  assert.equal(result.output, 'partial');
});

test('SmartAgentSubAgent forwards live tool observers', async () => {
  const counts: number[] = [];
  const selected: number[][] = [];
  const onToolCallCount = (count: number) => {
    counts.push(count);
  };
  const onToolsSelected = (count: number, available: number) => {
    selected.push([count, available]);
  };
  const worker = new SmartAgentSubAgent('worker', {
    maxToolCalls: 40,
    async process(_input, options) {
      assert.equal(options?.onToolCallCount, onToolCallCount);
      assert.equal(options?.onToolsSelected, onToolsSelected);
      options?.onToolCallCount?.(2, 40);
      options?.onToolsSelected?.(3, 10);
      return { ok: true, value: { content: 'done' } };
    },
  });
  await worker.run({ task: 'work', onToolCallCount, onToolsSelected });
  assert.deepEqual(counts, [2]);
  assert.deepEqual(selected, [[3, 10]]);
});
