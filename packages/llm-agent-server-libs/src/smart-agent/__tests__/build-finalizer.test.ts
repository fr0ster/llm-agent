import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  LlmFinalizer,
  PassthroughFinalizer,
  TemplateFinalizer,
} from '@mcp-abap-adt/llm-agent-libs';
import { buildFinalizer } from '../config.js';

const stubLlm = { chat: async () => ({}), model: 'stub' } as unknown as ILlm;
const never = async (): Promise<ILlm> => {
  throw new Error('only type=llm may ask for an LLM');
};

test('absent block, passthrough and template ask for no LLM', async () => {
  assert.ok(
    (await buildFinalizer(undefined, never)) instanceof PassthroughFinalizer,
  );
  assert.ok(
    (await buildFinalizer({ type: 'passthrough' }, never)) instanceof
      PassthroughFinalizer,
  );
  assert.ok(
    (await buildFinalizer({ type: 'template' }, never)) instanceof
      TemplateFinalizer,
  );
});

test('type=llm asks once and wraps the instance', async () => {
  let asked = 0;
  const f = await buildFinalizer(
    { type: 'llm', systemPrompt: 'CUSTOM' },
    async () => {
      asked++;
      return stubLlm;
    },
  );
  assert.ok(f instanceof LlmFinalizer);
  assert.equal(asked, 1);
});

test('type=llm propagates a failed lookup', async () => {
  await assert.rejects(
    () =>
      buildFinalizer({ type: 'llm', finalizerLlm: 'cheep' }, async () => {
        throw new Error("llm: has no entry named 'cheep'");
      }),
    /'cheep'/,
  );
});
