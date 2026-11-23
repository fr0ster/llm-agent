// src/smart-agent/__tests__/chat-endpoint.test.ts
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import type { CallOptions, ILlm } from '@mcp-abap-adt/llm-agent';
import { LlmError, MODEL_CONTEXT_EXCEEDED } from '@mcp-abap-adt/llm-agent';
import { makeLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import { constructionSeams } from './construction-seams.js';
import { TestSmartServer as SmartServer } from './rag-identity-fixture.js';

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = request(
      {
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
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

function makeServer() {
  return new SmartServer(
    {
      port: 0,
      llm: { provider: 'deepseek', model: 'test-model' },
      skipModelValidation: true,
    },
    {
      ...constructionSeams,
      makeLlm: async () => makeLlm([{ content: 'hello there' }]),
    },
  );
}

for (const thrown of [false, true]) {
  it(`/health preserves ${thrown ? 'thrown' : 'returned'} context overflow from the chat probe`, async () => {
    let calls = 0;
    const error = new LlmError('Prompt is too long', MODEL_CONTEXT_EXCEEDED);
    const llm: ILlm = {
      ...makeLlm([]),
      healthCheck: undefined,
      async chat() {
        calls++;
        if (thrown) throw error;
        return { ok: false, error };
      },
    };
    const server = new SmartServer(
      {
        port: 0,
        llm: { provider: 'deepseek', model: 'test-model' },
        skipModelValidation: true,
      },
      { ...constructionSeams, makeLlm: async () => llm },
    );
    const handle = await server.start();
    try {
      const result = await httpRequest(handle.port, 'GET', '/health');
      assert.equal(calls, 1);
      assert.equal(result.status, 400);
      assert.match(result.raw, /"code":"MODEL_CONTEXT_EXCEEDED"/);
    } finally {
      await handle.close();
    }
  });
}

for (const path of ['/v1/chat/completions', '/v1/messages']) {
  for (const stream of [false, true]) {
    for (const thrown of [false, true]) {
      for (const code of [MODEL_CONTEXT_EXCEEDED, 'LLM_ERROR']) {
        it(`${path} handles ${thrown ? 'thrown' : 'returned'} ${code} (stream=${stream})`, async () => {
          let calls = 0;
          const failure = new LlmError('Request failed', code);
          const error = Object.assign(new LlmError('Provider wrapper'), {
            cause: failure,
          });
          const llm: ILlm = {
            ...makeLlm([]),
            async chat() {
              calls++;
              if (code !== MODEL_CONTEXT_EXCEEDED) {
                return {
                  ok: true,
                  value: { content: 'Fallback answer', finishReason: 'stop' },
                };
              }
              if (thrown) throw error;
              return { ok: false, error };
            },
            async *streamChat() {
              calls++;
              if (thrown) throw error;
              yield { ok: false, error };
            },
          };
          const server = new SmartServer(
            {
              port: 0,
              llm: { provider: 'deepseek', model: 'test-model' },
              skipModelValidation: true,
              agent: {
                classificationEnabled: false,
                llmCallStrategy: 'fallback',
              },
            },
            { ...constructionSeams, makeLlm: async () => llm },
          );
          const handle = await server.start();
          try {
            const result = await httpRequest(handle.port, 'POST', path, {
              model: 'test-model',
              max_tokens: 128,
              messages: [{ role: 'user', content: 'hi' }],
              stream,
            });
            if (code !== MODEL_CONTEXT_EXCEEDED) {
              assert.equal(calls, 2);
              assert.equal(result.status, 200);
              assert.match(result.raw, /Fallback answer/);
              return;
            }
            assert.equal(calls, 1);
            assert.equal(result.status, stream ? 200 : 400);
            assert.match(result.raw, /"code":"MODEL_CONTEXT_EXCEEDED"/);
            assert.doesNotMatch(
              result.raw,
              /"finish_reason":"stop"|"stop_reason":"end_turn"/,
            );
          } finally {
            await handle.close();
          }
        });
      }
    }
  }
}

describe('SmartServer — POST /v1/chat/completions (handler body)', () => {
  it('returns an OpenAI chat.completion for a non-streaming request', async () => {
    const handle = await makeServer().start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [{ role: 'user', content: 'hi' }],
        },
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.raw) as {
        object: string;
        choices: Array<{ message: { role: string; content: string } }>;
      };
      assert.equal(body.object, 'chat.completion');
      assert.equal(body.choices[0].message.role, 'assistant');
      assert.equal(body.choices[0].message.content, 'hello there');
    } finally {
      await handle.close();
    }
  });

  it('streams SSE chunks ending with [DONE] for a streaming request', async () => {
    const handle = await makeServer().start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
      );
      assert.equal(res.status, 200);
      assert.ok(res.raw.includes('"object":"chat.completion.chunk"'));
      assert.ok(res.raw.trimEnd().endsWith('data: [DONE]'));
    } finally {
      await handle.close();
    }
  });

  it('returns 400 when no message has role "user"', async () => {
    const handle = await makeServer().start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [{ role: 'assistant', content: 'hi' }],
        },
      );
      assert.equal(res.status, 400);
      // The JSON body escapes the quotes: 'at least one message with role \"user\" is required'
      assert.ok(res.raw.includes('at least one message with role'));
    } finally {
      await handle.close();
    }
  });
});

for (const stream of [false, true]) {
  for (const promptCaching of [undefined, false, true]) {
    it(`HTTP cache options reach the working model stream=${stream} caching=${promptCaching}`, async () => {
      let seen: CallOptions | undefined;
      const base = makeLlm([{ content: 'hello' }]);
      const recording: ILlm = {
        ...base,
        async chat(messages, tools, options) {
          seen = options;
          return base.chat(messages, tools, options);
        },
        async *streamChat(messages, tools, options) {
          seen = options;
          yield* base.streamChat(messages, tools, options);
        },
      };
      const server = new SmartServer(
        {
          port: 0,
          llm: { provider: 'anthropic', model: 'test-model' },
          skipModelValidation: true,
        },
        { ...constructionSeams, makeLlm: async () => recording },
      );
      const handle = await server.start();
      try {
        const result = await httpRequest(
          handle.port,
          'POST',
          '/v1/chat/completions',
          {
            messages: [{ role: 'user', content: 'hi' }],
            stream,
            promptCaching,
            prompt_cache_key: 'stable',
            prompt_cache_retention: '24h',
          },
        );
        assert.equal(result.status, 200);
        assert.equal(seen?.promptCaching, promptCaching);
        assert.ok(seen && !('promptCacheKey' in seen));
        assert.ok(seen && !('promptCacheRetention' in seen));
        for (const value of ['off', '5m', '1h', 'true', 'false', 0, null]) {
          const invalid = await httpRequest(
            handle.port,
            'POST',
            '/v1/chat/completions',
            {
              messages: [{ role: 'user', content: 'hi' }],
              stream,
              promptCaching: value,
            },
          );
          assert.equal(invalid.status, 400);
          assert.match(invalid.raw, /promptCaching must be a boolean/);
        }
      } finally {
        await handle.close();
      }
    });
  }
}
