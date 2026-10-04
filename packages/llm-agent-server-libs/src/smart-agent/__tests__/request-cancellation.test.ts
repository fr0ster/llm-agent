import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { AnthropicApiAdapter } from '@mcp-abap-adt/llm-agent';
import {
  SessionRequestLogger,
  type SmartAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import { handleAdapterRequest } from '../http/adapter-route-handler.js';
import { handleChat } from '../http/chat-route-handler.js';

type Route = 'chat' | 'adapter';

interface Probe {
  /** Signal the route handed the agent. */
  signal?: AbortSignal;
  /** Resolves once the agent received the request. */
  started: Promise<void>;
  /** Resolves with the agent's observation once its wait ended. */
  observedAbort: Promise<boolean>;
}

/**
 * Fake agent. With `hang`, the "tool step" awaits the signal it was given
 * (what an in-flight MCP call does) and then keeps going, so a route that
 * kept writing after the disconnect would be caught by the write spy.
 */
function makeAgent(hang: boolean) {
  const probe: Probe = {} as Probe;
  let markStarted!: () => void;
  let markObserved!: (aborted: boolean) => void;
  probe.started = new Promise<void>((r) => {
    markStarted = r;
  });
  probe.observedAbort = new Promise<boolean>((r) => {
    markObserved = r;
  });
  const awaitTool = async (signal: AbortSignal | undefined) => {
    probe.signal = signal;
    markStarted();
    // A route that passes no signal leaves nothing to wait on: report it.
    if (!signal) return markObserved(false);
    if (!signal.aborted) await once(signal, 'abort');
    markObserved(signal.aborted);
  };
  const agent = {
    async process(_m: unknown, options?: { signal?: AbortSignal }) {
      if (hang) {
        await awaitTool(options?.signal);
      } else {
        probe.signal = options?.signal;
        markStarted();
        markObserved(options?.signal?.aborted ?? false);
      }
      return {
        ok: true,
        value: { content: 'late answer', stopReason: 'stop' },
      };
    },
    async *streamProcess(_m: unknown, options?: { signal?: AbortSignal }) {
      yield { ok: true, value: { content: 'first' } };
      if (hang) {
        await awaitTool(options?.signal);
      } else {
        probe.signal = options?.signal;
        markStarted();
        markObserved(options?.signal?.aborted ?? false);
      }
      yield { ok: true, value: { content: 'late', finishReason: 'stop' } };
    },
  } as unknown as SmartAgent;
  return { agent, probe };
}

interface Harness {
  logs: Array<Record<string, unknown>>;
  /** Writes / ends issued on the response after it closed. */
  writesAfterClose: string[];
  handlerDone: Promise<void>;
  resClosed: Promise<void>;
  server: Server;
  port: number;
}

async function startHarness(route: Route, agent: SmartAgent): Promise<Harness> {
  const logs: Array<Record<string, unknown>> = [];
  const writesAfterClose: string[] = [];
  let markDone!: () => void;
  let markClosed!: () => void;
  const handlerDone = new Promise<void>((r) => {
    markDone = r;
  });
  const resClosed = new Promise<void>((r) => {
    markClosed = r;
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let closed = false;
    res.on('close', () => {
      closed = true;
      markClosed();
    });
    const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
    const origEnd = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
    res.write = ((...a: unknown[]) => {
      if (closed) writesAfterClose.push(String(a[0]));
      return origWrite(...a);
    }) as typeof res.write;
    res.end = ((...a: unknown[]) => {
      if (closed) writesAfterClose.push(`end:${String(a[0] ?? '')}`);
      return origEnd(...a);
    }) as typeof res.end;
    const run =
      route === 'chat'
        ? handleChat(
            req,
            res,
            new SessionRequestLogger(),
            agent,
            (() => {}) as never,
            (() => {}) as never,
            (e) => logs.push(e),
            undefined,
            undefined,
            {} as never,
          )
        : handleAdapterRequest(
            req,
            res,
            agent,
            new AnthropicApiAdapter(),
            undefined,
            undefined,
          );
    run.then(markDone, (e) => {
      logs.push({ event: 'handler_threw', message: String(e) });
      markDone();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    logs,
    writesAfterClose,
    handlerDone,
    resClosed,
    server,
    port: (server.address() as AddressInfo).port,
  };
}

function send(h: Harness, route: Route, stream: boolean) {
  const body = JSON.stringify({
    model: 'm',
    stream,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const req = request({
    host: '127.0.0.1',
    port: h.port,
    method: 'POST',
    path: route === 'chat' ? '/v1/chat/completions' : '/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  req.on('error', () => {});
  const response = new Promise<{ status: number; raw: string }>((resolve) => {
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          raw: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', () => {});
    });
  });
  req.end(body);
  return { req, response };
}

async function stop(h: Harness) {
  h.server.closeAllConnections();
  await new Promise<void>((r) => h.server.close(() => r()));
}

for (const route of ['chat', 'adapter'] as const) {
  for (const stream of [false, true]) {
    describe(`request cancellation — ${route} route, ${stream ? 'streaming' : 'non-streaming'}`, () => {
      it('aborts the agent signal on client disconnect, logs request_cancelled, writes nothing after close', async () => {
        const { agent, probe } = makeAgent(true);
        const h = await startHarness(route, agent);
        try {
          const { req } = send(h, route, stream);
          await probe.started;
          assert.equal(probe.signal?.aborted, false);
          req.destroy();
          assert.equal(await probe.observedAbort, true);
          await h.handlerDone;
          await h.resClosed;
          assert.equal(probe.signal?.reason?.name, 'AbortError');
          assert.deepEqual(h.writesAfterClose, []);
          const events = h.logs.map((l) => l.event);
          if (route === 'chat') {
            assert.ok(events.includes('request_cancelled'), String(events));
            assert.ok(!events.includes('request_done'), String(events));
            const c = h.logs.find((l) => l.event === 'request_cancelled');
            assert.equal(typeof c?.durationMs, 'number');
          }
          assert.ok(!events.includes('handler_threw'), String(events));
        } finally {
          await stop(h);
        }
      });

      it('a completed response never aborts the signal and logs no request_cancelled', async () => {
        const { agent, probe } = makeAgent(false);
        const h = await startHarness(route, agent);
        try {
          const { req, response } = send(h, route, stream);
          const res = await response;
          assert.equal(res.status, 200);
          await h.handlerDone;
          req.destroy();
          await h.resClosed;
          assert.equal(probe.signal?.aborted, false);
          assert.equal(await probe.observedAbort, false);
          assert.ok(
            !h.logs.some((l) => l.event === 'request_cancelled'),
            'no request_cancelled after a finished response',
          );
          if (route === 'chat') {
            assert.ok(h.logs.some((l) => l.event === 'request_done'));
          }
        } finally {
          await stop(h);
        }
      });
    });
  }
}
