// src/smart-agent/__tests__/chat-endpoint.test.ts
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import { makeLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import { SmartServer } from '../smart-server.js';

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
      llm: { provider: 'deepseek', apiKey: 'test-key', model: 'test-model' },
      skipModelValidation: true,
    },
    { makeLlm: async () => makeLlm([{ content: 'hello there' }]) },
  );
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
