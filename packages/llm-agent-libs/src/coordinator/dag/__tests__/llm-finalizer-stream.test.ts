import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, OnPartial } from '@mcp-abap-adt/llm-agent';
import { LlmFinalizer } from '../llm-finalizer.js';

function streamingStubLlm(): {
  llm: ILlm;
  calls: { messages: unknown; tools: unknown[]; opts: unknown }[];
} {
  const calls: { messages: unknown; tools: unknown[]; opts: unknown }[] = [];
  const llm: ILlm = {
    name: 'stub',
    model: 'stub-model',
    chat: async () => ({ ok: true, value: { content: 'NEVER_CALLED' } }),
    async *streamChat(messages, tools, opts) {
      calls.push({ messages, tools: tools as unknown[], opts });
      yield { ok: true, value: { content: 'A' } };
      yield { ok: true, value: { content: 'B' } };
      yield {
        ok: true,
        value: {
          content: 'C',
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 3, totalTokens: 4 },
        },
      };
    },
  } as unknown as ILlm;
  return { llm, calls };
}

test('LlmFinalizer streams deltas via onPartial and returns concatenated output + usage', async () => {
  const { llm, calls } = streamingStubLlm();
  const f = new LlmFinalizer(llm);
  const deltas: string[] = [];
  const op: OnPartial = (c) => c.kind === 'content' && deltas.push(c.delta);
  const res = await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'I',
    executionTrace: [],
    onPartial: op,
  });
  assert.equal(res.output, 'ABC');
  assert.deepEqual(deltas, ['A', 'B', 'C']);
  assert.deepEqual(res.usage, {
    promptTokens: 1,
    completionTokens: 3,
    totalTokens: 4,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, []);
});

test('LlmFinalizer without onPartial still returns concatenated output + usage', async () => {
  const { llm } = streamingStubLlm();
  const f = new LlmFinalizer(llm);
  const res = await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'I',
    executionTrace: [],
  });
  assert.equal(res.output, 'ABC');
  assert.deepEqual(res.usage, {
    promptTokens: 1,
    completionTokens: 3,
    totalTokens: 4,
  });
});
