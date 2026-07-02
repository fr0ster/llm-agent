import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LlmFinalizer,
  PassthroughFinalizer,
  TemplateFinalizer,
} from '@mcp-abap-adt/llm-agent-libs';
import { buildFinalizer } from '../config.js';

const stubLlm = {
  chat: async () => ({ content: '', usage: { input: 0, output: 0 } }),
  model: 'stub',
};

const stubLlmConfig = { provider: 'openai' as const, apiKey: 'k', model: 'm' };

test('buildFinalizer: absent block returns PassthroughFinalizer', async () => {
  const f = await buildFinalizer(
    undefined,
    undefined,
    undefined,
    async () => stubLlm as never,
  );
  assert.ok(f instanceof PassthroughFinalizer);
});

test('buildFinalizer: type=passthrough returns PassthroughFinalizer', async () => {
  const f = await buildFinalizer(
    { type: 'passthrough' },
    undefined,
    undefined,
    async () => stubLlm as never,
  );
  assert.ok(f instanceof PassthroughFinalizer);
});

test('buildFinalizer: type=template returns TemplateFinalizer', async () => {
  const f = await buildFinalizer(
    { type: 'template' },
    undefined,
    undefined,
    async () => stubLlm as never,
  );
  assert.ok(f instanceof TemplateFinalizer);
});

test('buildFinalizer: type=llm calls makeLlm with resolved config', async () => {
  let calledWith: unknown;
  const llmMap = { main: stubLlmConfig };
  const f = await buildFinalizer(
    { type: 'llm', finalizerLlm: 'main' },
    llmMap,
    undefined,
    async (cfg) => {
      calledWith = cfg;
      return stubLlm as never;
    },
  );
  assert.ok(f instanceof LlmFinalizer);
  assert.deepEqual(calledWith, stubLlmConfig);
});

test('buildFinalizer: type=llm without any LLM config throws', async () => {
  await assert.rejects(
    () =>
      buildFinalizer({ type: 'llm' }, undefined, undefined, async () => {
        throw new Error('should not be called');
      }),
    /requires an LLM config/,
  );
});
