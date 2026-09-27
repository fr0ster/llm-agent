import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { RoleLlmResolver } from '../llm/role-llm-resolver.js';
import type { NormalizedLlmMap } from '../llm-config-map.js';
import type { SmartServerLlmConfig } from '../smart-server.js';

const stub = (tag: string) => ({ tag }) as unknown as ILlm;
const entry = (model: string) =>
  ({ provider: 'openai', model }) as unknown as SmartServerLlmConfig;

function setup(opts: { map?: NormalizedLlmMap; helper?: boolean } = {}) {
  const held: { main?: ILlm; classifier?: ILlm; helper?: ILlm } = {
    main: stub('main'),
    classifier: stub('classifier'),
    helper: opts.helper === false ? undefined : stub('helper'),
  };
  const builds: string[] = [];
  const r = new RoleLlmResolver({
    getMain: () => held.main,
    getHelper: () => held.helper,
    getClassifier: () => held.classifier,
    getLlmMap: () => opts.map,
    build: async (cfg) => {
      builds.push(cfg.model ?? '');
      return stub(`built:${cfg.model}`);
    },
  });
  return { r, held, builds };
}

const MAP = {
  main: entry('m-main'),
  planner: entry('m-planner'),
  reviewer: entry('m-reviewer'),
  classifier: entry('m-classifier'),
} as unknown as NormalizedLlmMap;

test('main, classifier and helper answer with the held instances', async () => {
  const { r, held, builds } = setup({ map: MAP });
  assert.equal(await r.resolve('main'), held.main);
  assert.equal(await r.resolve('classifier'), held.classifier);
  assert.equal(await r.resolve('helper'), held.helper);
  assert.deepEqual(builds, [], 'a held role never builds');
});

test('planner reads as helper when a helper is held — checked before llm.planner', async () => {
  const { r, held, builds } = setup({ map: MAP });
  assert.equal(await r.resolve('planner'), held.helper);
  assert.deepEqual(builds, []);
});

test('planner without a helper falls to its llm: entry', async () => {
  const { r, builds } = setup({ map: MAP, helper: false });
  const a = await r.resolve('planner');
  assert.equal((a as unknown as { tag: string }).tag, 'built:m-planner');
  assert.deepEqual(builds, ['m-planner']);
});

test('any other key is built once and held, across resolve and resolveNamed and concurrent calls', async () => {
  const { r, builds } = setup({ map: MAP });
  const [a, b] = await Promise.all([
    r.resolve('reviewer'),
    r.resolve('reviewer'),
  ]);
  const c = await r.resolveNamed('reviewer');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.deepEqual(builds, ['m-reviewer'], 'one construction per key (§4.6.5)');
});

test('a key with no entry gets the HELD main instance, not a fresh build — and sees a swap', async () => {
  const { r, held, builds } = setup({ map: MAP });
  assert.equal(await r.resolve('evaluator'), held.main);
  const swapped = stub('main2');
  held.main = swapped; // what PUT /v1/config's setMainLlm does
  assert.equal(await r.resolve('evaluator'), swapped);
  assert.equal(await r.resolve('main'), swapped);
  assert.deepEqual(builds, [], 'the old code built llm.main afresh here');
});

test('resolveNamed is strict: no entry, no alias, no fallback — and it names the key', async () => {
  const { r } = setup({
    map: { main: entry('m-main') } as unknown as NormalizedLlmMap,
  });
  await assert.rejects(() => r.resolveNamed('cheep'), /'cheep'/);
  // a helper is held, but no llm.planner entry exists: the alias is resolve's, not resolveNamed's
  await assert.rejects(() => r.resolveNamed('planner'), /'planner'/);
});

test('resolveNamed("main"), ("classifier") and ("helper") answer with the held, swappable instances', async () => {
  const map = {
    main: entry('m-main'),
    classifier: entry('m-classifier'),
    helper: entry('m-helper'),
  } as unknown as NormalizedLlmMap;
  const { r, held, builds } = setup({ map });
  assert.equal(await r.resolveNamed('main'), held.main);
  assert.equal(await r.resolveNamed('classifier'), held.classifier);
  assert.equal(await r.resolveNamed('helper'), held.helper);
  // what PUT /v1/config's setMainLlm / setClassifierLlm do
  held.main = stub('main2');
  held.classifier = stub('classifier2');
  assert.equal(await r.resolveNamed('main'), held.main);
  assert.equal(await r.resolveNamed('classifier'), held.classifier);
  assert.deepEqual(
    builds,
    [],
    'a held role is never built a second time (§4.6.6)',
  );
});

test('a failed build is not held, so the next ask retries', async () => {
  let attempt = 0;
  const r = new RoleLlmResolver({
    getMain: () => stub('main'),
    getHelper: () => undefined,
    getClassifier: () => undefined,
    getLlmMap: () => MAP,
    build: async () => {
      attempt++;
      if (attempt === 1) throw new Error('provider down');
      return stub('ok');
    },
  });
  await assert.rejects(() => r.resolve('reviewer'), /provider down/);
  assert.equal(
    ((await r.resolve('reviewer')) as unknown as { tag: string }).tag,
    'ok',
  );
});

test('no held main throws, naming the role', async () => {
  const r = new RoleLlmResolver({
    getMain: () => undefined,
    getHelper: () => undefined,
    getClassifier: () => undefined,
    getLlmMap: () => undefined,
    build: async () => stub('built'),
  });
  await assert.rejects(
    () => r.resolve('main'),
    /cannot resolve LLM for role 'main'/,
  );
});
