import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { AnthropicApiAdapter } from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '@mcp-abap-adt/llm-agent-libs';
import { handleAdapterRequest } from './adapter-route-handler.js';
import { handleChat } from './chat-route-handler.js';

/**
 * A request whose body is `json`; drives readBody via a real Readable. Sets
 * `headers` because handleChat reads `req.headers['x-session-id']` when no
 * session is supplied (chat-route-handler.ts:118) — without it the handler
 * throws before the keep-alive assertion.
 */
function makeReq(json: unknown): IncomingMessage {
  const req = Readable.from([
    Buffer.from(JSON.stringify(json)),
  ]) as unknown as IncomingMessage;
  (req as { headers: Record<string, string> }).headers = {};
  return req;
}

/** Fake ServerResponse capturing writes + listeners. */
function fakeRes() {
  const writes: string[] = [];
  const listeners: Record<string, () => void> = {};
  const res = {
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    on: (ev: string, cb: () => void) => {
      listeners[ev] = cb;
    },
    end: () => {},
    writeHead: () => res,
  } as unknown as ServerResponse;
  return { res, writes, listeners };
}

/** Stub SmartAgent: streamProcess idles `idleMs`, then yields one content chunk. */
function idleAgent(idleMs: number) {
  return {
    async *streamProcess() {
      await new Promise((r) => setTimeout(r, idleMs));
      yield { ok: true, value: { content: 'hello', finishReason: 'stop' } };
    },
  } as never; // cast to SmartAgent at the call site
}

/**
 * Stub SmartAgent: yields `count` chunks each `gapMs` apart (no single gap is
 * long). Used to prove the handler calls `reset()` per chunk: with reset, no gap
 * reaches the interval → NO keep-alive; WITHOUT reset the watchdog fires on its
 * initial arm regardless → a keep-alive appears. `gapMs` must be << the interval.
 */
function steadyAgent(count: number, gapMs: number) {
  return {
    async *streamProcess() {
      for (let i = 0; i < count; i++) {
        await new Promise((r) => setTimeout(r, gapMs));
        yield { ok: true, value: { content: `x${i}` } };
      }
      yield { ok: true, value: { content: '', finishReason: 'stop' } };
    },
  } as never;
}

/**
 * Stub SmartAgent whose stream includes a flat-pipeline `value.heartbeat` chunk
 * (as tool-loop-core emits) plus final content — used to prove the transport
 * watchdog did NOT remove the existing per-tool `: heartbeat tool=…` SSE output.
 */
function heartbeatEmittingAgent() {
  return {
    async *streamProcess() {
      yield {
        ok: true,
        value: { content: '', heartbeat: { tool: 'ReadClass', elapsed: 5 } },
      };
      yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
    },
  } as never;
}

const noop = () => {};

describe('#246 SSE keep-alive — /v1/chat/completions', () => {
  it('emits ": keep-alive" during an idle gap before the first data line', async () => {
    const { res, writes } = fakeRes();
    await handleChat(
      makeReq({
        model: 'm',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      res,
      new SessionRequestLogger(),
      idleAgent(80), // stub SmartAgent
      noop as never, // _chat (unused on the stream path)
      noop as never, // _streamChat
      noop, // log
      undefined, // modelProvider
      undefined, // session
      { agent: { heartbeatIntervalMs: 20 } } as never, // cfg
    );
    const firstKeepAlive = writes.findIndex((w) =>
      w.startsWith(': keep-alive'),
    );
    const firstData = writes.findIndex((w) => w.startsWith('data:'));
    assert.ok(
      firstKeepAlive >= 0,
      'a keep-alive was written during the idle gap',
    );
    assert.ok(
      firstKeepAlive < firstData,
      'keep-alive precedes the first data line',
    );
  });

  it('calls reset() per chunk: steady output (gap << interval) → NO keep-alive', async () => {
    // Kills the "removed keepAlive.reset()" mutant: 25 chunks × 4ms = ~100ms total
    // (> the 50ms interval, so WITHOUT reset the watchdog would fire at ~50ms), but
    // every gap is 4ms << 50ms, so WITH reset() no keep-alive is ever written.
    const { res, writes } = fakeRes();
    await handleChat(
      makeReq({
        model: 'm',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      res,
      new SessionRequestLogger(),
      steadyAgent(25, 4),
      noop as never,
      noop as never,
      noop,
      undefined,
      undefined,
      { agent: { heartbeatIntervalMs: 50 } } as never,
    );
    assert.equal(
      writes.filter((w) => w.startsWith(': keep-alive')).length,
      0,
      'reset() on each chunk keeps the watchdog from ever firing during steady output',
    );
  });

  it('flat-path regression: a value.heartbeat chunk still yields ": heartbeat tool=…"', async () => {
    // The transport watchdog must NOT break the existing per-tool heartbeat SSE
    // output (chat-route-handler.ts:304-308). A default interval (no override →
    // 5000) means the watchdog never fires here; the tool heartbeat must survive.
    const { res, writes } = fakeRes();
    await handleChat(
      makeReq({
        model: 'm',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      res,
      new SessionRequestLogger(),
      heartbeatEmittingAgent(),
      noop as never,
      noop as never,
      noop,
      undefined,
      undefined,
      {} as never, // no agent.heartbeatIntervalMs override → default 5000
    );
    assert.ok(
      writes.some((w) => w.startsWith(': heartbeat tool=ReadClass')),
      'existing per-tool heartbeat comment is preserved',
    );
  });
});

describe('#246 SSE keep-alive — /v1/messages (real adapter)', () => {
  it('emits ": keep-alive" during an idle gap', async () => {
    const { res, writes } = fakeRes();
    await handleAdapterRequest(
      makeReq({
        model: 'm',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      res,
      idleAgent(80), // stub SmartAgent
      new AnthropicApiAdapter(),
      undefined, // session
      20, // heartbeatIntervalMs
    );
    assert.ok(
      writes.some((w) => w.startsWith(': keep-alive')),
      'a keep-alive was written during the idle gap on /v1/messages',
    );
  });

  it('calls reset() per event: steady output → NO keep-alive', async () => {
    // Same mutant-killer for the adapter path. Assumes AnthropicApiAdapter forwards
    // content deltas incrementally (one `content_block_delta` event per content
    // chunk), so the handler's per-event reset() keeps the watchdog reset. If the
    // adapter is found to BATCH deltas (a single late event), replace this with the
    // clock-injection variant (thread an injectable `schedule`/`cancel` through
    // attachSseKeepAlive) rather than weakening the assertion.
    const { res, writes } = fakeRes();
    await handleAdapterRequest(
      makeReq({
        model: 'm',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      res,
      steadyAgent(25, 4),
      new AnthropicApiAdapter(),
      undefined,
      50, // interval 50ms; gaps 4ms << 50ms
    );
    assert.equal(
      writes.filter((w) => w.startsWith(': keep-alive')).length,
      0,
      'reset() on each event keeps the watchdog from ever firing during steady output',
    );
  });
});
