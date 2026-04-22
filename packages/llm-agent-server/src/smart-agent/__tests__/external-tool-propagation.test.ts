import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import type { LlmError, LlmStreamChunk, Result } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SmartAgentServer } from '../server.js';
import { makeDefaultDeps } from '../testing/index.js';

const DEFAULT_CONFIG = { maxIterations: 5 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const options = {
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr !== undefined
          ? { 'Content-Length': Buffer.byteLength(bodyStr) }
          : {}),
      },
    };
    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

function httpStreamRequest(port: number, body: unknown): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const lines = text
          .split('\n')
          .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
          .map((l) => l.slice(6));
        resolve(lines);
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// SmartAgent.process() — external tool call propagation
// ---------------------------------------------------------------------------

describe('External tool propagation — SmartAgent.process()', () => {
  it('returns stopReason=tool_calls and toolCalls when LLM requests external tool', async () => {
    // LLM responds requesting the external tool
    const streamLlm = {
      async chat() {
        return {
          ok: true as const,
          value: {
            content: '',
            toolCalls: [
              {
                id: 'call_ext_1',
                name: 'get_weather',
                arguments: { city: 'Berlin' },
              },
            ],
            finishReason: 'tool_calls' as const,
          },
        };
      },
      async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              {
                id: 'call_ext_1',
                name: 'get_weather',
                arguments: { city: 'Berlin' },
              },
            ],
            finishReason: 'tool_calls',
          },
        };
      },
      async healthCheck() {
        return { ok: true as const, value: true };
      },
    };

    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'unused' }],
    });
    deps.mainLlm = streamLlm;

    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    // Pass external tool definition
    const externalTools = [
      {
        name: 'get_weather',
        description: 'Get weather for a city',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    ];

    const r = await agent.process('What is the weather in Berlin?', {
      externalTools,
    });

    assert.ok(r.ok, 'process() should succeed');
    assert.equal(r.value.stopReason, 'tool_calls');
    assert.ok(r.value.toolCalls, 'toolCalls should be present');
    assert.equal(r.value.toolCalls?.length, 1);
    assert.equal(r.value.toolCalls?.[0].function.name, 'get_weather');
    assert.ok(
      r.value.toolCalls?.[0].function.arguments.includes('Berlin'),
      'arguments should contain Berlin',
    );
  });

  it('streams external tool call deltas to consumer', async () => {
    const streamLlm = {
      async chat() {
        return {
          ok: true as const,
          value: {
            content: '',
            finishReason: 'tool_calls' as const,
            toolCalls: [
              {
                id: 'call_ext_2',
                name: 'search',
                arguments: { q: 'test' },
              },
            ],
          },
        };
      },
      async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              {
                id: 'call_ext_2',
                name: 'search',
                arguments: { q: 'test' },
              },
            ],
            finishReason: 'tool_calls',
          },
        };
      },
      async healthCheck() {
        return { ok: true as const, value: true };
      },
    };

    const { deps } = makeDefaultDeps({ llmResponses: [{ content: 'unused' }] });
    deps.mainLlm = streamLlm;
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    const externalTools = [
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ];

    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of agent.streamProcess('search for test', {
      externalTools,
    })) {
      if (chunk.ok) chunks.push(chunk.value);
    }

    // Should have at least one chunk with toolCalls
    const toolChunks = chunks.filter(
      (c) => c.toolCalls && c.toolCalls.length > 0,
    );
    assert.ok(toolChunks.length > 0, 'should stream tool call deltas');

    // Should have finishReason: 'tool_calls'
    const finishChunk = chunks.find((c) => c.finishReason === 'tool_calls');
    assert.ok(finishChunk, 'should have finishReason: tool_calls');
  });
});

// ---------------------------------------------------------------------------
// SmartAgentServer HTTP — non-streaming
// ---------------------------------------------------------------------------

describe('External tool propagation — SmartAgentServer HTTP non-streaming', () => {
  it('returns finish_reason=tool_calls and tool_calls in response', async () => {
    const streamLlm = {
      async chat() {
        return {
          ok: true as const,
          value: {
            content: '',
            toolCalls: [
              {
                id: 'call_http_1',
                name: 'get_weather',
                arguments: { city: 'Berlin' },
              },
            ],
            finishReason: 'tool_calls' as const,
          },
        };
      },
      async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              {
                id: 'call_http_1',
                name: 'get_weather',
                arguments: { city: 'Berlin' },
              },
            ],
            finishReason: 'tool_calls',
          },
        };
      },
      async healthCheck() {
        return { ok: true as const, value: true };
      },
    };

    const { deps } = makeDefaultDeps({ llmResponses: [{ content: 'unused' }] });
    deps.mainLlm = streamLlm;
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const server = new SmartAgentServer(agent);
    const handle = await server.start();

    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [{ role: 'user', content: 'weather in Berlin' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                },
              },
            },
          ],
        },
      );

      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      const choices = body.choices as Array<Record<string, unknown>>;

      assert.equal(choices[0].finish_reason, 'tool_calls');

      const message = choices[0].message as Record<string, unknown>;
      const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
      assert.ok(toolCalls, 'message should have tool_calls');
      assert.equal(toolCalls.length, 1);
      assert.equal(
        (toolCalls[0].function as Record<string, unknown>).name,
        'get_weather',
      );
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// SmartAgentServer HTTP — streaming SSE
// ---------------------------------------------------------------------------

describe('External tool propagation — SmartAgentServer HTTP streaming', () => {
  it('streams tool_calls deltas and finish_reason=tool_calls via SSE', async () => {
    const streamLlm = {
      async chat() {
        return {
          ok: true as const,
          value: {
            content: '',
            toolCalls: [
              {
                id: 'call_sse_1',
                name: 'get_weather',
                arguments: { city: 'Berlin' },
              },
            ],
            finishReason: 'tool_calls' as const,
          },
        };
      },
      async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              {
                id: 'call_sse_1',
                name: 'get_weather',
                arguments: { city: 'Berlin' },
              },
            ],
            finishReason: 'tool_calls',
          },
        };
      },
      async healthCheck() {
        return { ok: true as const, value: true };
      },
    };

    const { deps } = makeDefaultDeps({ llmResponses: [{ content: 'unused' }] });
    deps.mainLlm = streamLlm;
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const server = new SmartAgentServer(agent);
    const handle = await server.start();

    try {
      const sseLines = await httpStreamRequest(handle.port, {
        messages: [{ role: 'user', content: 'weather in Berlin' }],
        stream: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather for a city',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
              },
            },
          },
        ],
      });

      const parsed = sseLines.map((l) => JSON.parse(l));

      // Find chunk with tool_calls in delta
      const toolChunk = parsed.find((p: Record<string, unknown>) => {
        const choices = p.choices as Array<Record<string, unknown>>;
        if (!choices || choices.length === 0) return false;
        const delta = choices[0].delta as Record<string, unknown>;
        return delta?.tool_calls !== undefined;
      });
      assert.ok(toolChunk, 'SSE should contain a chunk with tool_calls delta');

      const delta = (toolChunk.choices as Array<Record<string, unknown>>)[0]
        .delta as Record<string, unknown>;
      const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
      assert.equal(toolCalls.length, 1);
      assert.equal(
        (toolCalls[0].function as Record<string, unknown>).name,
        'get_weather',
      );

      // Find finish_reason chunk
      const finishChunk = parsed.find((p: Record<string, unknown>) => {
        const choices = p.choices as Array<Record<string, unknown>>;
        return choices?.[0]?.finish_reason === 'tool_calls';
      });
      assert.ok(finishChunk, 'SSE should contain finish_reason: tool_calls');
    } finally {
      await handle.close();
    }
  });
});
