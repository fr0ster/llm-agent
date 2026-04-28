// src/smart-agent/__tests__/smart-server-api-adapters.test.ts
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import type {
  LlmStreamChunk,
  OrchestratorError,
  Result,
  SmartAgentResponse,
} from '@mcp-abap-adt/llm-agent';
import type {
  ApiRequestContext,
  ApiSseEvent,
  ILlmApiAdapter,
  NormalizedRequest,
} from '@mcp-abap-adt/llm-agent';
import { SmartServer } from '../smart-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; raw: string }> {
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
        resolve({ status: res.statusCode ?? 0, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

function makeFakeAdapter(overrides?: Partial<ILlmApiAdapter>): ILlmApiAdapter {
  return {
    name: 'anthropic',
    normalizeRequest(req: unknown): NormalizedRequest {
      const r = req as Record<string, unknown>;
      return {
        messages: [{ role: 'user', content: String(r.prompt ?? 'hello') }],
        stream: false,
        context: { adapterName: 'anthropic', protocol: { model: r.model } },
      };
    },
    async *transformStream(
      _source: AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>,
      _ctx: ApiRequestContext,
    ): AsyncIterable<ApiSseEvent> {},
    formatResult(_res: SmartAgentResponse, _ctx: ApiRequestContext): unknown {
      return {
        type: 'message',
        content: [{ type: 'text', text: _res.content }],
      };
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmartServer — Anthropic /v1/messages route', () => {
  it('returns 404 when Anthropic adapter is disabled', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test-key' },
      skipModelValidation: true,
      disableBuiltInAdapters: true,
      apiAdapters: [],
    });

    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'POST', '/v1/messages', {
        model: 'claude-3',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(res.status, 404);
      const body = res.body as { error?: { message?: string } };
      assert.ok(body.error?.message?.includes('not registered'));
    } finally {
      await handle.close();
    }
  });

  it('returns 400 for invalid JSON on /v1/messages', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test-key' },
      skipModelValidation: true,
      apiAdapters: [makeFakeAdapter()],
    });

    const handle = await server.start();
    try {
      // Send raw invalid JSON
      const res = await new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: handle.port,
              method: 'POST',
              path: '/v1/messages',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength('{invalid'),
              },
            },
            (resp) => {
              const chunks: Buffer[] = [];
              resp.on('data', (c: Buffer) => chunks.push(c));
              resp.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed: unknown;
                try {
                  parsed = JSON.parse(text);
                } catch {
                  parsed = text;
                }
                resolve({ status: resp.statusCode ?? 0, body: parsed });
              });
            },
          );
          req.on('error', reject);
          req.write('{invalid');
          req.end();
        },
      );

      assert.equal(res.status, 400);
      const body = res.body as { error?: { message?: string } };
      assert.ok(body.error?.message?.includes('Invalid JSON'));
    } finally {
      await handle.close();
    }
  });

  it('routes /messages (without /v1 prefix) to Anthropic adapter', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test-key' },
      skipModelValidation: true,
      disableBuiltInAdapters: true,
      apiAdapters: [],
    });

    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'POST', '/messages', {
        model: 'claude-3',
        messages: [{ role: 'user', content: 'hi' }],
      });
      // Should hit the route (404 because adapter not registered, not 404 "Cannot POST")
      assert.equal(res.status, 404);
      const body = res.body as { error?: { message?: string } };
      assert.ok(body.error?.message?.includes('not registered'));
    } finally {
      await handle.close();
    }
  });
});
