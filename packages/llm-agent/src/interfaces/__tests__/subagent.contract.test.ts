import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCallOptions } from '../../../../llm-agent-libs/src/testing/index.js';
import type { ISubAgent, ISubAgentInput, OnPartial } from '../../index.js';

test('ISubAgentInput exposes optional onPartial; absence is the default', async () => {
  const partials: string[] = [];
  const op: OnPartial = (c) => {
    if (c.kind === 'content') partials.push(c.delta);
  };
  const agent: ISubAgent = {
    name: 'stub',
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run(input: ISubAgentInput) {
      input.onPartial?.({ kind: 'content', delta: 'hi' });
      return { output: 'final' };
    },
  };
  await agent.run({
    caller: testCallOptions({ sessionId: 'test-session' }).caller,
    task: 't',
  });
  await agent.run({
    caller: testCallOptions({ sessionId: 'test-session' }).caller,
    task: 't',
    onPartial: op,
  });
  assert.deepEqual(partials, ['hi']);
});
