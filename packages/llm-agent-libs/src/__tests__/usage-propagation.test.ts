import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  type ILlm,
  type IRequestLogger,
  type IUsageRecorder,
  LlmError,
  startOperation,
  staticApiKey,
  type UsageOperation,
} from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '../../../openai-llm/src/openai-provider.js';
import { LlmAdapter } from '../adapters/llm-adapter.js';
import { LlmProviderBridge } from '../adapters/llm-provider-bridge.js';
import { normalizeRequestOptions } from '../agent-request-options.js';
import { RetryLlm } from '../resilience/retry-llm.js';

const usage: IUsageRecorder = {
  record() {},
  with() {
    return this;
  },
};

test('normalization keeps the caller recorder and operation by reference', () => {
  const usageOp = startOperation();
  const opts = normalizeRequestOptions(
    { usage, usageOp },
    'trace',
    {} as IRequestLogger,
  );
  assert.equal(opts.usage, usage);
  assert.equal(opts.usageOp, usageOp);
});

test('adapter and bridge deliver recorder and operation to the real OpenAI provider', async () => {
  const provider = new OpenAIProvider({
    credential: staticApiKey('test'),
    model: 'test',
  });
  const seen: Array<CallOptions | undefined> = [];
  const chat = provider.chat.bind(provider);
  provider.chat = (messages, tools, opts) => {
    seen.push(opts);
    return chat(messages, tools, opts);
  };
  const streamChat = provider.streamChat.bind(provider);
  provider.streamChat = (messages, tools, opts) => {
    seen.push(opts);
    return streamChat(messages, tools, opts);
  };
  let httpCalls = 0;
  provider.client.defaults.adapter = async (config) => {
    httpCalls++;
    return {
      data:
        config.responseType === 'stream'
          ? (async function* () {
              yield Buffer.from('data: [DONE]\n\n');
            })()
          : { choices: [{ message: { content: 'ok' } }] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
  const llm = new LlmAdapter(new LlmProviderBridge(provider));
  const usageOp = startOperation();
  const opts = { usage, usageOp };
  assert.equal(
    (await llm.chat([{ role: 'user', content: 'hello' }], [], opts)).ok,
    true,
  );
  for await (const chunk of llm.streamChat([], [], opts))
    assert.equal(chunk.ok, true);
  assert.equal(httpCalls, 2);
  assert.equal(seen.length, 2);
  for (const received of seen) {
    assert.equal(received?.usage, usage);
    assert.equal(received?.usageOp, usageOp);
  }
});

for (const streaming of [false, true]) {
  test(`RetryLlm shares operation and re-enters each ${streaming ? 'stream' : 'chat'} attempt`, async () => {
    const seen: UsageOperation[] = [];
    const accept = (opts?: CallOptions) => {
      assert.equal(opts?.usage, usage);
      assert.ok(opts?.usageOp);
      seen.push(opts.usageOp);
      return seen.length < 3;
    };
    const inner: ILlm = {
      async chat(_messages, _tools, opts) {
        return accept(opts)
          ? { ok: false, error: new LlmError('503', 'LLM_ERROR') }
          : { ok: true, value: { content: 'ok', finishReason: 'stop' } };
      },
      async *streamChat(_messages, _tools, opts) {
        if (accept(opts))
          yield { ok: false, error: new LlmError('503', 'LLM_ERROR') };
        else yield { ok: true, value: { content: 'ok', finishReason: 'stop' } };
      },
    };
    const llm = new RetryLlm(inner, { maxAttempts: 2, backoffMs: 0 });
    const usageOp = startOperation();
    const opts = { usage, usageOp };
    if (streaming)
      for await (const chunk of llm.streamChat([], [], opts))
        assert.equal(chunk.ok, true);
    else assert.equal((await llm.chat([], [], opts)).ok, true);
    assert.deepEqual(
      seen.map((op) => op.outerAttempt),
      [0, 1, 2],
    );
    for (const op of seen) {
      assert.equal(op.operationId, usageOp.operationId);
      assert.equal(op.seq, usageOp.seq);
      assert.notEqual(op, usageOp);
    }
    assert.equal(usageOp.outerAttempt, 0);
  });
}
