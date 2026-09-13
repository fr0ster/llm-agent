import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BaseAgentLlmBridge, Message } from '@mcp-abap-adt/llm-agent';
import { LlmAdapter } from '../llm-adapter.js';

/**
 * The caller's deadline has to reach the transport, not just the waiting
 * around it.
 *
 * The adapter used to build the inner options from four fields — temperature,
 * maxTokens, topP, stop — and race the promise with `withAbort`. On abort the
 * caller was answered at once and the HTTP request ran on, holding a socket
 * and a response nobody would read. Since `makeLlm` returns this adapter for
 * every provider, that was every consumer, and it contradicted the library's
 * own advice to bound a throttling strategy "with an AbortSignal".
 */
function recordingBridge() {
  const seen: { chat?: unknown; stream?: unknown } = {};
  const bridge: BaseAgentLlmBridge = {
    async callWithTools(_m: Message[], _t: unknown[], options) {
      seen.chat = options;
      return { content: 'ok' };
    },
    async *streamWithTools(_m: Message[], _t: unknown[], options) {
      seen.stream = options;
      yield { content: 'ok' };
    },
  };
  return { bridge, seen };
}

describe('LlmAdapter — the caller signal', () => {
  it('hands the signal to the inner call, not only to the wait around it', async () => {
    const { bridge, seen } = recordingBridge();
    const controller = new AbortController();
    await new LlmAdapter(bridge).chat([], undefined, {
      signal: controller.signal,
    });
    assert.equal(
      (seen.chat as { signal?: AbortSignal }).signal,
      controller.signal,
    );
  });

  it('does the same on the streaming path', async () => {
    const { bridge, seen } = recordingBridge();
    const controller = new AbortController();
    for await (const _ of new LlmAdapter(bridge).streamChat([], undefined, {
      signal: controller.signal,
    })) {
      // drain
    }
    assert.equal(
      (seen.stream as { signal?: AbortSignal }).signal,
      controller.signal,
    );
  });

  it('passes nothing when the caller set no deadline', async () => {
    const { bridge, seen } = recordingBridge();
    await new LlmAdapter(bridge).chat([], undefined, { temperature: 0.2 });
    assert.equal((seen.chat as { signal?: AbortSignal }).signal, undefined);
  });
});
