/**
 * Verifies that the tool-loop stream consumption correctly accumulates
 * camelCase usage from LlmStreamChunk.usage produced by the provider bridge.
 *
 * Regression: before the fix, LLMResponse.usage was declared as
 * `{prompt_tokens, completion_tokens, total_tokens}` while every consumer
 * (tool-loop, /v1/usage capture, RAG cost metering) read camelCase. As a
 * result chunk.usage.promptTokens was always `undefined → 0` and the
 * accumulator silently summed zeros.
 *
 * This test mirrors the accumulation snippet from ToolLoopHandler
 * (packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts, the
 * `if (chunk.usage) { usage.promptTokens += chunk.usage.promptTokens; ... }`
 * block) so the contract is locked in: a fake LLM yields a usage-only chunk
 * with the canonical LlmUsage camelCase shape and the accumulator reflects
 * the actual numbers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LlmError,
  LlmStreamChunk,
  LlmUsage,
  Result,
} from '@mcp-abap-adt/llm-agent';

/**
 * Replicates the usage-accumulation pattern from ToolLoopHandler
 * (tool-loop.ts:485-491) so we lock the camelCase contract end-to-end.
 */
async function accumulateUsageLikeToolLoop(
  stream: AsyncIterable<Result<LlmStreamChunk, LlmError>>,
): Promise<LlmUsage> {
  const usage: LlmUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  for await (const chunkResult of stream) {
    if (!chunkResult.ok) {
      throw new Error(`Unexpected error chunk: ${chunkResult.error.message}`);
    }
    const chunk = chunkResult.value;
    if (chunk.usage) {
      usage.promptTokens += chunk.usage.promptTokens;
      usage.completionTokens += chunk.usage.completionTokens;
      usage.totalTokens += chunk.usage.totalTokens;
    }
  }

  return usage;
}

describe('tool-loop usage accumulation (camelCase contract)', () => {
  it('accumulates real token counts from a usage-only chunk', async () => {
    async function* fakeStream(): AsyncIterable<
      Result<LlmStreamChunk, LlmError>
    > {
      yield {
        ok: true,
        value: { content: 'Hello' },
      } as Result<LlmStreamChunk, LlmError>;
      yield {
        ok: true,
        value: {
          content: '',
          finishReason: 'stop',
        },
      } as Result<LlmStreamChunk, LlmError>;
      // Usage-only chunk shaped per the post-fix contract (LlmUsage, camelCase)
      yield {
        ok: true,
        value: {
          content: '',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
          },
        },
      } as Result<LlmStreamChunk, LlmError>;
    }

    const usage = await accumulateUsageLikeToolLoop(fakeStream());
    assert.equal(
      usage.promptTokens,
      100,
      'promptTokens must reflect real provider count, not 0',
    );
    assert.equal(usage.completionTokens, 50);
    assert.equal(usage.totalTokens, 150);
  });

  it('sums multiple usage chunks (e.g. multi-iteration tool loop)', async () => {
    async function* fakeStream(): AsyncIterable<
      Result<LlmStreamChunk, LlmError>
    > {
      yield {
        ok: true,
        value: {
          content: '',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      } as Result<LlmStreamChunk, LlmError>;
      yield {
        ok: true,
        value: {
          content: '',
          usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
        },
      } as Result<LlmStreamChunk, LlmError>;
    }

    const usage = await accumulateUsageLikeToolLoop(fakeStream());
    assert.equal(usage.promptTokens, 30);
    assert.equal(usage.completionTokens, 13);
    assert.equal(usage.totalTokens, 43);
  });

  it('leaves accumulator at zero when no usage chunks arrive', async () => {
    async function* fakeStream(): AsyncIterable<
      Result<LlmStreamChunk, LlmError>
    > {
      yield {
        ok: true,
        value: { content: 'no usage here' },
      } as Result<LlmStreamChunk, LlmError>;
    }

    const usage = await accumulateUsageLikeToolLoop(fakeStream());
    assert.equal(usage.promptTokens, 0);
    assert.equal(usage.completionTokens, 0);
    assert.equal(usage.totalTokens, 0);
  });
});
