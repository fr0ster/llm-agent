import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, OnPartial } from '@mcp-abap-adt/llm-agent';
import { LlmError } from '@mcp-abap-adt/llm-agent';
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
      yield {
        ok: true,
        value: {
          content: 'A',
          usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
        },
      };
      yield { ok: true, value: { content: 'B' } };
      yield {
        ok: true,
        value: {
          content: 'C',
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 3, totalTokens: 3 },
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
  assert.equal(res.model, 'stub-model');
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
  assert.equal(res.model, 'stub-model');
  assert.deepEqual(res.usage, {
    promptTokens: 1,
    completionTokens: 3,
    totalTokens: 4,
  });
});

test('LlmFinalizer preserves the usage and model supplied by an error chunk', async () => {
  const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };
  const error = Object.assign(new LlmError('stream failed'), {
    usage,
    model: 'actual-model',
  });
  const finalizer = new LlmFinalizer({
    chat: async () => assert.fail('Unexpected chat'),
    async *streamChat() {
      yield { ok: false, error };
    },
  });
  await assert.rejects(
    finalizer.finalize({
      prompt: 'p',
      objective: 'o',
      interpreterOutput: 'I',
      executionTrace: [],
    }),
    { message: 'stream failed', model: 'actual-model', usage },
  );
});

test('LlmFinalizer includes earlier attempts in the attribution of a terminal error', async () => {
  const initialUsage = { promptTokens: 3, completionTokens: 1, totalTokens: 4 };
  const terminalUsage = {
    promptTokens: 5,
    completionTokens: 2,
    totalTokens: 7,
  };
  const finalizer = new LlmFinalizer({
    model: 'initial-model',
    chat: async () => assert.fail('Unexpected chat'),
    async *streamChat() {
      yield { ok: true, value: { content: 'discarded', usage: initialUsage } };
      yield { ok: true, value: { content: '', reset: true } };
      yield {
        ok: false,
        error: Object.assign(new LlmError('terminal failure'), {
          usage: terminalUsage,
          model: 'terminal-model',
        }),
      };
    },
  });
  await assert.rejects(
    finalizer.finalize({
      prompt: 'p',
      objective: 'o',
      interpreterOutput: 'I',
      executionTrace: [],
    }),
    {
      message: 'terminal failure',
      usageByModel: {
        'initial-model': { ...initialUsage, requests: 1 },
        'terminal-model': { ...terminalUsage, requests: 1 },
      },
    },
  );
});
