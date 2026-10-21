import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../../agent.js';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';

for (const history of [
  undefined,
  [],
  [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'reply' },
  ] as Message[],
]) {
  test(`worker history ${history?.length ?? 'undefined'}`, async () => {
    let actual: unknown;
    const agent = {
      async process(input: unknown) {
        actual = input;
        return { ok: true, value: { content: 'done' } };
      },
    } as unknown as SmartAgent;
    await new SmartAgentSubAgent('worker', agent).run({
      task: 'request',
      context: 'context',
      history,
    });
    assert.deepEqual(
      actual,
      history?.length
        ? [...history, { role: 'user', content: 'context\n\nrequest' }]
        : 'context\n\nrequest',
    );
  });
}
