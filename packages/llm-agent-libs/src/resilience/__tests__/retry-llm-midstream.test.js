import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError } from '@mcp-abap-adt/llm-agent';
import { RetryLlm } from '../retry-llm.js';

function makeFakeILlm(streamFn) {
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
  it('retries after mid-stream error and yields reset chunk', async () => {
    let callCount = 0;
    const inner = makeFakeILlm(() => {
      callCount++;
      return (async function* () {
        if (callCount === 1) {
          yield {
            ok: true,
            value: { content: 'chunk1' },
          };
          yield {
            ok: true,
            value: { content: 'chunk2' },
          };
          yield {
            ok: false,
            error: new LlmError('Error while iterating over SSE stream'),
          };
        } else {
          yield {
            ok: true,
            value: { content: 'full1' },
          };
          yield {
            ok: true,
            value: { content: 'full2' },
          };
          yield {
            ok: true,
            value: { content: 'full3' },
          };
        }
      })();
    });
    const retry = new RetryLlm(inner, {
      maxAttempts: 2,
      backoffMs: 10,
      retryOn: [],
      retryOnMidStream: ['SSE stream'],
    });
    const chunks = [];
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
        };
        yield {
          ok: false,
          error: new LlmError('SSE stream error'),
        };
      })();
    });
    const retry = new RetryLlm(inner, {
      maxAttempts: 2,
      backoffMs: 10,
      retryOn: [],
    });
    const chunks = [];
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
        };
        yield {
          ok: false,
          error: new LlmError('SSE stream broken'),
        };
      })();
    });
    const retry = new RetryLlm(inner, {
      maxAttempts: 2,
      backoffMs: 10,
      retryOn: [],
      retryOnMidStream: ['SSE stream'],
    });
    const chunks = [];
    for await (const chunk of retry.streamChat([])) {
      chunks.push(chunk);
    }
    // 3 calls total (1 initial + 2 retries), last one yields error
    assert.equal(callCount, 3);
    const lastChunk = chunks[chunks.length - 1];
    assert.ok(!lastChunk.ok, 'last chunk should be error');
  });
});
//# sourceMappingURL=retry-llm-midstream.test.js.map
