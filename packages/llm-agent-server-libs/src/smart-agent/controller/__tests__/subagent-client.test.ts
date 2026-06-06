import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { makeSubagentClient } from '../subagent-client.js';

// Real LlmToolCall shape: { id: string; name: string; arguments: Record<string, unknown> }
// LlmError is a class extending Error — fake as plain object with message property
const llm = (resp: unknown): ILlm =>
  ({
    model: 's',
    chat: async () => resp as never,
    streamChat: async function* () {},
  }) as ILlm;

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
    const c = makeSubagentClient(
      llm({ ok: false, error: { message: 'boom' } }),
    );
    assert.deepEqual(await c.send([{ role: 'user', content: 'hi' }]), {
      kind: 'error',
      error: 'boom',
    });
  });
});
