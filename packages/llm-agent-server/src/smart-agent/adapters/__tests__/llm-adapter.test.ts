import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentStreamChunk, Message } from '@mcp-abap-adt/llm-agent';
import { LlmError } from '@mcp-abap-adt/llm-agent';
import { BaseAgent } from '../../../agents/base.js';
import type { MCPClientWrapper } from '../../../mcp/client.js';
import { LlmAdapter } from '../llm-adapter.js';

// ---------------------------------------------------------------------------
// StubAgent — controlled BaseAgent for testing LlmAdapter
// ---------------------------------------------------------------------------

class StubAgent extends BaseAgent {
  constructor(
    private readonly _resp: { content: string; raw?: unknown },
    private readonly _err?: Error,
    private readonly _streamChunks: Array<
      { content: string; raw?: unknown } | AgentStreamChunk
    > = [],
  ) {
    // BaseAgent stores mcpClient but never calls it in callLLMWithTools path
    super({ mcpClient: {} as unknown as MCPClientWrapper });
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches BaseAgent signature
  protected async callLLMWithTools(_msgs: Message[], _tools: any[]) {
    if (this._err) throw this._err;
    return this._resp;
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches BaseAgent signature
  protected async *streamLLMWithTools(_msgs: Message[], _tools: any[]) {
    if (this._err) throw this._err;
    if (this._streamChunks.length === 0) {
      yield { content: this._resp.content, raw: this._resp.raw };
      return;
    }
    for (const c of this._streamChunks) {
      yield c;
    }
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
              {
                id: 'call_2',
                function: { name: 'bad_tool', arguments: 'not-json' },
              },
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

  it('malformed tool args emits parse diagnostic', async () => {
    const raw = {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_2',
                function: { name: 'bad_tool', arguments: 'not-json' },
              },
            ],
          },
        },
      ],
    };
    const events: Array<{ name: string; data: unknown }> = [];
    const adapter = new LlmAdapter(new StubAgent({ content: '', raw }));
    const r = await adapter.chat([USER], undefined, {
      sessionLogger: {
        logStep(name, data) {
          events.push({ name, data });
        },
      },
    });
    assert.ok(r.ok);
    const diagnostics = events.filter((e) => e.name === 'llm_parse_diagnostic');
    assert.equal(diagnostics.length, 1);
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
    const adapter = new LlmAdapter(
      new StubAgent({ content: 'Thinking...', raw }),
    );
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

  it('stream tool delta without index emits diagnostic and is ignored', async () => {
    const events: Array<{ name: string; data: unknown }> = [];
    const adapter = new LlmAdapter(
      new StubAgent({ content: '' }, undefined, [
        {
          content: '',
          raw: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'c1',
                      function: { name: 'broken', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          },
        },
      ]),
    );
    const chunks: unknown[] = [];
    for await (const chunk of adapter.streamChat([USER], undefined, {
      sessionLogger: {
        logStep(name, data) {
          events.push({ name, data });
        },
      },
    })) {
      chunks.push(chunk);
    }
    const diagnostics = events.filter((e) => e.name === 'llm_parse_diagnostic');
    assert.equal(diagnostics.length, 1);
    assert.equal(
      (chunks[0] as { ok: boolean; value?: { toolCalls?: unknown[] } }).value
        ?.toolCalls,
      undefined,
    );
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
    const adapter = new LlmAdapter(
      new StubAgent({ content: 'should not reach' }),
    );
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await adapter.chat([USER], undefined, { signal: ctrl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});
