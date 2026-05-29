import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ILlm,
  LlmTool,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { FINALIZER_SYSTEM, LlmFinalizer } from '../llm-finalizer.js';

function stubLlm(): {
  llm: ILlm;
  calls: Array<{ messages: Message[]; tools: LlmTool[] }>;
} {
  const calls: Array<{ messages: Message[]; tools: LlmTool[] }> = [];
  const llm: ILlm = {
    async chat() {
      // unused
      return { ok: true as const, value: { content: 'UNUSED' } };
    },
    async *streamChat(
      messages: Message[],
      tools?: LlmTool[],
      _opts?: CallOptions,
    ) {
      calls.push({ messages, tools: tools ?? [] });
      yield {
        ok: true as const,
        value: {
          content: 'SYNTH',
          usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
        },
      };
    },
  };
  return { llm, calls };
}

test('LlmFinalizer calls inner ILlm with FINALIZER_SYSTEM and no tools', async () => {
  const { llm, calls } = stubLlm();
  const f = new LlmFinalizer(llm);
  const res = await f.finalize({
    prompt: 'Build report',
    objective: 'compose final answer',
    interpreterOutput: 'IGNORED',
    executionTrace: [
      { nodeId: 'n1', goal: 'analyse', output: 'A' },
      { nodeId: 'n2', goal: 'summarise', output: 'B' },
    ],
  });
  assert.equal(res.output, 'SYNTH');
  assert.deepEqual(res.usage, {
    promptTokens: 3,
    completionTokens: 5,
    totalTokens: 8,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, []);
  assert.equal(calls[0].messages[0].role, 'system');
  assert.equal(calls[0].messages[0].content, FINALIZER_SYSTEM);
  const user = calls[0].messages[1].content as string;
  assert.ok(user.includes('Build report'));
  assert.ok(user.includes('compose final answer'));
  assert.ok(user.includes('n1'));
  assert.ok(user.includes('analyse'));
  assert.ok(user.includes('A'));
  assert.ok(user.includes('n2'));
  assert.ok(user.includes('B'));
});

test('LlmFinalizer honours a custom systemPrompt override', async () => {
  const { llm, calls } = stubLlm();
  const f = new LlmFinalizer(llm, { systemPrompt: 'CUSTOM' });
  await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: '',
    executionTrace: [],
  });
  assert.equal(calls[0].messages[0].content, 'CUSTOM');
});

test('LlmFinalizer renders ancestorContext clarifications and oracle observations', async () => {
  const { llm, calls } = stubLlm();
  const f = new LlmFinalizer(llm);
  await f.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: '',
    ancestorContext: {
      clarifications: [{ question: 'Q1', answer: 'A1' }],
      oracleObservations: [{ query: 'OQ', answer: 'OA' }],
    },
    executionTrace: [],
  });
  const user = calls[0].messages[1].content as string;
  assert.ok(user.includes('Q1'));
  assert.ok(user.includes('A1'));
  assert.ok(user.includes('OQ'));
  assert.ok(user.includes('OA'));
});

test('LlmFinalizer propagates LLM error', async () => {
  const llm: ILlm = {
    async chat() {
      // unused
      return { ok: true as const, value: { content: 'UNUSED' } };
    },
    async *streamChat() {
      yield {
        ok: false as const,
        error: { kind: 'transport' as const, message: 'boom' },
      };
    },
  };
  const f = new LlmFinalizer(llm);
  await assert.rejects(
    () =>
      f.finalize({
        prompt: 'p',
        objective: 'o',
        interpreterOutput: '',
        executionTrace: [],
      }),
    (err: unknown) =>
      typeof err === 'object' &&
      err !== null &&
      (err as { message?: string }).message === 'boom',
  );
});
