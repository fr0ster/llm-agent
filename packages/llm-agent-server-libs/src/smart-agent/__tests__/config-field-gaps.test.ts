/**
 * Spec §10.5.9 D83 (13), (14): fields the start read past the one validator —
 * the log file, an `mcp[]` entry's url, a `--rag-collection-name` override and
 * the readers that took a key written with no value (`null`) as absent. Each is
 * a `ConfigFieldError` (or the validator's issue) naming the field, never a
 * TypeError, a silent default or a stand-in.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSmartServerConfig, type YamlConfig } from '../config.js';
import { ConfigFieldError, FieldCheck } from '../config-fields.js';
import { ConfigValidationError } from '../config-validator.js';
import { parseLinearSettings } from '../pipeline-settings.js';
import {
  resolveLlmSection,
  resolvePipelineSelection,
} from '../resolve-config-sections.js';
import { parseStepperCoordinatorConfig } from '../stepper-config.js';

const LLM = { provider: 'ollama', model: 'm' };

/** The validator's error thrown by `fn`; fails the test when `fn` does not throw one. */
function fieldError(fn: () => unknown): ConfigFieldError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigFieldError, String(err));
    return err;
  }
  assert.fail('expected a ConfigFieldError');
}

const start = (
  yaml: YamlConfig,
  args: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
) => resolveSmartServerConfig(args, { llm: LLM, ...yaml }, env);

test('D83 (14): the log file — a non-empty string named by the source used; the validated value on the resolved config', () => {
  assert.deepEqual(fieldError(() => start({ log: 5 })).issues, [
    'log must be a non-empty string, got 5',
  ]);
  assert.deepEqual(fieldError(() => start({ log: '' })).issues, [
    'log must be a non-empty string, got ""',
  ]);
  assert.deepEqual(fieldError(() => start({ log: null })).issues, [
    'log has no value',
  ]);
  assert.deepEqual(
    fieldError(() => start({ log: './ok.log' }, { 'log-file': true })).issues,
    ['args.log-file must be a non-empty string, got true'],
  );
  // Valid: the source used, by precedence args > log > env; none → undefined.
  assert.equal(start({ log: './a.log' }).logFile, './a.log');
  assert.equal(
    start({ log: './a.log' }, { 'log-file': './b.log' }).logFile,
    './b.log',
  );
  assert.equal(start({}, {}, { LOG_FILE: './c.log' }).logFile, './c.log');
  assert.equal(start({}).logFile, undefined);
});

test('LOG_FILE is the environment: "" is unset; a value is checked only when it is the source used — never under --log-stdout; the YAML log always', () => {
  // A deploy template sets an unset param to "": not set, never an error.
  assert.equal(start({}, {}, { LOG_FILE: '' }).logFile, undefined);
  assert.equal(
    start({}, { 'log-stdout': true }, { LOG_FILE: '' }).logFile,
    undefined,
  );
  // A value that is not the source used is not read.
  assert.equal(
    start({}, { 'log-stdout': true }, { LOG_FILE: '   ' }).logFile,
    undefined,
  );
  assert.equal(
    start({ log: './a.log' }, {}, { LOG_FILE: '   ' }).logFile,
    './a.log',
  );
  // The source used: checked, named so.
  assert.deepEqual(
    fieldError(() => start({}, {}, { LOG_FILE: '   ' })).issues,
    ['env.LOG_FILE must be a non-empty string, got "   "'],
  );
  // The YAML key is the document's: validated always, --log-stdout or not.
  assert.deepEqual(
    fieldError(() => start({ log: 5 }, { 'log-stdout': true })).issues,
    ['log must be a non-empty string, got 5'],
  );
  assert.deepEqual(
    fieldError(() => start({ log: '' }, { 'log-stdout': true })).issues,
    ['log must be a non-empty string, got ""'],
  );
});

test('D83 (9): an mcp[] entry without a type is http — its url is required', () => {
  assert.throws(
    () => start({ mcp: [{ name: 'a' }] }),
    (err: unknown) =>
      err instanceof ConfigValidationError &&
      /mcp\[0\]\.url: required when mcp\[0\]\.type is http/.test(err.message),
  );
  // With a url it passes, the type resolved to http.
  const ok = start({ mcp: [{ name: 'a', url: 'http://m' }] });
  assert.deepEqual(ok.mcp, [{ type: 'http', name: 'a', url: 'http://m' }]);
});

test('D83 (9): --rag-collection-name is checked like every other override', () => {
  const rag = { rag: { store: { type: 'in-memory' } } };
  assert.deepEqual(
    fieldError(() => start(rag, { 'rag-collection-name': true })).issues,
    ['args.rag-collection-name must be a non-empty string, got true'],
  );
  assert.deepEqual(
    fieldError(() => start(rag, { 'rag-collection-name': '' })).issues,
    ['args.rag-collection-name must be a non-empty string, got ""'],
  );
});

test('D83 (13): a reader handed a key with no value names it — never its default', () => {
  // The exported section parsers, called without the start's walk.
  assert.deepEqual(fieldError(() => parseLinearSettings(null)).issues, [
    'pipeline.config has no value',
  ]);
  const pipeline = new FieldCheck();
  resolvePipelineSelection({ pipeline: null } as YamlConfig, pipeline);
  assert.deepEqual(fieldError(() => pipeline.done({})).issues, [
    'pipeline has no value',
  ]);
  for (const [whenThrottled, issue] of [
    [null, 'llm.whenThrottled has no value'],
    [{ strategy: null }, 'llm.whenThrottled.strategy has no value'],
    [
      { strategy: 'wait-as-told', maxAttempts: null },
      'llm.whenThrottled.maxAttempts has no value',
    ],
  ] as const) {
    const check = new FieldCheck();
    resolveLlmSection({ llm: { ...LLM, whenThrottled } } as YamlConfig, check);
    assert.deepEqual(
      fieldError(() => check.done({})).issues,
      [issue],
      JSON.stringify(whenThrottled),
    );
  }
  assert.deepEqual(
    fieldError(() =>
      parseStepperCoordinatorConfig({
        mode: 'cyclic-react',
        flow: { executor: { type: 'cyclic-react', systemPrompt: null } },
      }),
    ).issues,
    ['flow.executor.systemPrompt has no value'],
  );
});
