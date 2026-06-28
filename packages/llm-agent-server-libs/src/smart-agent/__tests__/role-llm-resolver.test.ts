import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { RoleLlmResolver } from '../llm/role-llm-resolver.js';

const stub = (tag: string) => ({ tag }) as unknown as ILlm;

function makeFields() {
  return {
    main: stub('main') as ILlm | undefined,
    helper: stub('helper') as ILlm | undefined,
    classifier: stub('classifier') as ILlm | undefined,
  };
}

test('each role returns its cached instance', async () => {
  const f = makeFields();
  const r = new RoleLlmResolver({
    getMain: () => f.main,
    getHelper: () => f.helper,
    getClassifier: () => f.classifier,
    getLlmMap: () => undefined,
    getPipelineFallback: () => undefined,
    makeLlm: async () => stub('built'),
  });
  assert.equal(await r.resolve('main'), f.main);
  assert.equal(await r.resolve('helper'), f.helper);
  assert.equal(await r.resolve('planner'), f.helper); // planner shares helper
  assert.equal(await r.resolve('classifier'), f.classifier);
});

test('unknown role with no map/fallback falls back to main', async () => {
  const f = makeFields();
  const r = new RoleLlmResolver({
    getMain: () => f.main,
    getHelper: () => undefined,
    getClassifier: () => undefined,
    getLlmMap: () => undefined,
    getPipelineFallback: () => undefined,
    makeLlm: async () => stub('built'),
  });
  assert.equal(await r.resolve('reviewer'), f.main);
});

test('hot-swap of main is observed through the live accessor', async () => {
  const f = makeFields();
  const r = new RoleLlmResolver({
    getMain: () => f.main,
    getHelper: () => f.helper,
    getClassifier: () => f.classifier,
    getLlmMap: () => undefined,
    getPipelineFallback: () => undefined,
    makeLlm: async () => stub('built'),
  });
  const swapped = stub('main2');
  f.main = swapped; // simulate _handleConfigUpdate reassignment
  assert.equal(await r.resolve('main'), swapped);
});

test('no main and no config throws', async () => {
  const r = new RoleLlmResolver({
    getMain: () => undefined,
    getHelper: () => undefined,
    getClassifier: () => undefined,
    getLlmMap: () => undefined,
    getPipelineFallback: () => undefined,
    makeLlm: async () => stub('built'),
  });
  await assert.rejects(() => r.resolve('main'), /cannot resolve LLM for role 'main'/);
});
