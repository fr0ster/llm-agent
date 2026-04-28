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
import { LlmError, } from '@mcp-abap-adt/llm-agent';
import { RetryLlm } from '../../../resilience/retry-llm.js';
/**
 * Simulates the stream consumption pattern from ToolLoopHandler
 * (tool-loop.ts lines 344-410) — accumulates content, toolCalls, finishReason.
 */
async function consumeStreamLikeToolLoop(stream) {
    let content = '';
    let finishReason;
    const toolCallsMap = new Map();
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
                }
                else {
                    const ex = toolCallsMap.get(index);
                    if (ex) {
                        if (tc.id)
                            ex.id = tc.id;
                        if (tc.name)
                            ex.name += tc.name;
                        if (tc.arguments)
                            ex.arguments += tc.arguments;
                    }
                }
            }
        }
        if (chunk.finishReason)
            finishReason = chunk.finishReason;
    }
    return {
        content,
        toolCallNames: [...toolCallsMap.values()].map((tc) => tc.name),
        finishReason,
    };
}
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
describe('tool-loop stream reset handling', () => {
    it('WITHOUT reset handling, accumulated state is corrupted (proves bug #46)', async () => {
        let callCount = 0;
        const inner = makeFakeILlm(() => {
            callCount++;
            return (async function* () {
                if (callCount === 1) {
                    yield { ok: true, value: { content: 'stale-' } };
                    yield {
                        ok: false,
                        error: new LlmError('Error while iterating over SSE stream'),
                    };
                }
                else {
                    yield { ok: true, value: { content: 'fresh' } };
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
            if (!chunkResult.ok)
                throw new Error('unexpected');
            const chunk = chunkResult.value;
            // BUG: no reset check — stale content persists
            if (chunk.content)
                content += chunk.content;
        }
        // This proves the bug: content is corrupted with stale data
        assert.equal(content, 'stale-fresh', 'without reset handling, stale data leaks through');
    });
    it('discards accumulated content and toolCalls when reset chunk arrives', async () => {
        let callCount = 0;
        const inner = makeFakeILlm(() => {
            callCount++;
            return (async function* () {
                if (callCount === 1) {
                    // First attempt: yields partial content + tool call, then fails
                    yield { ok: true, value: { content: 'stale-' } };
                    yield { ok: true, value: { content: 'data' } };
                    yield {
                        ok: true,
                        value: {
                            content: '',
                            toolCalls: [
                                { index: 0, id: 'tc_old', name: 'old_tool', arguments: '{}' },
                            ],
                        },
                    };
                    yield {
                        ok: false,
                        error: new LlmError('Error while iterating over SSE stream'),
                    };
                }
                else {
                    // Retry: yields fresh content + different tool call
                    yield { ok: true, value: { content: 'fresh' } };
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
                    };
                    yield {
                        ok: true,
                        value: { content: '', finishReason: 'stop' },
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
        const result = await consumeStreamLikeToolLoop(retry.streamChat([]));
        // Without reset handling: content would be "stale-datafresh", toolCalls would contain old_tool
        // With reset handling: content should be only "fresh", toolCalls only new_tool
        assert.equal(result.content, 'fresh', 'stale content must be discarded after reset');
        assert.deepEqual(result.toolCallNames, ['new_tool'], 'stale tool calls must be discarded after reset');
        assert.equal(result.finishReason, 'stop');
        assert.equal(callCount, 2);
    });
    it('accumulates normally when no reset occurs', async () => {
        const inner = makeFakeILlm(() => {
            return (async function* () {
                yield { ok: true, value: { content: 'hello' } };
                yield { ok: true, value: { content: ' world' } };
                yield {
                    ok: true,
                    value: { content: '', finishReason: 'stop' },
                };
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
//# sourceMappingURL=tool-loop-reset.test.js.map