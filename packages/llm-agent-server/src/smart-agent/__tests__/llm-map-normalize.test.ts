import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LlmFinalizer,
  PassthroughFinalizer,
  TemplateFinalizer,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  buildFinalizer,
  normalizeLlmConfig,
  resolveLlmConfig,
  resolveReviewerLlmName,
} from '../config.js';

test('normalizeLlmConfig: undefined input returns undefined', () => {
  assert.equal(normalizeLlmConfig(undefined), undefined);
});

test('normalizeLlmConfig: flat shape is wrapped as { main: flat }', () => {
  const flat = { provider: 'deepseek', apiKey: 'k', model: 'm' } as never;
  const out = normalizeLlmConfig(flat);
  assert.ok(out);
  assert.equal(out?.main, flat);
});

test('normalizeLlmConfig: map without main throws', () => {
  assert.throws(
    () =>
      normalizeLlmConfig({
        planner: { provider: 'openai', apiKey: 'k' },
      } as never),
    /must include a 'main' key/,
  );
});

test('normalizeLlmConfig: map with main is returned as-is', () => {
  const map = {
    main: { provider: 'deepseek', apiKey: 'k' },
    planner: { provider: 'sap-ai-sdk', model: 'sonnet' },
  } as never;
  const out = normalizeLlmConfig(map);
  assert.equal(out, map);
});

test('resolveLlmConfig: undefined map + no fallback returns undefined', () => {
  assert.equal(resolveLlmConfig(undefined, 'planner'), undefined);
});

test('resolveLlmConfig: undefined map but pipeline fallback returns the fallback', () => {
  const fallback = { provider: 'deepseek', apiKey: 'k' } as never;
  assert.equal(resolveLlmConfig(undefined, 'planner', fallback), fallback);
});

test('resolveLlmConfig: omitted name resolves to main', () => {
  const map = { main: { provider: 'deepseek', apiKey: 'k' } } as never;
  assert.equal(resolveLlmConfig(map), map.main);
});

test("resolveLlmConfig: name='main' resolves to main", () => {
  const map = { main: { provider: 'deepseek', apiKey: 'k' } } as never;
  assert.equal(resolveLlmConfig(map, 'main'), map.main);
});

test('resolveLlmConfig: named key resolves to its config', () => {
  const map = {
    main: { provider: 'deepseek', apiKey: 'k' },
    planner: { provider: 'sap-ai-sdk', model: 's' },
  } as never;
  assert.equal(resolveLlmConfig(map, 'planner'), map.planner);
});

test('resolveLlmConfig: unknown name falls back to main', () => {
  const map = { main: { provider: 'deepseek', apiKey: 'k' } } as never;
  assert.equal(resolveLlmConfig(map, 'nope'), map.main);
});

test('resolveLlmConfig: map without the named key prefers main over pipeline fallback', () => {
  // The chain is: map[name] → map.main → fallback. If map.main exists,
  // pipeline fallback is NOT used.
  const map = { main: { provider: 'deepseek', apiKey: 'k' } } as never;
  const fallback = { provider: 'openai', apiKey: 'k' } as never;
  assert.equal(resolveLlmConfig(map, 'planner', fallback), map.main);
});

test('resolveReviewerLlmName: prefers reviewerLlm', () => {
  const warnings: string[] = [];
  const r = resolveReviewerLlmName(
    { reviewerLlm: 'planner', plannerLlm: 'main' } as never,
    (m) => warnings.push(m),
  );
  assert.equal(r, 'planner');
  assert.deepEqual(warnings, []);
});

test('resolveReviewerLlmName: accepts deprecated plannerLlm alias and warns', () => {
  const warnings: string[] = [];
  const r = resolveReviewerLlmName({ plannerLlm: 'planner' } as never, (m) =>
    warnings.push(m),
  );
  assert.equal(r, 'planner');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plannerLlm.*deprecated/i);
});

test('resolveReviewerLlmName: empty block returns undefined', () => {
  assert.equal(
    resolveReviewerLlmName(undefined, () => {}),
    undefined,
  );
  assert.equal(
    resolveReviewerLlmName({} as never, () => {}),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// buildFinalizer
// ---------------------------------------------------------------------------

const stubLlm = {
  name: 'stub',
  async chat() {
    return {
      ok: true as const,
      value: {
        content: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  },
};

test('buildFinalizer: omitted block returns PassthroughFinalizer', async () => {
  const f = await buildFinalizer(
    undefined,
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

test('buildFinalizer: type=llm uses resolved LLM from llm map (named override)', async () => {
  let askedFor: string | undefined;
  const map = normalizeLlmConfig({
    main: { provider: 'deepseek', apiKey: 'k' },
    finalizer: { provider: 'sap-ai-sdk', apiKey: 'k', model: 'sonnet' },
  } as never);
  assert.ok(map);
  const f = await buildFinalizer(
    { type: 'llm', finalizerLlm: 'finalizer', systemPrompt: 'CUSTOM' },
    map,
    undefined,
    async (cfg) => {
      askedFor = (cfg as never as { provider: string }).provider;
      return stubLlm as never;
    },
  );
  assert.ok(f instanceof LlmFinalizer);
  assert.equal(askedFor, 'sap-ai-sdk');
});

test('buildFinalizer: type=llm falls back to llm.main when finalizerLlm omitted', async () => {
  const map = normalizeLlmConfig({
    main: { provider: 'deepseek', apiKey: 'k' },
  } as never);
  assert.ok(map);
  let askedFor: string | undefined;
  const f = await buildFinalizer(
    { type: 'llm' },
    map,
    undefined,
    async (cfg) => {
      askedFor = (cfg as never as { provider: string }).provider;
      return stubLlm as never;
    },
  );
  assert.ok(f instanceof LlmFinalizer);
  assert.equal(askedFor, 'deepseek');
});

test('buildFinalizer: type=llm uses pipeline.llm.main fallback when no top-level llm map', async () => {
  const pipelineFallback = {
    provider: 'openai',
    apiKey: 'k',
    model: 'gpt-x',
  } as never;
  let askedFor: string | undefined;
  const f = await buildFinalizer(
    { type: 'llm' },
    undefined,
    pipelineFallback,
    async (cfg) => {
      askedFor = (cfg as never as { provider: string }).provider;
      return stubLlm as never;
    },
  );
  assert.ok(f instanceof LlmFinalizer);
  assert.equal(askedFor, 'openai');
});

test('buildFinalizer: type=llm throws ConfigError when neither map nor pipeline fallback resolves', async () => {
  await assert.rejects(
    buildFinalizer(
      { type: 'llm' },
      undefined,
      undefined,
      async () => stubLlm as never,
    ),
    /requires an LLM config/,
  );
});

test('normalizeLlmConfig: flat ollama config (no apiKey) is detected as flat', () => {
  const flat = { provider: 'ollama', model: 'llama3' } as never;
  const out = normalizeLlmConfig(flat);
  assert.ok(out);
  assert.equal(out?.main, flat);
});

test('normalizeLlmConfig: flat sap-ai-sdk config (no apiKey) is detected as flat', () => {
  const flat = {
    provider: 'sap-ai-sdk',
    model: 'anthropic--claude-4.6-sonnet',
  } as never;
  const out = normalizeLlmConfig(flat);
  assert.ok(out);
  assert.equal(out?.main, flat);
});

test('subagent llm: map shape with main is honored (regression for finding #2)', () => {
  const sub = {
    main: { provider: 'deepseek', apiKey: 'k', model: 'm' },
  } as never;
  const out = normalizeLlmConfig(sub);
  assert.ok(out);
  assert.equal(out.main.apiKey, 'k');
  assert.equal(out.main.model, 'm');
});
