/**
 * Spec §10.5.9 *The start config*, D83 (11): the reload's check of the
 * selected pipeline's section — the start's parsers, nothing built.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLlmConfig } from '../llm-config-map.js';
import {
  BUILTIN_PIPELINE_PARSERS,
  BUILTIN_PIPELINE_SECTIONS,
  checkReloadedPipeline,
} from '../pipeline-sections.js';
import { runningPipeline } from './reload-document.js';

const LLM = normalizeLlmConfig({ provider: 'ollama', model: 'm' } as never);

function message(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail('expected a throw');
}

test('the built-in section entries cover exactly the built-in pipelines, each parser the start calls', () => {
  assert.deepEqual(Object.keys(BUILTIN_PIPELINE_SECTIONS), [
    'flat',
    'linear',
    'dag',
    'stepper',
    'controller',
    'controller-weak',
  ]);
  for (const [name, entry] of Object.entries(BUILTIN_PIPELINE_SECTIONS)) {
    if (name === 'flat') assert.equal(entry.kind, 'no-section');
    else
      assert.deepEqual(entry, {
        kind: 'parser',
        parse:
          BUILTIN_PIPELINE_PARSERS[
            name as keyof typeof BUILTIN_PIPELINE_PARSERS
          ],
      });
  }
});

test('a valid built-in section passes; an invalid one names the pipeline and the parser', () => {
  checkReloadedPipeline(
    runningPipeline('linear'),
    { name: 'linear', section: { maxSteps: 12 } },
    LLM,
  );
  assert.match(
    message(() =>
      checkReloadedPipeline(
        runningPipeline('linear'),
        { name: 'linear', section: { maxSteps: '10x' } },
        LLM,
      ),
    ),
    /^pipeline 'linear' config invalid — .*maxSteps/,
  );
});

test("dag's key check uses the reloaded llm: keys, not the running server's", () => {
  const dag = { name: 'dag', section: { planner: { plannerLlm: 'strong' } } };
  const withStrong = normalizeLlmConfig({
    main: { provider: 'ollama', model: 'm' },
    strong: { provider: 'ollama', model: 's' },
  } as never);
  checkReloadedPipeline(runningPipeline('dag', dag.section), dag, withStrong); // a key added in the same save
  assert.match(
    message(() =>
      checkReloadedPipeline(runningPipeline('dag', dag.section), dag, LLM),
    ),
    /names llm: key 'strong'/,
  );
});

test('a pipeline change needs a restart; an unknown name names the registry', () => {
  assert.equal(
    message(() =>
      checkReloadedPipeline(
        runningPipeline('flat'),
        { name: 'stepper', section: {} },
        LLM,
      ),
    ),
    "pipeline change needs a restart — the server runs pipeline 'flat', the file selects 'stepper'",
  );
  assert.equal(
    message(() =>
      checkReloadedPipeline(
        runningPipeline('flat'),
        { name: 'nope', section: {} },
        LLM,
      ),
    ),
    "pipeline change needs a restart — the server runs pipeline 'flat', the file selects 'nope'; unknown pipeline 'nope'; available: flat, linear, dag, stepper, controller, controller-weak",
  );
});

test('plugins: an instance export reads no section; a factory passes only its unchanged section', () => {
  const inst = runningPipeline('inst', { a: 1 }, [
    ['inst', { kind: 'no-section' }],
  ]);
  checkReloadedPipeline(inst, { name: 'inst', section: { a: 2 } }, LLM);
  const fac = runningPipeline('ext', { a: { b: [1] } }, [
    ['ext', { kind: 'plugin-factory' }],
  ]);
  checkReloadedPipeline(fac, { name: 'ext', section: { a: { b: [1] } } }, LLM); // deep-equal, a new object
  assert.match(
    message(() =>
      checkReloadedPipeline(
        fac,
        { name: 'ext', section: { a: { b: [2] } } },
        LLM,
      ),
    ),
    /^pipeline 'ext' is a plugin factory with no validation entry/,
  );
});

test('the parse runs once per check and its warnings reach the sink', () => {
  let calls = 0;
  const warned: string[] = [];
  const p = runningPipeline('x', {}, [
    [
      'x',
      {
        kind: 'parser',
        parse: (_s, _l, warn) => {
          calls++;
          warn('w');
        },
      },
    ],
  ]);
  checkReloadedPipeline(
    { ...p, warn: (m) => warned.push(m) },
    { name: 'x', section: {} },
    LLM,
  );
  assert.equal(calls, 1);
  assert.deepEqual(warned, ['w']);
});
