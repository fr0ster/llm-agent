import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { IUsageRecorder, UsageInput } from '../../interfaces/usage.js';
import type { LLMCallOptions, LLMResponse, Message } from '../../types.js';
import type { LlmRequestHandle } from '../../usage/hooks.js';
import { startOperation } from '../../usage/hooks.js';
import { BaseLLMProvider } from '../base-llm-provider.js';

function capture() {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (record) => records.push(record),
    with: () => usage,
  };
  return { records, usage };
}

class Provider extends BaseLLMProvider {
  async chat(_messages: Message[]): Promise<LLMResponse> {
    return { content: 'unchanged' };
  }
  async *streamChat(_messages: Message[]): AsyncIterable<LLMResponse> {}

  request<T>(
    fn: (handle: LlmRequestHandle) => Promise<T>,
    opts?: LLMCallOptions,
  ) {
    return this.withThrottleRetry(
      fn,
      { signal: opts?.signal },
      {
        opts,
        op: startOperation(opts),
        base: {
          provider: 'test',
          model: 'model',
          stream: false,
          granularity: 'request',
          retriesVisible: true,
        },
      },
    );
  }
  open(fn: (handle: LlmRequestHandle) => Promise<string>) {
    return this.withThrottleRetry(fn, undefined, {
      op: startOperation(),
      base: {
        provider: 'test',
        model: 'model',
        stream: true,
        granularity: 'request',
        retriesVisible: true,
      },
    });
  }
}

it('records each physical throttle attempt with shared operation and exact usage', async () => {
  const { usage, records } = capture();
  const provider = new Provider({
    usage,
    whenThrottled: {
      name: 'immediate',
      decide: ({ attempt }) => ({ retry: attempt < 2, waitMs: 0 }),
    },
  });
  let attempts = 0;
  const result = await provider.request(async (handle) => {
    if (attempts++ === 0)
      throw Object.assign(new Error('private body'), { status: 429 });
    handle.end({
      outcome: 'ok',
      inputTokens: 5,
      outputTokens: 3,
      tokensSource: 'provider',
    });
    return 'result';
  });
  assert.equal(result, 'result');
  assert.equal(records.length, 2);
  const calls = records.filter((r) => r.kind === 'llm.call');
  assert.deepEqual(
    calls.map((r) => [r.providerAttempt, r.physicalSeq, r.outcome]),
    [
      [0, 0, 'error'],
      [1, 1, 'ok'],
    ],
  );
  assert.equal(calls[0].operationId, calls[1].operationId);
  assert.equal(calls[0].errorCode, '429');
  assert.equal(calls[1].inputTokens, 5);
  assert.ok(!JSON.stringify(records).includes('private body'));
});

it('per-call recorder overrides the bound recorder and an abort is recorded', async () => {
  const bound = capture();
  const override = capture();
  const provider = new Provider({ usage: bound.usage });
  await assert.rejects(
    provider.request(
      async () => {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      },
      { usage: override.usage },
    ),
  );
  assert.equal(bound.records.length, 0);
  assert.equal(override.records[0].outcome, 'aborted');
});

it('transfers a successful stream handle and ends failed openings exactly once', async () => {
  const { usage, records } = capture();
  const provider = new Provider({ usage });
  const opened = await provider.open(async () => 'stream');
  assert.equal(opened.response, 'stream');
  assert.equal(records.length, 0);
  opened.handle.firstToken();
  opened.handle.end({
    outcome: 'aborted',
    closedEarly: true,
    inputTokens: 4,
    tokensSource: 'provider',
  });
  opened.handle.end({ outcome: 'ok' });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'aborted');
  await assert.rejects(
    provider.open(async () => {
      throw new Error('failed');
    }),
  );
  assert.equal(records.length, 2);
  assert.equal(records[1].outcome, 'error');
});

it('records transport cancellation without requiring a caller signal', async () => {
  const { usage, records } = capture();
  const provider = new Provider({ usage });
  await assert.rejects(
    provider.request(async () => {
      throw Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' });
    }),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'aborted');
});

it('a broken recorder does not change results or errors', async () => {
  const usage: IUsageRecorder = {
    record() {
      throw new Error('recorder');
    },
    with() {
      return usage;
    },
  };
  const provider = new Provider({ usage });
  assert.equal(await provider.request(async () => 42), 42);
  const error = new Error('transport');
  await assert.rejects(
    provider.request(async () => {
      throw error;
    }),
    (actual) => actual === error,
  );
  assert.equal(await new Provider({}).request(async () => 43), 43);
});
