import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, LlmTool, OnPartial } from '@mcp-abap-adt/llm-agent';
import { LlmError } from '@mcp-abap-adt/llm-agent';
import { RetryLlm } from '../../../resilience/retry-llm.js';
import { LlmFinalizer } from '../llm-finalizer.js';

function streamingStubLlm(): {
  llm: ILlm;
  calls: { tools?: LlmTool[] }[];
} {
  const calls: { tools?: LlmTool[] }[] = [];
  const llm: ILlm = {
    model: 'stub-model',
    chat: async () => assert.fail('Unexpected chat'),
    async *streamChat(_messages, tools) {
      calls.push({ tools });
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
  };
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

test('LlmFinalizer preserves an aborted stream error and its usage', async () => {
  const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
  const aborted = new DOMException('Cancelled', 'AbortError');
  const finalizer = new LlmFinalizer({
    model: 'model',
    chat: async () => assert.fail('Unexpected chat'),
    async *streamChat() {
      yield { ok: true, value: { content: 'partial', usage } };
      throw aborted;
    },
  });
  await assert.rejects(
    finalizer.finalize({
      prompt: 'p',
      objective: 'o',
      interpreterOutput: 'I',
      executionTrace: [],
    }),
    { name: 'AbortError', message: 'Cancelled', usage },
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

test('LlmFinalizer keeps every retry model and its request count when a breakdown is supplied', async () => {
  const streamed = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
  const first = { promptTokens: 5, completionTokens: 3, totalTokens: 8 };
  const second = { promptTokens: 9, completionTokens: 3, totalTokens: 12 };
  const last = { promptTokens: 13, completionTokens: 5, totalTokens: 18 };
  let calls = 0;
  const llm = new RetryLlm(
    {
      model: 'second-model',
      chat: async () => assert.fail('Unexpected chat'),
      async *streamChat() {
        calls++;
        if (calls === 1) {
          yield { ok: true, value: { content: 'discarded', usage: streamed } };
          yield {
            ok: false,
            error: Object.assign(new LlmError('retry stream'), {
              usage: streamed,
              model: 'ignored-flat-model',
              usageByModel: {
                'first-model': { ...first, cachedInputTokens: 2, requests: 2 },
                'second-model': { ...second, requests: 3 },
              },
            }),
          };
          return;
        }
        yield { ok: true, value: { content: 'answer', usage: last } };
      },
    },
    { backoffMs: 0, retryOnMidStream: ['retry stream'] },
  );
  const result = await new LlmFinalizer(llm).finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'I',
    executionTrace: [],
  });
  assert.equal(calls, 2);
  assert.equal(result.output, 'answer');
  assert.equal(new Set(result.usageCalls?.map((call) => call.callId)).size, 3);
  assert.deepEqual(result.usageByModel, {
    'first-model': { ...first, cachedInputTokens: 2, requests: 2 },
    'second-model': {
      promptTokens: 22,
      completionTokens: 8,
      totalTokens: 30,
      requests: 4,
    },
  });
});

test('LlmFinalizer counts only the failed attempt when cancelled before a retry', async () => {
  const controller = new AbortController();
  const usage = { promptTokens: 8, completionTokens: 2, totalTokens: 10 };
  let calls = 0;
  const llm = new RetryLlm(
    {
      model: 'first-model',
      chat: async () => assert.fail('Unexpected chat'),
      async *streamChat() {
        calls++;
        yield { ok: true, value: { content: 'discarded', usage } };
        yield { ok: false, error: new LlmError('retry stream') };
      },
    },
    { backoffMs: 0, retryOnMidStream: ['retry stream'] },
  );
  await assert.rejects(
    new LlmFinalizer(llm).finalize({
      prompt: 'p',
      objective: 'o',
      interpreterOutput: 'I',
      executionTrace: [],
      signal: controller.signal,
      onPartial(partial) {
        if (partial.kind === 'iteration-end' && partial.outcome === 'retry')
          controller.abort();
      },
    }),
    {
      code: 'ABORTED',
      usageByModel: { 'first-model': { ...usage, requests: 1 } },
    },
  );
  assert.equal(calls, 1);
});
