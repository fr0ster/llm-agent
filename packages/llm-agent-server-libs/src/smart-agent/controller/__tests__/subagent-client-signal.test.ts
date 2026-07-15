import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallOptions, ILlm } from '@mcp-abap-adt/llm-agent';
import { makeSubagentClient } from '../subagent-client.js';

test('makeSubagentClient forwards options (signal) to llm.chat', async () => {
  let seen: CallOptions | undefined;
  const llm = {
    model: 'm',
    chat: async (_m: unknown, _t: unknown, opts?: CallOptions) => {
      seen = opts;
      return { ok: true, value: { content: 'ok', toolCalls: [] } };
    },
    streamChat: async function* () {},
  } as unknown as ILlm;
  const ctrl = new AbortController();
  await makeSubagentClient(llm).send([], [], { signal: ctrl.signal });
  assert.equal(seen?.signal, ctrl.signal);
});
