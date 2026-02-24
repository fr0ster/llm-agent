import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import {
  OrchestratorError,
  type SmartAgent,
  type SmartAgentResponse,
} from '../agent.js';
import type { CallOptions } from '../interfaces/types.js';
import { SmartAgentServer } from '../server.js';

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

function makeAgent(
  result: SmartAgentResponse | OrchestratorError,
  capture?: { text?: string },
): SmartAgent {
  return {
    async process(text: string, _opts?: CallOptions) {
      if (capture) {
        capture.text = text;
      }
      if (result instanceof OrchestratorError) {
        return { ok: false as const, error: result };
      }
      return { ok: true as const, value: result };
    },
  } as unknown as SmartAgent;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('SmartAgentServer — happy path', () => {
  it('POST → 200 with correct OpenAI format', async () => {
    const agent = makeAgent({
      content: 'Hello!',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    });
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [{ role: 'user', content: 'Hi' }],
        },
      );
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      assert.equal(body.object, 'chat.completion');
      const choices = body.choices as Array<Record<string, unknown>>;
      assert.equal(choices[0].finish_reason, 'stop');
      const message = choices[0].message as Record<string, unknown>;
      assert.equal(message.content, 'Hello!');
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// finish_reason
// ---------------------------------------------------------------------------

describe('SmartAgentServer — finish_reason: iteration_limit → length', () => {
  it('stopReason=iteration_limit maps to finish_reason=length', async () => {
    const agent = makeAgent({
      content: 'partial',
      iterations: 5,
      toolCallCount: 0,
      stopReason: 'iteration_limit',
    });
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [{ role: 'user', content: 'test' }],
        },
      );
      const body = res.body as Record<string, unknown>;
      const choices = body.choices as Array<Record<string, unknown>>;
      assert.equal(choices[0].finish_reason, 'length');
    } finally {
      await handle.close();
    }
  });
});

describe('SmartAgentServer — finish_reason: tool_call_limit → length', () => {
  it('stopReason=tool_call_limit maps to finish_reason=length', async () => {
    const agent = makeAgent({
      content: 'partial',
      iterations: 2,
      toolCallCount: 10,
      stopReason: 'tool_call_limit',
    });
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [{ role: 'user', content: 'test' }],
        },
      );
      const body = res.body as Record<string, unknown>;
      const choices = body.choices as Array<Record<string, unknown>>;
      assert.equal(choices[0].finish_reason, 'length');
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

describe('SmartAgentServer — text extraction: single user message', () => {
  it('passes user message content to agent.process()', async () => {
    const capture: { text?: string } = {};
    const agent = makeAgent(
      { content: 'ok', iterations: 1, toolCallCount: 0, stopReason: 'stop' },
      capture,
    );
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      await httpRequest(handle.port, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'What is the weather?' }],
      });
      assert.equal(capture.text, 'What is the weather?');
    } finally {
      await handle.close();
    }
  });
});

describe('SmartAgentServer — text extraction: multi-message → last user message', () => {
  it('passes last user message content to agent.process()', async () => {
    const capture: { text?: string } = {};
    const agent = makeAgent(
      { content: 'ok', iterations: 1, toolCallCount: 0, stopReason: 'stop' },
      capture,
    );
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      await httpRequest(handle.port, 'POST', '/v1/chat/completions', {
        messages: [
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
          { role: 'user', content: 'Second question' },
        ],
      });
      assert.equal(capture.text, 'Second question');
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('SmartAgentServer — validation: missing messages field → 400', () => {
  it('returns 400 with invalid_request_error', async () => {
    const agent = makeAgent({
      content: 'ok',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    });
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          model: 'gpt-4',
        },
      );
      assert.equal(res.status, 400);
      const body = res.body as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      assert.equal(error.type, 'invalid_request_error');
    } finally {
      await handle.close();
    }
  });
});

describe('SmartAgentServer — validation: empty messages array → 400', () => {
  it('returns 400 for empty messages array', async () => {
    const agent = makeAgent({
      content: 'ok',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    });
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [],
        },
      );
      assert.equal(res.status, 400);
    } finally {
      await handle.close();
    }
  });
});

describe('SmartAgentServer — validation: no user message → 400', () => {
  it('returns 400 when no message has role=user', async () => {
    const agent = makeAgent({
      content: 'ok',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    });
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [
            { role: 'system', content: 'You are a helpful assistant' },
          ],
        },
      );
      assert.equal(res.status, 400);
    } finally {
      await handle.close();
    }
  });
});

describe('SmartAgentServer — validation: invalid JSON body → 400', () => {
  it('returns 400 for malformed JSON', async () => {
    const agent = makeAgent({
      content: 'ok',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    });
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const rawBody = 'not valid json';
      const res = await new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: handle.port,
              method: 'POST',
              path: '/v1/chat/completions',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(rawBody),
              },
            },
            (innerRes) => {
              const chunks: Buffer[] = [];
              innerRes.on('data', (chunk: Buffer) => chunks.push(chunk));
              innerRes.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed: unknown;
                try {
                  parsed = JSON.parse(text);
                } catch {
                  parsed = text;
                }
                resolve({ status: innerRes.statusCode ?? 0, body: parsed });
              });
            },
          );
          req.on('error', reject);
          req.write(rawBody);
          req.end();
        },
      );
      assert.equal(res.status, 400);
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('SmartAgentServer — routing: GET /v1/chat/completions → 405', () => {
  it('returns 405 for GET method', async () => {
    const agent = makeAgent({
      content: 'ok',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    });
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'GET', '/v1/chat/completions');
      assert.equal(res.status, 405);
    } finally {
      await handle.close();
    }
  });
});

describe('SmartAgentServer — routing: POST /unknown → 404', () => {
  it('returns 404 for unknown path', async () => {
    const agent = makeAgent({
      content: 'ok',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    });
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'POST', '/unknown', {});
      assert.equal(res.status, 404);
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Agent errors
// ---------------------------------------------------------------------------

describe('SmartAgentServer — agent error: ABORTED → 500', () => {
  it('returns 500 with error.code=ABORTED', async () => {
    const agent = makeAgent(
      new OrchestratorError('Request aborted', 'ABORTED'),
    );
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [{ role: 'user', content: 'test' }],
        },
      );
      assert.equal(res.status, 500);
      const body = res.body as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      assert.equal(error.code, 'ABORTED');
    } finally {
      await handle.close();
    }
  });
});

describe('SmartAgentServer — agent error: LLM_ERROR → 500', () => {
  it('returns 500 with error.code=LLM_ERROR', async () => {
    const agent = makeAgent(new OrchestratorError('LLM failed', 'LLM_ERROR'));
    const server = new SmartAgentServer(agent);
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        {
          messages: [{ role: 'user', content: 'test' }],
        },
      );
      assert.equal(res.status, 500);
      const body = res.body as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      assert.equal(error.code, 'LLM_ERROR');
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('SmartAgentServer — requestTimeoutMs → signal propagated to agent', () => {
  it('agent.process() receives a signal that gets aborted', async () => {
    let receivedSignal: AbortSignal | undefined;

    const slowAgent: SmartAgent = {
      async process(_text: string, opts?: CallOptions) {
        receivedSignal = opts?.signal;
        await new Promise<void>((resolve) => {
          if (opts?.signal) {
            if (opts.signal.aborted) {
              resolve();
              return;
            }
            opts.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
            // Safety fallback
            setTimeout(resolve, 1000);
          } else {
            resolve();
          }
        });
        return {
          ok: false as const,
          error: new OrchestratorError('Aborted by timeout', 'ABORTED'),
        };
      },
    } as unknown as SmartAgent;

    const server = new SmartAgentServer(slowAgent, { requestTimeoutMs: 50 });
    const handle = await server.start();
    try {
      await httpRequest(handle.port, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'test' }],
      });
      assert.ok(receivedSignal !== undefined, 'agent should receive a signal');
      assert.ok(
        receivedSignal.aborted,
        'signal should be aborted after timeout',
      );
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

describe('SmartAgentServer — port: 0 → handle.port is numeric > 0', () => {
  it('returns actual port number > 0', async () => {
    const agent = makeAgent({
      content: 'ok',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    });
    const server = new SmartAgentServer(agent, { port: 0 });
    const handle = await server.start();
    try {
      assert.ok(typeof handle.port === 'number');
      assert.ok(handle.port > 0);
    } finally {
      await handle.close();
    }
  });
});
