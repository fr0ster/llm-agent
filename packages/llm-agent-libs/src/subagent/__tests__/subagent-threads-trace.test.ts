import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SmartAgent } from '../../agent.js';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';

test('SmartAgentSubAgent forwards input.trace into agent.process options', async () => {
  let seenTrace: unknown;
  const fakeAgent = {
    process: async (
      _prompt: string,
      opts?: { trace?: { traceId: string } },
    ) => {
      seenTrace = opts?.trace;
      return {
        ok: true as const,
        value: { content: 'ok', toolCalls: undefined, usage: undefined },
      };
    },
  } as unknown as SmartAgent;

  const sub = new SmartAgentSubAgent('w', fakeAgent);
  await sub.run({
    task: 'do',
    sessionId: 's1',
    trace: { traceId: 'trace-123' },
  });
  assert.deepEqual(seenTrace, { traceId: 'trace-123' });
});
