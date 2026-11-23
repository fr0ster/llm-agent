import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  LlmError,
  type LlmStreamChunk,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { RetryLlm } from '../retry-llm.js';

function makeFakeILlm(
  streamFn: () => AsyncIterable<Result<LlmStreamChunk, LlmError>>,
): ILlm {
  return {
    model: 'test',
    chat: async () => ({
      ok: true,
      value: { content: '', finishReason: 'stop' },
    }),
    streamChat: streamFn,
  };
}

describe('RetryLlm — mid-stream retry', () => {
  it('does not retry a terminal code even with matching status and message', async () => {
    for (const code of [
      'ABORTED',
      'CREDENTIALS_REJECTED',
      'LLM_OUTPUT_TRUNCATED',
      'MODEL_CONTEXT_EXCEEDED',
      'CONFIG_ERROR',
    ]) {
      const error = Object.assign(new LlmError('SSE stream failure', code), {
        status: 503,
      });
      let chats = 0;
      let streams = 0;
      const inner = makeFakeILlm(async function* () {
        yield { ok: true, value: { content: 'partial' } };
        if (++streams === 1) throw error;
      });
      inner.chat = async () => {
        assert.equal(++chats, 1);
        return { ok: false, error };
      };
      const retry = new RetryLlm(inner, {
        backoffMs: 0,
        retryOn: [503],
        retryOnMidStream: ['SSE stream'],
      });

      assert.deepEqual(await retry.chat([]), { ok: false, error });
      const chunks: Result<LlmStreamChunk, LlmError>[] = [];
      for await (const chunk of retry.streamChat([])) chunks.push(chunk);
      assert.deepEqual(chunks, [
        { ok: true, value: { content: 'partial' } },
        { ok: false, error },
      ]);
      assert.equal(streams, 1);
    }
  });

  it('preserves partial output and stops on an HTTP 401 or auth code', async () => {
    for (const cause of [{ status: 401 }, { code: 'authentication_error' }]) {
      const error = new LlmError('SSE stream: credentials rejected');
      error.cause = cause;
      let calls = 0;
      const inner = makeFakeILlm(async function* () {
        yield { ok: true, value: { content: 'partial' } };
        if (++calls === 1) yield { ok: false, error };
      });
      const retry = new RetryLlm(inner, {
        backoffMs: 0,
        retryOn: [401],
        retryOnMidStream: ['SSE stream'],
      });
      const chunks: Result<LlmStreamChunk, LlmError>[] = [];
      for await (const chunk of retry.streamChat([])) chunks.push(chunk);
      assert.equal(calls, 1);
      assert.deepEqual(chunks, [
        { ok: true, value: { content: 'partial' } },
        { ok: false, error },
      ]);
    }
  });

  it('retries after mid-stream error and yields reset chunk', async () => {
    let callCount = 0;

    const inner = makeFakeILlm(() => {
      callCount++;
      return (async function* () {
        if (callCount === 1) {
          yield {
            ok: true,
            value: { content: 'chunk1' },
          } as Result<LlmStreamChunk, LlmError>;
          yield {
            ok: true,
            value: { content: 'chunk2' },
          } as Result<LlmStreamChunk, LlmError>;
          yield {
            ok: false,
            error: new LlmError('Error while iterating over SSE stream'),
          } as Result<LlmStreamChunk, LlmError>;
        } else {
          yield {
            ok: true,
            value: { content: 'full1' },
          } as Result<LlmStreamChunk, LlmError>;
          yield {
            ok: true,
            value: { content: 'full2' },
          } as Result<LlmStreamChunk, LlmError>;
          yield {
            ok: true,
            value: { content: 'full3' },
          } as Result<LlmStreamChunk, LlmError>;
        }
      })();
    });

    const retry = new RetryLlm(inner, {
      maxAttempts: 2,
      backoffMs: 10,
      retryOn: [],
      retryOnMidStream: ['SSE stream'],
    });

    const chunks: Result<LlmStreamChunk, LlmError>[] = [];
    for await (const chunk of retry.streamChat([])) {
      chunks.push(chunk);
    }

    // Should see: chunk1, chunk2, reset, full1, full2, full3
    assert.equal(callCount, 2, 'inner should be called twice');
    assert.equal(chunks.length, 6);

    assert.equal(chunks[0].ok && chunks[0].value.content, 'chunk1');
    assert.equal(chunks[1].ok && chunks[1].value.content, 'chunk2');
    assert.ok(
      chunks[2].ok && chunks[2].value.reset,
      'third chunk should be reset signal',
    );
    assert.equal(chunks[3].ok && chunks[3].value.content, 'full1');
    assert.equal(chunks[4].ok && chunks[4].value.content, 'full2');
    assert.equal(chunks[5].ok && chunks[5].value.content, 'full3');
  });

  it('does not retry mid-stream when retryOnMidStream is not set', async () => {
    let callCount = 0;

    const inner = makeFakeILlm(() => {
      callCount++;
      return (async function* () {
        yield {
          ok: true,
          value: { content: 'chunk1' },
        } as Result<LlmStreamChunk, LlmError>;
        yield {
          ok: false,
          error: new LlmError('SSE stream error'),
        } as Result<LlmStreamChunk, LlmError>;
      })();
    });

    const retry = new RetryLlm(inner, {
      maxAttempts: 2,
      backoffMs: 10,
      retryOn: [],
    });

    const chunks: Result<LlmStreamChunk, LlmError>[] = [];
    for await (const chunk of retry.streamChat([])) {
      chunks.push(chunk);
    }

    assert.equal(callCount, 1, 'should not retry');
    assert.equal(chunks.length, 2);
    assert.ok(!chunks[1].ok, 'second chunk should be error');
  });

  it('gives up after maxAttempts mid-stream retries', async () => {
    let callCount = 0;

    const inner = makeFakeILlm(() => {
      callCount++;
      return (async function* () {
        yield {
          ok: true,
          value: { content: 'chunk' },
        } as Result<LlmStreamChunk, LlmError>;
        yield {
          ok: false,
          error: new LlmError('SSE stream broken'),
        } as Result<LlmStreamChunk, LlmError>;
      })();
    });

    const retry = new RetryLlm(inner, {
      maxAttempts: 2,
      backoffMs: 10,
      retryOn: [],
      retryOnMidStream: ['SSE stream'],
    });

    const chunks: Result<LlmStreamChunk, LlmError>[] = [];
    for await (const chunk of retry.streamChat([])) {
      chunks.push(chunk);
    }

    // 3 calls total (1 initial + 2 retries), last one yields error
    assert.equal(callCount, 3);
    const lastChunk = chunks[chunks.length - 1];
    assert.ok(!lastChunk.ok, 'last chunk should be error');
  });
});
