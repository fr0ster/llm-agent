import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ILlm,
  LlmError,
  type LlmResponse,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { makeSubagentClient } from '../subagent-client.js';

const llm = (resp: Result<LlmResponse, LlmError>): ILlm => ({
  model: 's',
  chat: async () => resp,
  streamChat: async function* () {},
});

describe('makeSubagentClient', () => {
  it('content response → kind:content', async () => {
    const c = makeSubagentClient(
      llm({
        ok: true,
        value: { content: 'hello', toolCalls: [], finishReason: 'stop' },
      }),
    );
    assert.deepEqual(await c.send([{ role: 'user', content: 'hi' }]), {
      kind: 'content',
      content: 'hello',
    });
  });

  it('tool_calls response → kind:tool_call', async () => {
    const tc = [{ id: 'x', name: 'f', arguments: {} }];
    const c = makeSubagentClient(
      llm({
        ok: true,
        value: { content: '', toolCalls: tc, finishReason: 'tool_calls' },
      }),
    );
    const r = await c.send([{ role: 'user', content: 'hi' }]);
    assert.equal(r.kind, 'tool_call');
  });

  it('error result → kind:error', async () => {
    const error = new LlmError('boom');
    const c = makeSubagentClient(llm({ ok: false, error }));
    assert.deepEqual(await c.send([{ role: 'user', content: 'hi' }]), {
      kind: 'error',
      error,
    });
  });
});
