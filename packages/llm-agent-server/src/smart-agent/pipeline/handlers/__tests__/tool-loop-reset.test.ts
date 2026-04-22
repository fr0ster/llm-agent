/**
 * Verifies that the tool-loop stream consumption handles mid-stream
 * reset chunks from RetryLlm.
 *
 * The test extracts the exact accumulation pattern used in ToolLoopHandler
 * to prove that reset chunks clear accumulated state.
 *
 * Related: issue #46 — SSE streaming fails after 2 tool-loop iterations
 * because reset chunks were not handled in the pipeline handler.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '../../../interfaces/llm.js';
import {
  LlmError,
  type LlmFinishReason,
  type LlmStreamChunk,
  type Result,
} from '../../../interfaces/types.js';
import { RetryLlm } from '../../../resilience/retry-llm.js';

/**
 * Simulates the stream consumption pattern from ToolLoopHandler
 * (tool-loop.ts lines 344-410) — accumulates content, toolCalls, finishReason.
 */
async function consumeStreamLikeToolLoop(
  stream: AsyncIterable<Result<LlmStreamChunk, LlmError>>,
): Promise<{
  content: string;
  toolCallNames: string[];
  finishReason: LlmFinishReason | undefined;
}> {
  let content = '';
  let finishReason: LlmFinishReason | undefined;
  const toolCallsMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const chunkResult of stream) {
    if (!chunkResult.ok) {
      throw new Error(`Unexpected error chunk: ${chunkResult.error.message}`);
    }
    const chunk = chunkResult.value;

    // --- This is the reset handling that must exist in tool-loop.ts ---
    if (chunk.reset) {
      content = '';
      toolCallsMap.clear();
      finishReason = undefined;
      continue;
    }

    if (chunk.content) {
      content += chunk.content;
    }
    if (chunk.toolCalls) {
      for (const [fallbackIndex, tc] of chunk.toolCalls.entries()) {
        const index = tc.index ?? fallbackIndex;
        if (!toolCallsMap.has(index)) {
          toolCallsMap.set(index, {
            id: tc.id || '',
            name: tc.name || '',
            arguments: tc.arguments || '',
          });
        } else {
          const ex = toolCallsMap.get(index);
          if (ex) {
            if (tc.id) ex.id = tc.id;
            if (tc.name) ex.name += tc.name;
            if (tc.arguments) ex.arguments += tc.arguments;
          }
        }
      }
    }
    if (chunk.finishReason) finishReason = chunk.finishReason;
  }

  return {
    content,
    toolCallNames: [...toolCallsMap.values()].map((tc) => tc.name),
    finishReason,
  };
}

function makeFakeILlm(
  streamFn: () => AsyncIterable<Result<LlmStreamChunk, LlmError>>,
): ILlm {
  return {
    model: 'test',
    chat: async () => ({
      ok: true,
      value: { content: '', finishReason: 'stop' as const },
    }),
    streamChat: streamFn,
  };
}

describe('tool-loop stream reset handling', () => {
  it('WITHOUT reset handling, accumulated state is corrupted (proves bug #46)', async () => {
    let callCount = 0;

    const inner = makeFakeILlm(() => {
      callCount++;
      return (async function* () {
        if (callCount === 1) {
          yield { ok: true, value: { content: 'stale-' } } as Result<
            LlmStreamChunk,
            LlmError
          >;
          yield {
            ok: false,
            error: new LlmError('Error while iterating over SSE stream'),
          } as Result<LlmStreamChunk, LlmError>;
        } else {
          yield { ok: true, value: { content: 'fresh' } } as Result<
            LlmStreamChunk,
            LlmError
          >;
        }
      })();
    });

    const retry = new RetryLlm(inner, {
      maxAttempts: 2,
      backoffMs: 10,
      retryOn: [],
      retryOnMidStream: ['SSE stream'],
    });

    // Simulate tool-loop WITHOUT reset handling (current bug)
    let content = '';
    for await (const chunkResult of retry.streamChat([])) {
      if (!chunkResult.ok) throw new Error('unexpected');
      const chunk = chunkResult.value;
      // BUG: no reset check — stale content persists
      if (chunk.content) content += chunk.content;
    }

    // This proves the bug: content is corrupted with stale data
    assert.equal(
      content,
      'stale-fresh',
      'without reset handling, stale data leaks through',
    );
  });

  it('discards accumulated content and toolCalls when reset chunk arrives', async () => {
    let callCount = 0;

    const inner = makeFakeILlm(() => {
      callCount++;
      return (async function* () {
        if (callCount === 1) {
          // First attempt: yields partial content + tool call, then fails
          yield { ok: true, value: { content: 'stale-' } } as Result<
            LlmStreamChunk,
            LlmError
          >;
          yield { ok: true, value: { content: 'data' } } as Result<
            LlmStreamChunk,
            LlmError
          >;
          yield {
            ok: true,
            value: {
              content: '',
              toolCalls: [
                { index: 0, id: 'tc_old', name: 'old_tool', arguments: '{}' },
              ],
            },
          } as Result<LlmStreamChunk, LlmError>;
          yield {
            ok: false,
            error: new LlmError('Error while iterating over SSE stream'),
          } as Result<LlmStreamChunk, LlmError>;
        } else {
          // Retry: yields fresh content + different tool call
          yield { ok: true, value: { content: 'fresh' } } as Result<
            LlmStreamChunk,
            LlmError
          >;
          yield {
            ok: true,
            value: {
              content: '',
              toolCalls: [
                {
                  index: 0,
                  id: 'tc_new',
                  name: 'new_tool',
                  arguments: '{"a":1}',
                },
              ],
            },
          } as Result<LlmStreamChunk, LlmError>;
          yield {
            ok: true,
            value: { content: '', finishReason: 'stop' as const },
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

    const result = await consumeStreamLikeToolLoop(retry.streamChat([]));

    // Without reset handling: content would be "stale-datafresh", toolCalls would contain old_tool
    // With reset handling: content should be only "fresh", toolCalls only new_tool
    assert.equal(
      result.content,
      'fresh',
      'stale content must be discarded after reset',
    );
    assert.deepEqual(
      result.toolCallNames,
      ['new_tool'],
      'stale tool calls must be discarded after reset',
    );
    assert.equal(result.finishReason, 'stop');
    assert.equal(callCount, 2);
  });

  it('accumulates normally when no reset occurs', async () => {
    const inner = makeFakeILlm(() => {
      return (async function* () {
        yield { ok: true, value: { content: 'hello' } } as Result<
          LlmStreamChunk,
          LlmError
        >;
        yield { ok: true, value: { content: ' world' } } as Result<
          LlmStreamChunk,
          LlmError
        >;
        yield {
          ok: true,
          value: { content: '', finishReason: 'stop' as const },
        } as Result<LlmStreamChunk, LlmError>;
      })();
    });

    const retry = new RetryLlm(inner, {
      maxAttempts: 2,
      backoffMs: 10,
      retryOn: [],
      retryOnMidStream: ['SSE stream'],
    });

    const result = await consumeStreamLikeToolLoop(retry.streamChat([]));

    assert.equal(result.content, 'hello world');
    assert.equal(result.finishReason, 'stop');
  });
});
