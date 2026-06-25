import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it, test } from 'node:test';
import { SmartServer, writeNotReady } from '../smart-server.js';

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('writeNotReady writes a 503 service_unavailable JSON error', () => {
  const written: { code?: number; body?: string } = {};
  const res = {
    writeHead(code: number) {
      written.code = code;
      return res;
    },
    end(b?: string) {
      written.body = b;
    },
  };
  writeNotReady(res as never);
  assert.equal(written.code, 503);
  assert.match(written.body ?? '', /service_unavailable/);
  assert.match(written.body ?? '', /not ready/i);
});

describe('readiness gate — MCP unreachable ⇒ NOT_READY', () => {
  it('GET /health → 503 ready:false and POST /v1/chat/completions → 503 (pre-dispatch)', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      // Unreachable MCP → the connection strategy never connects → not ready.
      mcp: { type: 'http', url: 'http://127.0.0.1:7779/mcp/stream/http' },
    });
    const handle = await server.start();
    try {
      const health = await httpRequest(handle.port, 'GET', '/health');
      assert.equal(health.status, 503, '/health is 503 when MCP is down');
      assert.equal(JSON.parse(health.body).ready, false);

      const chat = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      );
      assert.equal(chat.status, 503, 'chat is gated 503 pre-dispatch');
      assert.match(chat.body, /service_unavailable/);
    } finally {
      await handle.close();
    }
  });
});
