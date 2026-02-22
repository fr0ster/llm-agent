import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BaseAgent } from '../../../agents/base.js';
import type { MCPClientWrapper } from '../../../mcp/client.js';
import type { Message } from '../../../types.js';
import { LlmAdapter } from '../llm-adapter.js';
import { LlmError } from '../../interfaces/types.js';

// ---------------------------------------------------------------------------
// StubAgent — controlled BaseAgent for testing LlmAdapter
// ---------------------------------------------------------------------------

class StubAgent extends BaseAgent {
  constructor(
    private readonly _resp: { content: string; raw?: unknown },
    private readonly _err?: Error,
  ) {
    // BaseAgent stores mcpClient but never calls it in callLLMWithTools path
    super({ mcpClient: {} as unknown as MCPClientWrapper });
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches BaseAgent signature
  protected async callLLMWithTools(_msgs: Message[], _tools: any[]) {
    if (this._err) throw this._err;
    return this._resp;
  }
}

const USER: Message = { role: 'user', content: 'Hi' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LlmAdapter — success paths', () => {
  it('plain stop — no raw provider payload', async () => {
    const adapter = new LlmAdapter(new StubAgent({ content: 'Hello' }));
    const r = await adapter.chat([USER]);
    assert.ok(r.ok);
    assert.equal(r.value.content, 'Hello');
    assert.equal(r.value.finishReason, 'stop');
    assert.equal(r.value.toolCalls, undefined);
  });

  it('OpenAI format — parses tool_calls', async () => {
    const raw = {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                function: { name: 'get_data', arguments: '{"key":"value"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const adapter = new LlmAdapter(new StubAgent({ content: '', raw }));
    const r = await adapter.chat([USER]);
    assert.ok(r.ok);
    assert.equal(r.value.finishReason, 'tool_calls');
    assert.equal(r.value.toolCalls?.length, 1);
    assert.equal(r.value.toolCalls?.[0].id, 'call_1');
    assert.equal(r.value.toolCalls?.[0].name, 'get_data');
    assert.deepEqual(r.value.toolCalls?.[0].arguments, { key: 'value' });
  });

  it('OpenAI format — malformed JSON arguments → empty object', async () => {
    const raw = {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'call_2', function: { name: 'bad_tool', arguments: 'not-json' } },
            ],
          },
        },
      ],
    };
    const adapter = new LlmAdapter(new StubAgent({ content: '', raw }));
    const r = await adapter.chat([USER]);
    assert.ok(r.ok);
    assert.deepEqual(r.value.toolCalls?.[0].arguments, {});
  });

  it('Anthropic format — parses tool_use blocks', async () => {
    const raw = {
      content: [
        { type: 'text', text: 'Thinking...' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'list_objects',
          input: { bucket: 'my-bucket' },
        },
      ],
      stop_reason: 'tool_use',
    };
    const adapter = new LlmAdapter(new StubAgent({ content: 'Thinking...', raw }));
    const r = await adapter.chat([USER]);
    assert.ok(r.ok);
    assert.equal(r.value.finishReason, 'tool_calls');
    assert.equal(r.value.toolCalls?.length, 1);
    assert.equal(r.value.toolCalls?.[0].id, 'toolu_1');
    assert.deepEqual(r.value.toolCalls?.[0].arguments, { bucket: 'my-bucket' });
  });

  it('Anthropic format — end_turn maps to stop', async () => {
    const raw = {
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
    };
    const adapter = new LlmAdapter(new StubAgent({ content: 'Done.', raw }));
    const r = await adapter.chat([USER]);
    assert.ok(r.ok);
    assert.equal(r.value.finishReason, 'stop');
    assert.equal(r.value.toolCalls, undefined);
  });
});

describe('LlmAdapter — error paths', () => {
  it('provider throws generic Error → wrapped in LlmError', async () => {
    const adapter = new LlmAdapter(
      new StubAgent({ content: '' }, new Error('network timeout')),
    );
    const r = await adapter.chat([USER]);
    assert.ok(!r.ok);
    assert.ok(r.error instanceof LlmError);
    assert.ok(r.error.message.includes('network timeout'));
  });

  it('provider throws LlmError → same instance returned', async () => {
    const original = new LlmError('quota exceeded', 'QUOTA');
    const adapter = new LlmAdapter(new StubAgent({ content: '' }, original));
    const r = await adapter.chat([USER]);
    assert.ok(!r.ok);
    assert.equal(r.error, original);
    assert.equal(r.error.code, 'QUOTA');
  });
});

describe('LlmAdapter — AbortSignal', () => {
  it('pre-aborted signal → ABORTED without calling provider', async () => {
    const adapter = new LlmAdapter(new StubAgent({ content: 'should not reach' }));
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await adapter.chat([USER], undefined, { signal: ctrl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});
