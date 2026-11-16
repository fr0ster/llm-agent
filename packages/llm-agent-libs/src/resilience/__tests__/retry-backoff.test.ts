import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DefaultWaitStrategy,
  type ILlm,
  LlmError,
  withRetry,
} from '@mcp-abap-adt/llm-agent';
import { RetryLlm } from '../retry-llm.js';

for (const backoffMs of [0, 17, 2000]) {
  test(`LLM chat, stream and embedder retries keep the same ${backoffMs}ms backoff sequence`, async (t) => {
    const waits: number[] = [];
    t.mock.method(DefaultWaitStrategy.prototype, 'wait', async (ms: number) => {
      waits.push(ms);
      return 'elapsed';
    });
    const error = new LlmError('opaque transport failure');
    error.cause = { response: { status: 503 } };
    const inner: ILlm = {
      chat: async () => ({ ok: false, error }),
      streamChat: async function* () {
        yield { ok: false, error };
      },
    };
    const llm = new RetryLlm(inner, { backoffMs });
    assert.equal((await llm.chat([])).ok, false);
    const expected = [backoffMs, backoffMs * 2, backoffMs * 4];
    assert.deepEqual(waits, expected);
    waits.length = 0;
    for await (const chunk of llm.streamChat([])) {
      assert.equal(chunk.ok, false);
    }
    assert.deepEqual(waits, expected);
    waits.length = 0;
    await assert.rejects(
      withRetry(
        {
          embed: async () => {
            throw error;
          },
        },
        { backoffMs },
      ).embed('q'),
      (actual) => actual === error,
    );
    assert.deepEqual(waits, expected);
  });
}
