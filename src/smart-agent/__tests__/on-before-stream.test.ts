import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../agent.js';
import type { StreamHookContext } from '../interfaces/types.js';
import { makeDefaultDeps } from '../testing/index.js';

const DEFAULT_CONFIG = { maxIterations: 5 };

// ---------------------------------------------------------------------------
// onBeforeStream hook
// ---------------------------------------------------------------------------

describe('onBeforeStream hook', () => {
  it('transforms content when hook is set', async () => {
    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'raw response', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      async *onBeforeStream(content: string, _ctx: StreamHookContext) {
        yield `[transformed] ${content}`;
      },
    });

    const chunks: string[] = [];
    for await (const chunk of agent.streamProcess('test')) {
      if (chunk.ok && chunk.value.content) {
        chunks.push(chunk.value.content);
      }
    }

    assert.ok(
      chunks.some((c) => c.includes('[transformed] raw response')),
      `Expected transformed content, got: ${JSON.stringify(chunks)}`,
    );
  });

  it('streams content as-is when hook is not set', async () => {
    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'raw response', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    const chunks: string[] = [];
    for await (const chunk of agent.streamProcess('test')) {
      if (chunk.ok && chunk.value.content) {
        chunks.push(chunk.value.content);
      }
    }

    // Without the hook, content is streamed directly (no transformation).
    // The raw LLM content should appear in the stream chunks.
    assert.ok(
      chunks.some((c) => c.includes('raw response')),
      `Expected raw content in stream, got: ${JSON.stringify(chunks)}`,
    );
    assert.ok(
      !chunks.some((c) => c.includes('[transformed]')),
      'Should not have transformed prefix',
    );
  });

  it('hook receives messages in context', async () => {
    let capturedCtx: StreamHookContext | undefined;
    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'hello', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      async *onBeforeStream(content: string, ctx: StreamHookContext) {
        capturedCtx = ctx;
        yield content;
      },
    });

    for await (const _ of agent.streamProcess('test')) {
      // consume all chunks
    }

    assert.ok(capturedCtx, 'Hook should have been called');
    assert.ok(Array.isArray(capturedCtx.messages), 'messages should be array');
    assert.ok(capturedCtx.messages.length > 0, 'messages should not be empty');
  });

  it('hook can yield multiple chunks', async () => {
    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'original', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      async *onBeforeStream(_content: string, _ctx: StreamHookContext) {
        yield 'chunk1';
        yield 'chunk2';
        yield 'chunk3';
      },
    });

    const chunks: string[] = [];
    for await (const chunk of agent.streamProcess('test')) {
      if (chunk.ok && chunk.value.content) {
        chunks.push(chunk.value.content);
      }
    }

    assert.ok(chunks.includes('chunk1'), 'Should include chunk1');
    assert.ok(chunks.includes('chunk2'), 'Should include chunk2');
    assert.ok(chunks.includes('chunk3'), 'Should include chunk3');
  });
});
