import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SmartAgent } from '../../agent.js';
import { testCallOptions } from '../../testing/index.js';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';

test('SmartAgentSubAgent forwards input.sessionLogger into agent.process options', async () => {
  let seenSessionLogger: unknown;
  const fakeAgent = {
    process: async (
      _prompt: string,
      opts?: { sessionLogger?: { logStep(name: string, data: unknown): void } },
    ) => {
      seenSessionLogger = opts?.sessionLogger;
      return {
        ok: true as const,
        value: { content: 'ok', toolCalls: undefined, usage: undefined },
      };
    },
  } as unknown as SmartAgent;

  const sessionLogger = { logStep: (_n: string, _d: unknown) => {} };
  const sub = new SmartAgentSubAgent('w', fakeAgent);
  await sub.run({
    caller: testCallOptions({ sessionId: 's1' }).caller,
    task: 'do',
    sessionId: 's1',
    sessionLogger,
  });
  assert.equal(seenSessionLogger, sessionLogger);
});
