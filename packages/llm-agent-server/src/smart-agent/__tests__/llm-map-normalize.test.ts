import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
