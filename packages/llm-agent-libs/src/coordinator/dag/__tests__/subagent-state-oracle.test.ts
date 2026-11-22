import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ISubAgent, ISubAgentInput } from '@mcp-abap-adt/llm-agent';
import { testCallOptions } from '../../../testing/index.js';
import { SubAgentStateOracle } from '../subagent-state-oracle.js';

function stubSubagent(): { sa: ISubAgent; lastInput: { v?: ISubAgentInput } } {
  const lastInput: { v?: ISubAgentInput } = {};
  const sa: ISubAgent = {
    name: 'inspector',
    description: 'reads real state',
    capabilities: { contextPolicy: 'optional' },
    async run(input: ISubAgentInput) {
      lastInput.v = input;
      return {
        output: `answer: ${input.task}`,
        usage: { promptTokens: 9, completionTokens: 1, totalTokens: 10 },
      };
    },
  };
  return { sa, lastInput };
}

test('SubAgentStateOracle maps query→task, output→answer', async () => {
  const { sa, lastInput } = stubSubagent();
  const oracle = new SubAgentStateOracle(sa);
  const res = await oracle.query({
    caller: testCallOptions({ sessionId: 's1' }).caller,
    query: 'is the file deleted',
    sessionId: 's1',
    trace: { traceId: 't1' },
  });
  assert.equal(res.answer, 'answer: is the file deleted');
  assert.equal(lastInput.v?.task, 'is the file deleted');
  assert.equal(lastInput.v?.sessionId, 's1');
  assert.equal(lastInput.v?.trace?.traceId, 't1');
  assert.equal(oracle.name, 'inspector');
});

test('SubAgentStateOracle preserves usage returned by its subagent', async () => {
  const { sa } = stubSubagent();
  const oracle = new SubAgentStateOracle(sa);
  const res = await oracle.query({
    caller: testCallOptions().caller,
    query: 'q',
  });
  assert.deepEqual(res.usage, {
    promptTokens: 9,
    completionTokens: 1,
    totalTokens: 10,
  });
});
