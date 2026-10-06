/**
 * Spec §10.5.9 V6, V10, *Config field rules*, D83 (review finding of
 * 2026-10-06): every config field a running server changes is validated
 * before it applies — one validator for the file reload and PUT /v1/config,
 * no coercion. An invalid reload is a failed transaction that applied nothing
 * (the server not ready); an invalid PUT is a 400 naming the field, before
 * the queue.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  ConfigWatcher,
  type HotReloadableInput,
  type SmartAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  parseStepperCoordinatorConfig,
  resolveSmartServerConfig,
  type YamlConfig,
} from '../config.js';
import {
  CONTROLLER_BUDGET_RULES,
  ConfigFieldError,
  FieldCheck,
  NUMBER_LITERAL,
  RELOAD_FIELD_PATHS,
  START_NUMBER_RULES,
  startConfigInput,
  validateAgentUpdate,
  validateModelUpdate,
  validateStartConfig,
} from '../config-fields.js';
import { ConfigReloadWatcher } from '../config-reload-watcher.js';
import { ConfigTransactionQueue } from '../config-transaction-queue.js';
import { ConfigValidationError } from '../config-validator.js';
import { parseIntegerField } from '../decision-config.js';
import {
  handleConfigUpdate,
  type IConfigUpdateTarget,
} from '../http/config-route-handler.js';
import type { ReloadPipeline } from '../pipeline-sections.js';
import {
  parseControllerSettings,
  parseDagSettings,
  parseLinearSettings,
} from '../pipeline-settings.js';
import { parseSkillPluginsConfig } from '../skill-plugins-config.js';
import { SmartServer } from '../smart-server.js';
import { loadYamlConfig, resolveEnvVars } from '../yaml-loader.js';
import { constructionSeams } from './construction-seams.js';
import {
  FLAT_PIPELINE,
  LLM_SECTION,
  reloadDocument,
  runningPipeline,
} from './reload-document.js';
import { jsonRequest, recordingResponse } from './server-test-helpers.js';

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

/**
 * The reload's validation of `input` (spec D83 (10)): the start's rules over a
 * whole document holding these values at the paths `ConfigWatcher` reads them —
 * the values `_applyReload` applies. There is no reloadable-only validator.
 */
const reloaded = (input: HotReloadableInput) =>
  validateStartConfig(reloadDocument(input), {});

test('D83: every rule — the boundary passes, one step outside / a wrong type fails, naming the field', () => {
  // [the field as the error names it, the input with value v, a valid boundary, invalid values]
  const rules: [
    string,
    (v: unknown) => HotReloadableInput,
    unknown,
    unknown[],
  ][] = [
    [
      'agent.maxIterations',
      (v) => ({ maxIterations: v }),
      1,
      [0, 2.5, 'oops', null, Number.NaN, Number.POSITIVE_INFINITY],
    ],
    ['agent.maxToolCalls', (v) => ({ maxToolCalls: v }), 0, [-1, 1.5, '3abc']],
    ['agent.ragQueryK', (v) => ({ ragQueryK: v }), 1, [0, 2.5, ' 5']],
    [
      'agent.toolUnavailableTtlMs',
      (v) => ({ toolUnavailableTtlMs: v }),
      0,
      [-1, Number.NaN, '10m'],
    ],
    [
      'agent.historyAutoSummarizeLimit',
      (v) => ({ historyAutoSummarizeLimit: v }),
      0,
      [-1, 0.5],
    ],
    [
      'agent.toolResultCacheTtlMs',
      (v) => ({ toolResultCacheTtlMs: v }),
      0,
      [-1, Number.POSITIVE_INFINITY],
    ],
    [
      'agent.sessionTokenBudget',
      (v) => ({ sessionTokenBudget: v }),
      0,
      [-1, 1.5],
    ],
    [
      'agent.showReasoning',
      (v) => ({ showReasoning: v }),
      false,
      ['no', 0, null],
    ],
    [
      'agent.classificationEnabled',
      (v) => ({ classificationEnabled: v }),
      true,
      ['yes', 1],
    ],
    [
      'agent.queryExpansionEnabled',
      (v) => ({ queryExpansionEnabled: v }),
      true,
      ['no'],
    ],
    [
      'rag.store.vectorWeight',
      (v) => ({ vectorWeight: v }),
      1,
      [1.01, -0.01, Number.NaN, '0,5'],
    ],
    ['rag.store.keywordWeight', (v) => ({ keywordWeight: v }), 0, [-0.5, 2]],
    ['prompts', (v) => ({ prompts: v }), {}, ['text', [], null]], // `prompts:` (null) → `prompts has no value` (D83 (13))
    [
      'prompts.ragTranslate',
      (v) => ({ prompts: { ragTranslate: v } }),
      'Translate',
      ['', '   ', 5],
    ],
    ['circuitBreaker', (v) => ({ circuitBreaker: v }), {}, [3, null]],
    [
      'circuitBreaker.failureThreshold',
      (v) => ({ circuitBreaker: { failureThreshold: v } }),
      1,
      [0, 1.5],
    ],
    [
      'circuitBreaker.recoveryWindowMs',
      (v) => ({ circuitBreaker: { recoveryWindowMs: v } }),
      0,
      [-1, 'soon'],
    ],
    ['logDir', (v) => ({ logDir: v }), '/var/log/agent', ['', 7]],
  ];
  for (const [field, input, ok, bads] of rules) {
    assert.doesNotThrow(() => reloaded(input(ok)), field);
    for (const bad of bads) {
      const err = fieldError(() => reloaded(input(bad)));
      assert.equal(err.issues.length, 1, `${field} = ${String(bad)}`);
      assert.ok(err.issues[0].startsWith(`${field} `), err.issues[0]);
    }
  }
  // Valid values pass through as they are — nothing coerced or added.
  assert.deepEqual(
    reloaded({ maxIterations: 25, showReasoning: true, vectorWeight: 0.3 }),
    { maxIterations: 25, showReasoning: true, vectorWeight: 0.3 },
  );
  // Every invalid field in one error.
  const both = fieldError(() =>
    reloaded({ maxIterations: 'oops', vectorWeight: 2 }),
  );
  assert.equal(
    both.message,
    'invalid config — agent.maxIterations must be a finite number, got "oops"; rag.store.vectorWeight must be <= 1, got 2',
  );
  // The PUT's two sections, the same rules.
  assert.deepEqual(
    validateAgentUpdate({ maxIterations: 20, showReasoning: false }),
    {
      maxIterations: 20,
      showReasoning: false,
    },
  );
  assert.deepEqual(
    fieldError(() => validateAgentUpdate({ maxIterations: 'oops' })).issues,
    ['agent.maxIterations must be a finite number, got "oops"'],
  );
  assert.deepEqual(validateModelUpdate({ mainModel: 'm1' }), {
    mainModel: 'm1',
  });
  assert.deepEqual(
    fieldError(() => validateModelUpdate({ mainModel: '' })).issues,
    ['models.mainModel must be a non-empty string, got ""'],
  );
});

/**
 * The real watcher over a temp file (`ConfigReloadWatcher.start()` → the real
 * `ConfigWatcher`, its 500 ms debounce), the server's queue and a recorded
 * agent config. `save` writes the file and resolves with the reload's outcome
 * event (`config_reload_failed` / `config_reload_applied`). `env` is the
 * environment the reload substitutes `${VAR}` from (spec D83 (8)). A saved file
 * is a whole config — `LLM_SECTION` first — since a reload validates the whole
 * document as a start would (spec D83 (10)). `pipeline` is the running
 * pipeline and the registry's section entries the reload checks the file's
 * `pipeline` against (spec D83 (11)); `flat` by default, as the files below select.
 */
function reloadHarness(
  t: { after(fn: () => void): void },
  env: NodeJS.ProcessEnv = {},
  pipeline: ReloadPipeline = FLAT_PIPELINE,
) {
  const dir = mkdtempSync(join(tmpdir(), 'config-fields-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'smart-server.yaml');
  writeFileSync(configFile, LLM_SECTION + 'agent:\n  maxIterations: 10\n');
  const queue = new ConfigTransactionQueue();
  const agent: Record<string, unknown> = { maxIterations: 10 };
  const applied: Record<string, unknown>[] = [];
  let outcome: ((e: Record<string, unknown>) => void) | undefined;
  const watcher = new ConfigReloadWatcher({
    configFile,
    log: (e) => {
      if (
        e.event === 'config_reload_failed' ||
        e.event === 'config_reload_applied'
      ) {
        outcome?.(e);
        outcome = undefined;
      }
    },
    applyAgentUpdate: (u) => {
      applied.push(u);
      Object.assign(agent, u);
    },
    mirrorCfg: () => {},
    drainWorkers: async () => {},
    invalidateSessions: async () => {},
    ragStores: {},
    transactions: queue,
    env,
    pipeline,
  });
  watcher.start();
  t.after(() => watcher.stop());
  const save = (yaml: string) => {
    const settled = new Promise<Record<string, unknown>>((resolve) => {
      outcome = resolve;
    });
    writeFileSync(configFile, yaml);
    return settled;
  };
  return { queue, agent, applied, save };
}

test('D83/V6: the real watcher — an invalid value fails the reload and applies nothing; invalid again while not ready stays not ready; a valid one applies', async (t) => {
  const h = reloadHarness(t);
  let e = await h.save(LLM_SECTION + 'agent:\n  maxIterations: oops\n');
  assert.equal(e.event, 'config_reload_failed');
  assert.match(
    String(e.error),
    /config reload failed, the server is not ready until a whole config applies — invalid config — agent\.maxIterations must be a finite number, got "oops"/,
  );
  assert.equal(h.queue.notApplied?.source, 'reload');
  assert.match(h.queue.notApplied?.reason ?? '', /agent\.maxIterations/);
  assert.deepEqual(h.applied, []); // nothing applied — 30.1.0 applied NaN
  assert.equal(h.agent.maxIterations, 10); // the limit unchanged

  e = await h.save(LLM_SECTION + 'agent:\n  maxIterations: 0\n');
  assert.equal(e.event, 'config_reload_failed');
  assert.match(
    h.queue.notApplied?.reason ?? '',
    /agent\.maxIterations must be >= 1, got 0/,
  );
  assert.deepEqual(h.applied, []);
  assert.equal(h.agent.maxIterations, 10);

  e = await h.save(LLM_SECTION + 'agent:\n  maxIterations: 25\n');
  assert.equal(e.event, 'config_reload_applied');
  assert.equal(h.queue.notApplied, undefined); // ready
  assert.equal(h.agent.maxIterations, 25);

  // D83 (6): a number literal string is the number; one with spaces is refused.
  e = await h.save(LLM_SECTION + 'agent:\n  maxIterations: "30"\n');
  assert.equal(e.event, 'config_reload_applied');
  assert.equal(h.agent.maxIterations, 30);
  e = await h.save(LLM_SECTION + 'agent:\n  maxIterations: " 30"\n');
  assert.equal(e.event, 'config_reload_failed');
  assert.match(
    h.queue.notApplied?.reason ?? '',
    /agent\.maxIterations must be a finite number, got " 30"/,
  );
});

test("D83 (10): a reload validates the whole resolved document with the start's validator — a file the server could not start from fails; a valid whole file applies", async (t) => {
  const h = reloadHarness(t);
  const NOT_READY =
    'config reload failed, the server is not ready until a whole config applies — ';
  // No reloadable value to extract — before D83 (10) an empty update that
  // passed, drained and cleared not-ready with the old settings kept.
  let e = await h.save(LLM_SECTION + 'agent: broken\n');
  assert.equal(e.event, 'config_reload_failed');
  assert.equal(
    String(e.error),
    `Error: ${NOT_READY}invalid config — agent must be a mapping, got "broken"`,
  );
  assert.equal(h.queue.notApplied?.source, 'reload');
  assert.deepEqual(h.applied, []);
  // A start-only field the watcher never extracts (D83 (7)); the reloadable value beside it is valid.
  e = await h.save(
    LLM_SECTION +
      'agent:\n  maxIterations: 25\nmcp:\n  type: http\n  url: http://m\n  timeout: 5x\n',
  );
  assert.equal(e.event, 'config_reload_failed');
  assert.match(
    h.queue.notApplied?.reason ?? '',
    /mcp\.timeout must be a finite number, got "5x"/,
  );
  assert.deepEqual(h.applied, []); // still nothing applied, still not ready
  assert.equal(h.agent.maxIterations, 10);
  // A structural error of the start (validateResolvedConfig): no llm section.
  e = await h.save('agent:\n  maxIterations: 25\n');
  assert.equal(e.event, 'config_reload_failed');
  assert.match(h.queue.notApplied?.reason ?? '', /llm: required/);
  assert.deepEqual(h.applied, []);
  // A valid whole file applies — the reload table's values as the start's rules read them.
  e = await h.save(
    LLM_SECTION +
      'agent:\n  maxIterations: "25"\nmcp:\n  type: http\n  url: http://m\n  timeout: 5000\n',
  );
  assert.equal(e.event, 'config_reload_applied');
  assert.equal(h.queue.notApplied, undefined); // ready
  assert.deepEqual(h.applied, [{ maxIterations: 25 }]);
  assert.equal(h.agent.maxIterations, 25);
  // The start refuses the same shapes with the same messages (one rule set).
  assert.deepEqual(
    fieldError(() =>
      validateStartConfig({ agent: 'broken', subagents: 'w' }, {}),
    ).issues,
    [
      'agent must be a mapping, got "broken"',
      'subagents must be a list, got "w"',
    ],
  );
  // D83 (13): a section with no value is an error, not absent.
  assert.deepEqual(
    fieldError(() => validateStartConfig({ agent: null, subagents: null }, {}))
      .issues,
    ['agent has no value', 'subagents has no value'],
  );
});

test("D83 (11): a reload runs the selected pipeline's own section parser — an invalid section fails, a valid one applies, a pipeline change needs a restart, a plugin factory's changed section fails", async (t) => {
  const NOT_READY =
    'config reload failed, the server is not ready until a whole config applies — ';
  const h = reloadHarness(t, {}, runningPipeline('linear'));
  const linear = (section: string) =>
    LLM_SECTION +
    'agent:\n  maxIterations: 25\npipeline:\n  name: linear\n  config:\n' +
    section;
  // Everything the start's validator reads is valid; only the linear parser refuses.
  let e = await h.save(linear('    maxSteps: 10x\n'));
  assert.equal(e.event, 'config_reload_failed');
  assert.ok(
    String(e.error).includes(`${NOT_READY}pipeline 'linear' config invalid — `),
    String(e.error),
  );
  assert.match(String(e.error), /maxSteps/);
  assert.equal(h.queue.notApplied?.source, 'reload'); // not ready
  assert.deepEqual(h.applied, []); // nothing applied — 30.1.0 never looked at pipeline.config
  // A valid section: validated, the reload table applied (the section waits for the next start).
  e = await h.save(linear('    maxSteps: 12\n'));
  assert.equal(e.event, 'config_reload_applied');
  assert.equal(h.queue.notApplied, undefined); // ready
  assert.deepEqual(h.applied, [{ maxIterations: 25 }]);
  // Another pipeline: a restart, even with a valid section.
  const dag = (plannerLlm: string) =>
    LLM_SECTION +
    `pipeline:\n  name: dag\n  config:\n    planner:\n      plannerLlm: ${plannerLlm}\n`;
  e = await h.save(dag('main'));
  assert.equal(e.event, 'config_reload_failed');
  assert.equal(
    String(e.error),
    `Error: ${NOT_READY}pipeline change needs a restart — the server runs pipeline 'linear', the file selects 'dag'`,
  );
  // The new pipeline's parser ran too: its error is named beside the restart.
  e = await h.save(dag('other'));
  assert.equal(e.event, 'config_reload_failed');
  assert.match(
    String(e.error),
    /pipeline change needs a restart — .*; pipeline 'dag' config invalid — pipeline 'dag' names llm: key 'other'/,
  );
  assert.deepEqual(h.applied, [{ maxIterations: 25 }]); // nothing more applied

  // A plugin factory: no validation entry — its section must be the one it was built from.
  const p = reloadHarness(
    t,
    {},
    runningPipeline('ext', { a: 1 }, [['ext', { kind: 'plugin-factory' }]]),
  );
  const ext = (a: number) =>
    LLM_SECTION +
    `agent:\n  maxIterations: 30\npipeline:\n  name: ext\n  config:\n    a: ${a}\n`;
  e = await p.save(ext(1));
  assert.equal(e.event, 'config_reload_applied'); // unchanged: the section the factory accepted at start
  assert.deepEqual(p.applied, [{ maxIterations: 30 }]);
  e = await p.save(ext(2));
  assert.equal(e.event, 'config_reload_failed');
  assert.match(
    String(e.error),
    /pipeline 'ext' is a plugin factory with no validation entry/,
  );
  assert.equal(p.queue.notApplied?.source, 'reload');
  assert.deepEqual(p.applied, [{ maxIterations: 30 }]);
});

test('D83 (12): a present section with the wrong shape is an error — at start and on a reload — never its default', async (t) => {
  const llm = { provider: 'ollama', model: 'm' };
  const sources = [{ id: 'a', records: [] }];
  const skill = (f: Record<string, unknown>) => ({
    skillPlugins: { sources, ...f },
  });
  const memory = { type: 'in-memory' };
  const rag = (f: Record<string, unknown>) => ({
    rag: { store: memory, ...f },
  });
  // [the section the error names, the YAML with it valid, the same YAML with it of the wrong shape]
  const rows: [string, YamlConfig, YamlConfig][] = [
    // The finding: 30.1.0 read both as absent — the default embedder served, maxChars 1500 applied.
    [
      'skillPlugins.embedder',
      skill({ embedder: { provider: 'ollama' } }),
      skill({ embedder: 'sap-ai-core' }),
    ],
    [
      'skillPlugins.embedder',
      skill({ embedder: { provider: 'ollama' } }),
      skill({ embedder: ['sap-ai-core'] }),
    ],
    [
      'skillPlugins.chunk',
      skill({ chunk: { maxChars: 2000 } }),
      skill({ chunk: 2000 }),
    ],
    [
      'skillPlugins.chunk',
      skill({ chunk: { maxChars: 2000 } }),
      skill({ chunk: [{ maxChars: 2000 }] }),
    ],
    // One per other converted section.
    [
      'skillPlugins.embeddingSpaceId',
      skill({ embeddingSpaceId: 'space-1' }),
      skill({ embeddingSpaceId: 1 }),
    ],
    ['llm', { llm }, { llm: 'ollama' }],
    [
      'llm.helper',
      { llm: { main: llm, helper: llm } },
      { llm: { main: llm, helper: 'ollama' } },
    ],
    ['rag', rag({}), { rag: [{ store: memory }] }],
    ['rag.store', rag({}), { rag: { store: [memory] } }],
    // A list: a string embedder is the flat 30.x shape, refused first by its migration guard.
    [
      'rag.embedder',
      rag({ embedder: { provider: 'ollama', model: 'm' } }),
      rag({ embedder: [{ provider: 'ollama' }] }),
    ],
    ['rag.retrieval', rag({ retrieval: {} }), rag({ retrieval: 5 })],
    [
      'rag.retrieval.tools',
      rag({ retrieval: { tools: { strategy: 'embedding' } } }),
      rag({ retrieval: { tools: true } }),
    ],
    [
      'decision',
      { decision: { provider: 'typesafe' } },
      { decision: 'typesafe' },
    ],
    [
      'pipeline.config.knowledgeSeed',
      {
        pipeline: {
          name: 'flat',
          config: { knowledgeSeed: [{ content: 'c' }] },
        },
      },
      {
        pipeline: { name: 'flat', config: { knowledgeSeed: { content: 'c' } } },
      },
    ],
  ];
  // A section: `must be a mapping` / `must be a list`; embeddingSpaceId, a field read the same way: `must be a non-empty string`.
  const issueOf = (field: string) =>
    new RegExp(
      `^${field.replace(/\./g, '\\.')} must be a (mapping|list|non-empty string), got `,
    );
  // At start: the start fails, exactly that section named.
  for (const [field, ok, bad] of rows) {
    acceptsField(() => resolveSmartServerConfig({}, { llm, ...ok }, {}), field);
    const err = fieldError(() =>
      resolveSmartServerConfig({}, { llm, ...bad }, {}),
    );
    assert.equal(err.issues.length, 1, `${field}: ${err.message}`);
    assert.match(err.issues[0], issueOf(field));
  }
  // `skillPlugins` itself: present, so its parser refuses it (30.1.0: `false` → no skill plugins).
  assert.throws(
    () => resolveSmartServerConfig({}, { llm, skillPlugins: false }, {}),
    /skillPlugins: config must be an object/,
  );
  // A section not written takes its default (written with no value it is an error — D83 (13), next case).
  const absent = resolveSmartServerConfig(
    {},
    { llm, ...skill({}), ...rag({}) },
    {},
  );
  assert.equal(absent.skillPlugins?.embedder, undefined);
  assert.deepEqual(absent.skillPlugins?.chunk, { maxChars: 1500 });
  assert.equal(absent.rag?.embedder, undefined);

  // On a reload: the same file fails — not ready, nothing applied.
  const h = reloadHarness(t);
  const base = parseYaml(LLM_SECTION) as Record<string, unknown>;
  for (const [field, , bad] of rows) {
    const e = await h.save(
      stringifyYaml({ ...base, agent: { maxIterations: 25 }, ...bad }),
    );
    assert.equal(e.event, 'config_reload_failed', field);
    assert.ok(
      String(e.error).includes(`${field} must be a `),
      `${field}: ${String(e.error)}`,
    );
    assert.equal(h.queue.notApplied?.source, 'reload', field);
    assert.deepEqual(h.applied, [], field);
  }
  // The repaired file applies.
  const e = await h.save(
    stringifyYaml({
      ...base,
      agent: { maxIterations: 25 },
      ...skill({ embedder: { provider: 'ollama' } }),
    }),
  );
  assert.equal(e.event, 'config_reload_applied');
  assert.equal(h.queue.notApplied, undefined);

  // The server's session seed: a config built in code is checked at start too (read once).
  const startable = resolveSmartServerConfig({}, { llm }, {});
  const server = new SmartServer(
    {
      ...startable,
      pipeline: { name: 'flat', config: { knowledgeSeed: 'use GetTable' } },
      port: 0,
      host: '127.0.0.1',
      skipModelValidation: true,
    },
    constructionSeams,
  );
  await assert.rejects(
    () => server.start(),
    (err: unknown) =>
      err instanceof ConfigFieldError &&
      /^pipeline\.config\.knowledgeSeed must be a list, got "use GetTable"$/.test(
        err.issues[0],
      ),
  );
});

test('D83 (13): a key written with no value is an error — at start, on a reload and on PUT; a default only when the key is absent', async (t) => {
  const start = (yaml: string) =>
    resolveSmartServerConfig(
      {},
      parseYaml(LLM_SECTION + yaml) as YamlConfig,
      {},
    );
  const issues = (yaml: string) => fieldError(() => start(yaml)).issues;
  // [the path the error names, the YAML with the key written with no value, the same YAML without the key, the default the absent key takes]
  const rows: [
    string,
    string,
    string,
    (cfg: ReturnType<typeof start>) => void,
  ][] = [
    [
      'rag.embedder',
      'rag:\n  store: { type: in-memory }\n  embedder:\n',
      'rag:\n  store: { type: in-memory }\n',
      (c) => assert.equal(c.rag?.embedder, undefined),
    ],
    ['prompts', 'prompts:\n', '', (c) => assert.equal(c.prompts, undefined)],
    [
      'skillPlugins.store',
      'skillPlugins:\n  sources: [{ id: a, records: [] }]\n  store:\n',
      'skillPlugins:\n  sources: [{ id: a, records: [] }]\n',
      (c) => assert.deepEqual(c.skillPlugins?.store, { type: 'in-memory' }),
    ],
  ];
  for (const [path, written, absent, isDefault] of rows) {
    // Exactly one issue: the walk and the reader that reads the key name it once.
    assert.deepEqual(issues(written), [`${path} has no value`], path);
    isDefault(start(absent));
  }
  // `~` and `null` written out are the same null; a field, a map entry, a list item and a key
  // inside pipeline.config are named at their paths; two keys → one error naming both.
  assert.deepEqual(issues('prompts: ~\n'), ['prompts has no value']);
  assert.deepEqual(issues('prompts: null\n'), ['prompts has no value']);
  assert.deepEqual(issues('agent:\n  maxIterations:\n'), [
    'agent.maxIterations has no value',
  ]);
  assert.deepEqual(
    issues(
      'mcp:\n  type: http\n  url: http://m\n  headers:\n    Authorization:\n',
    ),
    ['mcp.headers.Authorization has no value'],
  );
  assert.deepEqual(issues('plugins: [a, ~]\n'), ['plugins[1] has no value']);
  assert.deepEqual(
    issues(
      'pipeline:\n  name: stepper\n  config:\n    stepper:\n      maxDepth:\n',
    ),
    ['pipeline.config.stepper.maxDepth has no value'],
  );
  assert.deepEqual(issues('agent:\nprompts:\n'), [
    'agent has no value',
    'prompts has no value',
  ]);
  // `llm:` with no value is named — not `llm: required` (30.1.0: a TypeError); not written, it is `llm: required`.
  assert.deepEqual(
    fieldError(() => resolveSmartServerConfig({}, { llm: null }, {})).issues,
    ['llm has no value'],
  );
  assert.throws(() => resolveSmartServerConfig({}, {}, {}), /llm: required/);
  // ${VAR} never yields a null: unset with no default it is "" and fails its rule as before; a null stays a null.
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        resolveEnvVars(
          parseYaml(LLM_SECTION + 'agent:\n  maxIterations: ${MAX}\n'),
          {},
        ) as YamlConfig,
        {},
      ),
    ).issues,
    ['agent.maxIterations must be a finite number, got ""'],
  );
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        resolveEnvVars(parseYaml(LLM_SECTION + 'prompts:\n'), {}) as YamlConfig,
        {},
      ),
    ).issues,
    ['prompts has no value'],
  );
  // A worker file: the issue names the worker and its file; a worker's `llm:` with no value names the worker.
  const dir = mkdtempSync(join(tmpdir(), 'no-value-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, 'main.yaml');
  writeFileSync(
    main,
    LLM_SECTION + 'subagents:\n  - name: w\n    config: ./w.yaml\n',
  );
  writeFileSync(join(dir, 'w.yaml'), 'agent:\n');
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        loadYamlConfig(main, {}),
        {},
        { configPath: main },
      ),
    ).issues,
    [`subagent 'w' (${join(dir, 'w.yaml')}): agent has no value`],
  );
  writeFileSync(join(dir, 'w.yaml'), 'llm:\n');
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        loadYamlConfig(main, {}),
        {},
        { configPath: main },
      ),
    ).issues,
    ["subagent 'w': llm has no value"],
  );

  // On a reload: the same files fail — not ready, nothing applied; the repaired file applies.
  const h = reloadHarness(t);
  for (const [path, written] of rows) {
    const e = await h.save(
      LLM_SECTION + 'agent:\n  maxIterations: 25\n' + written,
    );
    assert.equal(e.event, 'config_reload_failed', path);
    assert.ok(
      String(e.error).includes(`${path} has no value`),
      `${path}: ${String(e.error)}`,
    );
    assert.equal(h.queue.notApplied?.source, 'reload', path);
    assert.deepEqual(h.applied, [], path);
  }
  const repaired = await h.save(
    LLM_SECTION + 'agent:\n  maxIterations: 25\n' + rows[0][2],
  );
  assert.equal(repaired.event, 'config_reload_applied');
  assert.equal(h.queue.notApplied, undefined);

  // PUT /v1/config: a JSON null is a key with no value → 400; nothing resolved, applied or queued.
  for (const [raw, issue] of [
    ['{"agent":null}', 'agent has no value'],
    ['{"models":null}', 'models has no value'],
    ['{"agent":{"maxIterations":null}}', 'agent.maxIterations has no value'],
  ] as const) {
    const p = putHarness();
    const r = await p.put(raw);
    assert.equal(r.status, 400, raw);
    assert.equal(r.error.message, `invalid config — ${issue}`, raw);
    assert.deepEqual(p.calls, [], raw);
    assert.equal(p.queue.notApplied, undefined, raw);
  }
  // While not ready, a whole PUT with "agent": null is a 400, not a 409 — a null section is not a missing one.
  const p = putHarness();
  await p.queue
    .run('put', 'full', async () => {
      throw new Error('drain failed');
    })
    .catch(() => {});
  const before = p.queue.notApplied;
  assert.ok(before);
  const r = await p.put('{"models":{"mainModel":"m1"},"agent":null}');
  assert.equal(r.status, 400);
  assert.equal(r.error.message, 'invalid config — agent has no value');
  assert.equal(p.queue.notApplied, before);
});

/** Every mapping, list and list item under `doc`, by the path the validator names it (`a.b`, `a[0]`). */
function shapePaths(
  doc: unknown,
  path = '',
): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  if (Array.isArray(doc)) {
    doc.forEach((v: unknown, i) => {
      const p = `${path}[${i}]`;
      out.push({ path: p, value: v }, ...shapePaths(v, p));
    });
  } else if (doc !== null && typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc)) {
      const p = path === '' ? k : `${path}.${k}`;
      if (v !== null && typeof v === 'object') out.push({ path: p, value: v });
      out.push(...shapePaths(v, p));
    }
  }
  return out;
}

/** A deep copy of `doc` with `value` at `path` (`a.b[0].c`; the parent exists). */
function withAt(
  doc: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const out = structuredClone(doc);
  const keys = path.match(/[^.[\]]+/g) ?? [];
  let at = out as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
  at[keys[keys.length - 1] as string] = value;
  return out;
}

/** Values of the wrong shape for what `v` is: `null`, a scalar, the other container (an item: a scalar of the other type). */
const wrongFor = (v: unknown): unknown[] =>
  Array.isArray(v)
    ? [null, 5, 'x']
    : v !== null && typeof v === 'object'
      ? [null, 5, []]
      : [null, [], typeof v === 'number' ? 'x' : 5];

/**
 * `fn` with `path` given each wrong value: a `ConfigFieldError` with an issue
 * naming the path — never a `TypeError`; a path in `ownError` (a reader that
 * fails at once with its own `Error`, spec D83 (12) (6)): that `Error`, never a
 * `TypeError`.
 */
function assertShapeErrors(
  label: string,
  doc: Record<string, unknown>,
  paths: readonly { path: string; wrong: unknown[] }[],
  fn: (doc: Record<string, unknown>) => unknown,
  ownError: (path: string) => boolean,
): void {
  assert.doesNotThrow(() => fn(doc), `${label}: the document itself`);
  for (const { path, wrong } of paths) {
    for (const value of wrong) {
      const at = `${label} ${path} = ${JSON.stringify(value)}`;
      let thrown: unknown;
      try {
        fn(withAt(doc, path, value));
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof Error, `${at}: expected an error`);
      assert.ok(!(thrown instanceof TypeError), `${at}: ${String(thrown)}`);
      if (thrown instanceof ConfigFieldError) {
        assert.ok(
          thrown.issues.some((i) => i.startsWith(`${path} `)),
          `${at}: ${thrown.message}`,
        );
      } else {
        assert.ok(
          ownError(path),
          `${at}: not a ConfigFieldError — ${String(thrown)}`,
        );
      }
    }
  }
}

test('D83 (14): a shape before a field — every section, list item and reload-table field of the wrong shape is a ConfigFieldError, never a TypeError', async (t) => {
  const llm = {
    main: { provider: 'ollama', model: 'm' },
    helper: { provider: 'ollama', model: 'm' },
  };
  // Every section the start's readers check, every list with an item (D83 (9), (12)).
  const common = {
    llm,
    agent: {
      maxIterations: 10,
      retry: {
        maxAttempts: 2,
        retryOn: [503],
        retryOnMidStream: ['ECONNRESET'],
      },
      toolSelection: { strategy: 'top-k' },
    },
    rag: {
      store: { type: 'in-memory' },
      embedder: { provider: 'ollama', model: 'm' },
      retrieval: { history: { strategy: 'embedding' } },
    },
    prompts: { system: 'S' },
    circuitBreaker: { failureThreshold: 3 },
    plugins: ['p'],
    skills: { type: 'claude', dirs: ['d'] },
    decision: { provider: 'typesafe' },
    pipeline: { name: 'flat', config: { knowledgeSeed: [{ content: 'c' }] } },
    skillPlugins: {
      sources: [{ id: 'a', records: [] }],
      chunk: { maxChars: 2000 },
      embedder: { provider: 'ollama' },
    },
  };
  const documents: Record<string, Record<string, unknown>> = {
    'mcp list': {
      ...common,
      mcp: [
        {
          type: 'http',
          url: 'http://m',
          name: 'a',
          headers: { Authorization: 'x' },
          toolTimeouts: { slow: 1000 },
        },
        { type: 'stdio', command: 'srv', args: ['--x'] },
      ],
    },
    'mcp single': {
      ...common,
      mcp: {
        type: 'http',
        url: 'http://m',
        headers: { Authorization: 'x' },
        toolTimeouts: { slow: 1000 },
      },
    },
  };
  // Readers that fail at once with their own Error (D83 (12) (6)); a null there is still named by the walk.
  const startOwnError = (p: string) =>
    p === 'pipeline' ||
    p === 'skillPlugins' ||
    p.startsWith('skillPlugins.sources');
  for (const [label, doc] of Object.entries(documents)) {
    const paths = [
      // Generated from the document: every mapping, list and list item. `mcp` takes a mapping or a list.
      ...shapePaths(doc).map(({ path, value }) => ({
        path,
        wrong: path === 'mcp' ? [null, 5, 'x'] : wrongFor(value),
      })),
      // Generated from the rule tables: every field of the reload table.
      ...RELOAD_FIELD_PATHS.map((path) => ({ path, wrong: [null, [], {}] })),
    ];
    assertShapeErrors(
      label,
      doc,
      paths,
      (d) => resolveSmartServerConfig({}, d, {}),
      startOwnError,
    );
  }
  // The pipeline sections, through their parsers (named as the key inside `pipeline.config`).
  const sections: [
    string,
    (s: Record<string, unknown>) => unknown,
    Record<string, unknown>,
    (p: string) => boolean,
  ][] = [
    [
      'dag',
      (s) => parseDagSettings(s, () => {}),
      {
        planner: {},
        reviewer: {},
        errorStrategy: { type: 'abort' },
        finalizer: {},
      },
      () => false,
    ],
    [
      'controller',
      (s) => parseControllerSettings(s, new Set(['main'])),
      {
        subagents: { evaluator: {}, planner: {}, executor: {} },
        targetState: { strategy: 'auto' },
        sessionMemory: { collection: 'session-memory' },
        budgets: { maxSteps: 20 },
      },
      (p) => p.startsWith('subagents'), // parseControllerSubagents: its own Error
    ],
    [
      'stepper',
      (s) => parseStepperCoordinatorConfig(s),
      {
        mode: 'planned-react',
        stepper: { reviewer: { atDepths: [0] } },
        knowledgeSeed: [{ content: 'c' }],
        flow: {
          planner: { type: 'static' },
          executor: {},
          finalizer: {},
          evaluator: { atDepths: [1] },
          plan: [
            { id: 'a', goal: 'g' },
            { id: 'b', goal: 'h', dependsOn: ['a'] },
          ],
        },
      },
      () => false,
    ],
  ];
  for (const [label, parse, section, ownError] of sections) {
    const paths = [
      ...shapePaths(section).map(({ path, value }) => ({
        path,
        wrong: wrongFor(value),
      })),
      ...(label === 'controller'
        ? Object.keys(CONTROLLER_BUDGET_RULES).map((k) => ({
            path: `budgets.${k}`,
            wrong: [null, [], 'x'],
          }))
        : []),
    ];
    assertShapeErrors(label, section, paths, parse, ownError);
  }

  // The finding: `mcp: [null]` is named, at start, on a reload and in a worker file — never a TypeError.
  const flat = { provider: 'ollama', model: 'm' };
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig({}, { llm: flat, mcp: [null] }, {}),
    ).issues,
    ['mcp[0] has no value'],
  );
  assert.deepEqual(
    fieldError(() => resolveSmartServerConfig({}, { llm: flat, mcp: [5] }, {}))
      .issues,
    ['mcp[0] must be a mapping, got 5'],
  );
  // The labels: issues of the same check, every one named (30.1.0 threw at the first).
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        {
          llm: flat,
          mcp: [
            { url: 'http://a', name: 'a b' },
            { url: 'http://b', name: 'x' },
            { url: 'http://c', name: 'x' },
          ],
        },
        {},
      ),
    ).issues,
    [
      'mcp[0].name must be a label of letters, digits, _ and -, got "a b"',
      'mcp[2].name must be unique among the mcp entries, got "x"',
    ],
  );
  const h = reloadHarness(t);
  const NOT_READY =
    'config reload failed, the server is not ready until a whole config applies — ';
  const e = await h.save(LLM_SECTION + 'mcp: [~]\n');
  assert.equal(e.event, 'config_reload_failed');
  assert.equal(
    String(e.error),
    `Error: ${NOT_READY}invalid config — mcp[0] has no value`,
  );
  assert.equal(h.queue.notApplied?.source, 'reload');
  assert.deepEqual(h.applied, []);
  const dir = mkdtempSync(join(tmpdir(), 'shape-first-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, 'main.yaml');
  const worker = join(dir, 'w.yaml');
  writeFileSync(
    main,
    LLM_SECTION + 'subagents:\n  - name: w\n    config: ./w.yaml\n',
  );
  writeFileSync(worker, 'mcp: [~]\n');
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        loadYamlConfig(main, {}),
        {},
        { configPath: main },
      ),
    ).issues,
    [`subagent 'w' (${worker}): mcp[0] has no value`],
  );
  // The document: a mapping — a worker's before parseSubAgents reads it, prefixed; an empty file is {}.
  writeFileSync(worker, '- a\n');
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        loadYamlConfig(main, {}),
        {},
        { configPath: main },
      ),
    ).issues,
    [`subagent 'w' (${worker}): config must be a mapping, got ["a"]`],
  );
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig({}, 5 as unknown as YamlConfig, {}),
    ).issues,
    ['config must be a mapping, got 5'],
  );
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig({}, [] as unknown as YamlConfig, {}),
    ).issues,
    ['config must be a mapping, got []'],
  );
  const empty = join(dir, 'empty.yaml');
  writeFileSync(empty, '');
  assert.deepEqual(loadYamlConfig(empty, {}), {});
  assert.throws(
    () => resolveSmartServerConfig({}, loadYamlConfig(empty, {}), {}),
    /llm: required/,
  ); // 30.1.0: a TypeError
});

/** `handleConfigUpdate` over a recording target with a model resolver; `put` sends a raw body. */
function putHarness() {
  const queue = new ConfigTransactionQueue();
  const calls: string[] = [];
  const agent = {
    applyConfigUpdate: () => calls.push('applyConfigUpdate'),
    reconfigure: () => calls.push('reconfigure'),
    getActiveConfig: () => ({}),
    getAgentConfig: () => ({}),
  } as unknown as SmartAgent;
  const target: IConfigUpdateTarget = {
    modelResolver: {
      resolve: async (name: string) => {
        calls.push(`resolve ${name}`);
        return { model: name } as unknown as ILlm;
      },
    },
    skipModelValidation: true,
    setMainLlm: (llm) => llm,
    setClassifierLlm: (llm) => llm,
    setHelperLlm: (llm) => llm,
    mirrorAgentCfg: () => calls.push('mirrorAgentCfg'),
    drainWorkers: async () => {
      calls.push('drainWorkers');
    },
    invalidateSessions: async () => {},
    transactions: queue,
  };
  const put = async (raw: string) => {
    const { reply, res } = recordingResponse();
    await handleConfigUpdate(jsonRequest(raw), res, agent, target);
    return {
      status: reply.status,
      error: JSON.parse(reply.body ?? '{}').error,
    };
  };
  return { queue, calls, put };
}

test('D83/V10: an invalid PUT value → 400 naming the field; nothing resolved, applied or queued', async () => {
  const cases: [string, RegExp][] = [
    [
      '{"agent":{"maxIterations":"oops"}}',
      /^invalid config — agent\.maxIterations must be a finite number, got "oops"$/,
    ],
    [
      '{"agent":{"maxIterations":null}}',
      /^invalid config — agent\.maxIterations has no value$/,
    ], // D83 (13)
    [
      '{"agent":{"maxIterations":1e999}}',
      /agent\.maxIterations must be a finite number, got Infinity/,
    ],
    [
      '{"agent":{"maxIterations":0}}',
      /agent\.maxIterations must be >= 1, got 0/,
    ],
    [
      '{"agent":{"ragQueryK":2.5}}',
      /agent\.ragQueryK must be an integer, got 2\.5/,
    ],
    [
      '{"agent":{"showReasoning":"yes"}}',
      /agent\.showReasoning must be true or false, got "yes"/,
    ],
    [
      '{"agent":{"maxIterations":" 25"}}',
      /agent\.maxIterations must be a finite number, got " 25"/,
    ],
    [
      '{"models":{"mainModel":""}}',
      /models\.mainModel must be a non-empty string, got ""/,
    ],
    [
      '{"agent":{"maxIterations":"oops","maxToolCalls":-1}}',
      /agent\.maxIterations .*; agent\.maxToolCalls must be >= 0, got -1/,
    ],
  ];
  for (const [raw, message] of cases) {
    const h = putHarness();
    const r = await h.put(raw);
    assert.equal(r.status, 400, raw);
    assert.equal(r.error.type, 'invalid_request_error', raw);
    assert.match(r.error.message, message);
    assert.deepEqual(h.calls, [], raw); // no model resolved, nothing applied, no drain
    assert.equal(h.queue.notApplied, undefined, raw);
  }
  // A valid one applies, as before — a number literal string too (D83 (6)).
  for (const raw of [
    '{"agent":{"maxIterations":25}}',
    '{"agent":{"maxIterations":"25","showReasoning":"true"}}',
  ]) {
    const h = putHarness();
    assert.equal((await h.put(raw)).status, 200, raw);
    assert.deepEqual(
      h.calls,
      ['applyConfigUpdate', 'mirrorAgentCfg', 'drainWorkers'],
      raw,
    );
  }
});

test('D83/V10, D82 (8): while not ready, a whole PUT with an invalid value → 400 (not 409), the state the same object', async () => {
  const h = putHarness();
  await h.queue
    .run('put', 'full', async () => {
      throw new Error('drain failed');
    })
    .catch(() => {});
  const before = h.queue.notApplied;
  assert.ok(before);
  const r = await h.put(
    '{"models":{"mainModel":"m1"},"agent":{"maxIterations":"oops"}}',
  );
  assert.equal(r.status, 400);
  assert.match(
    r.error.message,
    /agent\.maxIterations must be a finite number, got "oops"/,
  );
  assert.deepEqual(h.calls, []);
  assert.equal(h.queue.notApplied, before);
});

test('D83 (5): the start config — every rule at its YAML path, the same error, nothing coerced; the overrides named so', () => {
  // [the field as the error names it, the YAML holding v, a valid value, an invalid one]
  const at: [string, (v: unknown) => YamlConfig, unknown, unknown][] = [
    [
      'agent.maxIterations',
      (v) => ({ agent: { maxIterations: v } }),
      1,
      'oops',
    ],
    ['agent.maxToolCalls', (v) => ({ agent: { maxToolCalls: v } }), 0, -1],
    ['agent.ragQueryK', (v) => ({ agent: { ragQueryK: v } }), 1, 2.5],
    [
      'agent.toolUnavailableTtlMs',
      (v) => ({ agent: { toolUnavailableTtlMs: v } }),
      0,
      '10m',
    ],
    [
      'agent.historyAutoSummarizeLimit',
      (v) => ({ agent: { historyAutoSummarizeLimit: v } }),
      0,
      -1,
    ],
    [
      'agent.toolResultCacheTtlMs',
      (v) => ({ agent: { toolResultCacheTtlMs: v } }),
      0,
      Number.NaN,
    ],
    [
      'agent.sessionTokenBudget',
      (v) => ({ agent: { sessionTokenBudget: v } }),
      0,
      1.5,
    ],
    [
      'agent.showReasoning',
      (v) => ({ agent: { showReasoning: v } }),
      true,
      'off',
    ],
    [
      'agent.classificationEnabled',
      (v) => ({ agent: { classificationEnabled: v } }),
      false,
      1,
    ],
    [
      'agent.queryExpansionEnabled',
      (v) => ({ agent: { queryExpansionEnabled: v } }),
      false,
      'no',
    ],
    [
      'rag.store.vectorWeight',
      (v) => ({ rag: { store: { type: 'in-memory', vectorWeight: v } } }),
      0.4,
      '0.5 ',
    ],
    [
      'rag.store.keywordWeight',
      (v) => ({ rag: { store: { type: 'in-memory', keywordWeight: v } } }),
      0.6,
      2,
    ],
    ['prompts', (v) => ({ prompts: v }), { system: 'S' }, 'text'],
    ['prompts.system', (v) => ({ prompts: { system: v } }), 'S', ''],
    [
      'circuitBreaker.failureThreshold',
      (v) => ({ circuitBreaker: { failureThreshold: v } }),
      3,
      0,
    ],
    ['logDir', (v) => ({ logDir: v }), '/var/log/agent', ''],
  ];
  for (const [field, yaml, ok, bad] of at) {
    assert.doesNotThrow(() => validateStartConfig(yaml(ok), {}), field);
    const err = fieldError(() => validateStartConfig(yaml(bad), {}));
    assert.equal(err.issues.length, 1, field);
    assert.ok(err.issues[0].startsWith(`${field} `), err.issues[0]);
  }
  // A non-in-memory store's weights are not read here, as by the reload
  // (validateResolvedConfig refuses them, as in 30.1.0).
  assert.deepEqual(
    validateStartConfig(
      { rag: { store: { type: 'qdrant', vectorWeight: 'x' } } },
      {},
    ),
    {},
  );
  // Every invalid field in one error — the reload's and the PUT's message.
  assert.equal(
    fieldError(() =>
      validateStartConfig(
        {
          agent: { maxIterations: 'oops' },
          rag: { store: { type: 'in-memory', vectorWeight: 2 } },
        },
        {},
      ),
    ).message,
    'invalid config — agent.maxIterations must be a finite number, got "oops"; rag.store.vectorWeight must be <= 1, got 2',
  );
  // The two ResolveConfigArgs overrides: checked in place, named so; a valid one wins.
  assert.deepEqual(
    fieldError(() =>
      validateStartConfig({}, { 'agent-show-reasoning': 'yes', 'log-dir': '' }),
    ).issues,
    [
      'args.agent-show-reasoning must be true or false, got "yes"',
      'args.log-dir must be a non-empty string, got ""',
    ],
  );
  assert.deepEqual(
    validateStartConfig(
      { agent: { showReasoning: false }, logDir: 'a' },
      { 'agent-show-reasoning': true, 'log-dir': 'b' },
    ),
    { showReasoning: true, logDir: 'b' },
  );
});

test('D83 (5): the start reads the paths the reload reads — startConfigInput equals the real ConfigWatcher event for the same file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'start-fields-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'smart-server.yaml');
  const yaml = [
    'agent:',
    '  maxIterations: oops',
    '  maxToolCalls: 3',
    '  ragQueryK: 4',
    '  toolUnavailableTtlMs: 5',
    '  historyAutoSummarizeLimit: 6',
    '  toolResultCacheTtlMs: 7',
    '  sessionTokenBudget: 8',
    '  showReasoning: "no"',
    '  classificationEnabled: true',
    '  queryExpansionEnabled: false',
    '  contextBudgetTokens: 9',
    'rag:',
    '  store: { type: in-memory, vectorWeight: 0.4, keywordWeight: "x", dedupThreshold: 0.5 }',
    'prompts: { system: S, other: O }',
    'circuitBreaker: { failureThreshold: 2 }',
    'logDir: ""',
    '',
  ].join('\n');
  writeFileSync(file, 'agent: {}\n');
  const watcher = new ConfigWatcher(file, { debounceMs: 50 });
  const event = new Promise<HotReloadableInput>((resolve) =>
    watcher.once('reload', resolve),
  );
  watcher.start();
  t.after(() => watcher.stop());
  await new Promise((r) => setTimeout(r, 100));
  writeFileSync(file, yaml);
  assert.deepEqual(
    startConfigInput(parseYaml(yaml) as YamlConfig),
    await event,
  );
});

test('D83 (5): resolveSmartServerConfig — an invalid start value fails with the same error; a valid one applies as written; a real server starts from it', async (t) => {
  const llm = { provider: 'ollama', model: 'm' };
  assert.throws(
    () =>
      resolveSmartServerConfig(
        {},
        { llm, agent: { maxIterations: 'oops' } },
        {},
      ),
    (err: unknown) =>
      err instanceof ConfigFieldError &&
      err.message ===
        'invalid config — agent.maxIterations must be a finite number, got "oops"',
  ); // 30.1.0: maxIterations NaN — no iteration limit
  assert.throws(
    () =>
      resolveSmartServerConfig(
        {},
        { llm, agent: { showReasoning: 'False' } },
        {},
      ),
    /^invalid config — agent\.showReasoning must be true or false, got "False"$/,
  ); // 30.1.0: true
  assert.throws(
    () => resolveSmartServerConfig({}, { llm, prompts: { system: '' } }, {}),
    /prompts\.system must be a non-empty string, got ""/,
  ); // 30.1.0: the prompt read as absent

  const cfg = resolveSmartServerConfig(
    {},
    {
      llm,
      agent: { maxIterations: 5, showReasoning: true, sessionTokenBudget: 0 },
      rag: {
        store: { type: 'in-memory', vectorWeight: 0.4, keywordWeight: 0.6 },
      },
      prompts: { system: 'S' },
      logDir: 'sessions',
    },
    {},
  );
  assert.equal(cfg.agent?.maxIterations, 5);
  assert.equal(cfg.agent?.showReasoning, true);
  assert.equal(cfg.agent?.sessionTokenBudget, 0);
  assert.deepEqual(cfg.rag?.store, {
    type: 'in-memory',
    dedupThreshold: 0.92,
    vectorWeight: 0.4,
    keywordWeight: 0.6,
  });
  assert.deepEqual(cfg.prompts, { system: 'S' });
  assert.equal(cfg.logDir, 'sessions');
  // Absent → the 30.1.0 defaults.
  const d = resolveSmartServerConfig({}, { llm }, {});
  assert.equal(d.agent?.maxIterations, 10);
  assert.equal(d.agent?.maxToolCalls, 30);
  assert.equal(d.agent?.ragQueryK, 10);
  assert.equal(d.agent?.showReasoning, false);
  assert.equal(d.agent?.classificationEnabled, undefined);
  assert.equal(d.prompts, undefined);
  assert.equal(d.logDir, null);

  // A worker file is checked the same way; the error names the worker and its file.
  const dir = mkdtempSync(join(tmpdir(), 'start-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workerFile = join(dir, 'w.yaml');
  writeFileSync(workerFile, 'agent:\n  maxIterations: oops\n');
  assert.equal(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        { llm, subagents: [{ name: 'w', config: 'w.yaml' }] },
        {},
        {
          configPath: join(dir, 'smart-server.yaml'),
        },
      ),
    ).message,
    `invalid config — subagent 'w' (${workerFile}): agent.maxIterations must be a finite number, got "oops"`,
  );

  // A valid start config starts a real server, with the value as written.
  const startable = resolveSmartServerConfig(
    {},
    { llm, agent: { maxIterations: 5 } },
    {},
  );
  const server = new SmartServer(
    { ...startable, port: 0, host: '127.0.0.1', skipModelValidation: true },
    constructionSeams,
  );
  const handle = await server.start();
  try {
    const live = server as unknown as {
      cfg: { agent?: { maxIterations?: number } };
    };
    assert.equal(live.cfg.agent?.maxIterations, 5);
  } finally {
    await handle.close();
  }
});

/**
 * The row's valid value passes every field rule: `fn` returns, or it fails only in
 * `validateResolvedConfig` — a `ConfigValidationError`, which runs after `done()`, so
 * every field rule already passed (a config incomplete for the row's purpose). Any
 * other error — a `ConfigFieldError`, a `TypeError` from a reader — fails the row.
 */
function acceptsField(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof ConfigValidationError &&
        !(err instanceof ConfigFieldError),
      `${label}: the valid value must pass every field rule — ${String(err)}`,
    );
  }
}

test('D83 (6): one grammar — a number literal string is a number, "true" / "false" a flag; everything else is the same error', () => {
  // The grammar itself.
  for (const ok of ['0', '25', '-1', '0.5', '1e3', '2.5E-1', '-0'])
    assert.ok(NUMBER_LITERAL.test(ok), ok);
  for (const bad of [
    ' 25',
    '25 ',
    '25abc',
    '',
    'NaN',
    'Infinity',
    '-Infinity',
    '0x19',
    '025',
    '+5',
    '.5',
    '5.',
    '1_000',
    '1e',
    '--1',
  ]) {
    assert.ok(!NUMBER_LITERAL.test(bad), bad);
  }
  // A literal is parsed, then the field's rule applies; the value is the number.
  assert.deepEqual(
    reloaded({
      maxIterations: '25',
      sessionTokenBudget: '0',
      vectorWeight: '0.5',
      toolResultCacheTtlMs: '3e5',
    }),
    {
      maxIterations: 25,
      sessionTokenBudget: 0,
      vectorWeight: 0.5,
      toolResultCacheTtlMs: 300000,
    },
  );
  for (const bad of [
    ' 25',
    '25 ',
    '25abc',
    '',
    'NaN',
    'Infinity',
    '0x19',
    '025',
    '+5',
    '.5',
    '1e999',
  ]) {
    assert.deepEqual(
      fieldError(() => reloaded({ maxIterations: bad })).issues,
      [
        `agent.maxIterations must be a finite number, got ${JSON.stringify(bad)}`,
      ],
      bad,
    );
  }
  // The sign is grammar; the range refuses it. An integer field refuses a fraction literal.
  assert.deepEqual(fieldError(() => reloaded({ maxToolCalls: '-1' })).issues, [
    'agent.maxToolCalls must be >= 0, got "-1"',
  ]);
  assert.deepEqual(fieldError(() => reloaded({ ragQueryK: '2.5' })).issues, [
    'agent.ragQueryK must be an integer, got "2.5"',
  ]);
  // Flags: true / false, or exactly "true" / "false".
  assert.deepEqual(
    reloaded({ showReasoning: 'true', classificationEnabled: 'false' }),
    {
      showReasoning: true,
      classificationEnabled: false,
    },
  );
  for (const bad of ['yes', 'True', 'TRUE', '1', 1, '']) {
    assert.deepEqual(
      fieldError(() => reloaded({ showReasoning: bad })).issues,
      [`agent.showReasoning must be true or false, got ${JSON.stringify(bad)}`],
      String(bad),
    );
  }
  // PUT and the start: the same grammar.
  assert.deepEqual(
    validateAgentUpdate({ maxIterations: '25', showReasoning: 'true' }),
    {
      maxIterations: 25,
      showReasoning: true,
    },
  );
  assert.deepEqual(
    validateStartConfig(
      { agent: { maxIterations: '25' } },
      { 'agent-show-reasoning': 'false' },
    ),
    {
      maxIterations: 25,
      showReasoning: false,
    },
  );
  // The integer parser of config-validator's fields takes the same grammar.
  assert.equal(parseIntegerField('5000'), 5000);
  assert.equal(parseIntegerField('5e3'), 5000);
  assert.equal(parseIntegerField(' 5000'), 'invalid'); // 30.1.0: 5000
  assert.equal(parseIntegerField('5.5'), 'invalid');
  assert.equal(parseIntegerField(null), undefined);
});

test('D83 (6): ${VAR} at start — a number literal or true / false passes, anything else fails naming the field', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'start-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'smart-server.yaml');
  writeFileSync(
    file,
    'llm:\n  provider: ollama\n  model: m\nagent:\n  maxIterations: ${MAX}\n  showReasoning: ${SHOW}\n',
  );
  const cfg = resolveSmartServerConfig(
    {},
    loadYamlConfig(file, { MAX: '25', SHOW: 'true' }),
    {},
  );
  assert.equal(cfg.agent?.maxIterations, 25);
  assert.equal(cfg.agent?.showReasoning, true);
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        loadYamlConfig(file, { MAX: '25abc', SHOW: 'yes' }),
        {},
      ),
    ).issues,
    [
      'agent.maxIterations must be a finite number, got "25abc"',
      'agent.showReasoning must be true or false, got "yes"',
    ],
  );
});

test('D83 (7): every start-only field — one valid and one invalid value, named at its path', () => {
  const llm = { provider: 'ollama', model: 'm' };
  const inMemory = (embedder: Record<string, unknown>) => ({
    rag: { store: { type: 'in-memory' }, embedder },
  });
  const store = (type: string, f: Record<string, unknown>) => ({
    rag: {
      store: {
        type,
        collectionName: 'c',
        ...(type === 'qdrant' ? { url: 'http://q' } : {}),
        ...f,
      },
    },
  });
  const http = (f: Record<string, unknown>) => ({
    mcp: { type: 'http', url: 'http://m', ...f },
  });
  // [the field as the error names it, a YAML with a valid value, the same YAML with an invalid one]
  const rows: [string, YamlConfig, YamlConfig][] = [
    ['port', { port: '8080' }, { port: 70000 }],
    [
      'agent.contextBudgetTokens',
      { agent: { contextBudgetTokens: 0 } },
      { agent: { contextBudgetTokens: -1 } },
    ],
    [
      'agent.historyRecencyWindow',
      { agent: { historyRecencyWindow: '4' } },
      { agent: { historyRecencyWindow: 0 } },
    ],
    [
      'agent.heartbeatIntervalMs',
      { agent: { heartbeatIntervalMs: 0 } },
      { agent: { heartbeatIntervalMs: 2147483648 } },
    ],
    [
      'agent.healthTimeoutMs',
      { agent: { healthTimeoutMs: '15000' } },
      { agent: { healthTimeoutMs: 0 } },
    ],
    [
      'agent.semanticHistoryEnabled',
      { agent: { semanticHistoryEnabled: 'true' } },
      { agent: { semanticHistoryEnabled: 'yes' } },
    ],
    [
      'agent.toolReselectPerIteration',
      { agent: { toolReselectPerIteration: false } },
      { agent: { toolReselectPerIteration: 1 } },
    ],
    [
      'agent.ragTranslateEnabled',
      { agent: { ragTranslateEnabled: true } },
      { agent: { ragTranslateEnabled: 'no' } },
    ],
    [
      'agent.refreshToolsPerIteration',
      { agent: { refreshToolsPerIteration: 'false' } },
      { agent: { refreshToolsPerIteration: null } },
    ],
    [
      'agent.mcpSharedClient',
      { agent: { mcpSharedClient: true } },
      { agent: { mcpSharedClient: 'on' } },
    ],
    [
      'agent.historyTurnSummaryPrompt',
      { agent: { historyTurnSummaryPrompt: 'Summarize' } },
      { agent: { historyTurnSummaryPrompt: '' } },
    ],
    [
      'agent.streamMode',
      { agent: { streamMode: 'final' } },
      { agent: { streamMode: 'partial' } },
    ],
    [
      'agent.llmCallStrategy',
      { agent: { llmCallStrategy: 'fallback' } },
      { agent: { llmCallStrategy: 'retry' } },
    ],
    [
      'llm.temperature',
      { llm: { ...llm, temperature: '0.7' } },
      { llm: { ...llm, temperature: 'warm' } },
    ],
    [
      'llm.classifierTemperature',
      { llm: { ...llm, classifierTemperature: 0 } },
      { llm: { ...llm, classifierTemperature: -0.1 } },
    ],
    [
      'llm.maxTokens',
      { llm: { ...llm, maxTokens: '4096' } },
      { llm: { ...llm, maxTokens: ' 4096' } },
    ],
    [
      'llm.whenThrottled.maxAttempts',
      {
        llm: {
          ...llm,
          whenThrottled: { strategy: 'wait-as-told', maxAttempts: '3' },
        },
      },
      {
        llm: {
          ...llm,
          whenThrottled: { strategy: 'wait-as-told', maxAttempts: 0 },
        },
      },
    ],
    [
      'llm.resourceGroup',
      { llm: { ...llm, provider: 'sap-ai-sdk', resourceGroup: 'default' } },
      { llm: { ...llm, provider: 'sap-ai-sdk', resourceGroup: 7 } },
    ],
    [
      'llm.main.temperature',
      { llm: { main: { ...llm, temperature: 1 } } },
      { llm: { main: { ...llm, temperature: 'hot' } } },
    ],
    [
      'llm.main.classifierTemperature',
      { llm: { main: { ...llm, classifierTemperature: '0.1' } } },
      { llm: { main: { ...llm, classifierTemperature: '0,1' } } },
    ],
    [
      'llm.main.resourceGroup',
      { llm: { main: { ...llm, resourceGroup: 'rg' } } },
      { llm: { main: { ...llm, resourceGroup: '' } } },
    ],
    [
      'llm.main.maxTokens',
      { llm: { main: { ...llm, maxTokens: 100 } } },
      { llm: { main: { ...llm, maxTokens: 1.5 } } },
    ],
    [
      'rag.store.collectionName',
      store('qdrant', { collectionName: 'c' }),
      store('qdrant', { collectionName: '' }),
    ],
    [
      'rag.store.url',
      store('qdrant', { url: 'http://q:6333' }),
      store('qdrant', { url: 5 }),
    ],
    [
      'rag.store.timeoutMs',
      store('qdrant', { timeoutMs: '1000' }),
      store('qdrant', { timeoutMs: 0 }),
    ],
    [
      'rag.store.connectionString',
      store('pg-vector', { connectionString: 'postgres://h/db' }),
      store('pg-vector', { connectionString: '' }),
    ],
    [
      'rag.store.host',
      store('pg-vector', { host: 'db' }),
      store('pg-vector', { host: '' }),
    ],
    [
      'rag.store.port',
      store('pg-vector', { port: '5432' }),
      store('pg-vector', { port: 0 }),
    ],
    [
      'rag.store.schema',
      store('hana-vector', { schema: 'S' }),
      store('hana-vector', { schema: 1 }),
    ],
    [
      'rag.store.database',
      store('pg-vector', { database: 'rag' }),
      store('pg-vector', { database: '' }),
    ],
    [
      'rag.store.poolMax',
      store('pg-vector', { poolMax: 10 }),
      store('pg-vector', { poolMax: 0 }),
    ],
    [
      'rag.store.connectTimeout',
      store('pg-vector', { connectTimeout: 0 }),
      store('pg-vector', { connectTimeout: -1 }),
    ],
    [
      'rag.store.dimension',
      store('pg-vector', { dimension: '1024' }),
      store('pg-vector', { dimension: 1.5 }),
    ],
    [
      'rag.store.autoCreateSchema',
      store('pg-vector', { autoCreateSchema: 'true' }),
      store('pg-vector', { autoCreateSchema: 'yes' }),
    ],
    [
      'rag.store.dedupThreshold',
      { rag: { store: { type: 'in-memory', dedupThreshold: 0.92 } } },
      { rag: { store: { type: 'in-memory', dedupThreshold: 1.5 } } },
    ],
    [
      'rag.embedder.provider',
      inMemory({ provider: 'ollama', model: 'm' }),
      inMemory({ provider: 3, model: 'm' }),
    ],
    [
      'rag.embedder.factory',
      inMemory({ factory: 'mine' }),
      inMemory({ factory: '' }),
    ],
    [
      'rag.embedder.model',
      inMemory({ provider: 'ollama', model: 'bge-m3' }),
      inMemory({ provider: 'ollama', model: '' }),
    ],
    [
      'rag.embedder.url',
      inMemory({ provider: 'ollama', model: 'm', url: 'http://o' }),
      inMemory({ provider: 'ollama', model: 'm', url: '' }),
    ],
    [
      'rag.embedder.resourceGroup',
      inMemory({
        provider: 'sap-ai-core',
        model: 'm',
        resourceGroup: 'default',
      }),
      inMemory({ provider: 'sap-ai-core', model: 'm', resourceGroup: '' }),
    ],
    [
      'rag.embedder.scenario',
      inMemory({
        provider: 'sap-ai-core',
        model: 'm',
        scenario: 'orchestration',
      }),
      inMemory({ provider: 'sap-ai-core', model: 'm', scenario: 'chat' }),
    ],
    [
      'rag.embedder.maxBatchSize',
      inMemory({ provider: 'ollama', model: 'm', maxBatchSize: '64' }),
      inMemory({ provider: 'ollama', model: 'm', maxBatchSize: 0 }),
    ],
    [
      'rag.embedder.asymmetric',
      inMemory({ provider: 'sap-ai-core', model: 'm', asymmetric: 'false' }),
      inMemory({ provider: 'sap-ai-core', model: 'm', asymmetric: 'maybe' }),
    ],
    ['mcp.timeout', http({ timeout: '120000' }), http({ timeout: 0 })],
    [
      'mcp[0].timeout',
      { mcp: [{ type: 'http', url: 'http://m', timeout: 1000 }] },
      { mcp: [{ type: 'http', url: 'http://m', timeout: 'soon' }] },
    ],
    [
      'mcp.args',
      { mcp: { type: 'stdio', command: 'x', args: '--a --b' } },
      { mcp: { type: 'stdio', command: 'x', args: ['--a'] } },
    ],
    [
      'decision.model',
      { decision: { provider: 'typesafe', model: 'm' } },
      { decision: { provider: 'typesafe', model: '' } },
    ],
    [
      'decision.baseUrl',
      { decision: { provider: 'typesafe', baseUrl: 'http://d' } },
      { decision: { provider: 'typesafe', baseUrl: 9 } },
    ],
  ];
  for (const [field, ok, bad] of rows) {
    acceptsField(() => resolveSmartServerConfig({}, { llm, ...ok }, {}), field);
    const err = fieldError(() =>
      resolveSmartServerConfig({}, { llm, ...bad }, {}),
    );
    assert.equal(err.issues.length, 1, `${field}: ${err.message}`);
    assert.ok(err.issues[0].startsWith(`${field} `), err.issues[0]);
  }
  // The port's other sources, named so; the valid value is the number.
  assert.equal(
    resolveSmartServerConfig({ port: '8080' }, { llm }, {}).port,
    8080,
  );
  assert.ok(
    fieldError(() =>
      resolveSmartServerConfig({ port: ' 80' }, { llm }, {}),
    ).issues[0].startsWith('args.port '),
  );
  assert.ok(
    fieldError(() =>
      resolveSmartServerConfig({}, { llm }, { PORT: 'x' }),
    ).issues[0].startsWith('env.PORT '),
  );
  // The validated values are numbers and flags, not the strings.
  const cfg = resolveSmartServerConfig(
    {},
    {
      llm: { ...llm, temperature: '0.7' },
      agent: { historyRecencyWindow: '4', mcpSharedClient: 'true' },
    },
    {},
  );
  assert.equal((cfg.llm as { temperature?: unknown }).temperature, 0.7);
  assert.equal(cfg.agent?.historyRecencyWindow, 4);
  assert.equal(cfg.agent?.mcpSharedClient, true);
});

test('D83 (7): the sections with their own parser — skillPlugins and the stepper — the same grammar and error', () => {
  const sources = [{ id: 'a', records: [] }];
  // [the field as the error names it, the key path inside skillPlugins, a valid value, an invalid one]
  const skill: [
    string,
    (v: unknown) => Record<string, unknown>,
    unknown,
    unknown,
  ][] = [
    ['skillPlugins.k', (v) => ({ k: v }), '4', ' 4'],
    ['skillPlugins.maxInjectChars', (v) => ({ maxInjectChars: v }), 4000, 0],
    [
      'skillPlugins.catalogCasMaxAttempts',
      (v) => ({ catalogCasMaxAttempts: v }),
      3,
      '0x3',
    ],
    ['skillPlugins.retiredGraceMs', (v) => ({ retiredGraceMs: v }), 30000, 999],
    [
      'skillPlugins.orphanGraceMs',
      (v) => ({ orphanGraceMs: v }),
      '3600000',
      -1,
    ],
    [
      'skillPlugins.recallTimeoutMs',
      (v) => ({ recallTimeoutMs: v }),
      1000,
      1.5,
    ],
    ['skillPlugins.dimension', (v) => ({ dimension: v }), 1024, 'NaN'],
    [
      'skillPlugins.chunk.maxChars',
      (v) => ({ chunk: { maxChars: v } }),
      1500,
      '',
    ],
    ['skillPlugins.threshold', (v) => ({ threshold: v }), '0.3', 1.5],
    ['skillPlugins.strict', (v) => ({ strict: v }), 'false', 'off'],
    ['skillPlugins.loadOnStartup', (v) => ({ loadOnStartup: v }), true, 'yes'],
    [
      'skillPlugins.embedder.provider',
      (v) => ({ embedder: { provider: v } }),
      'ollama',
      5,
    ],
    [
      'skillPlugins.embedder.model',
      (v) => ({ embedder: { provider: 'ollama', model: v } }),
      'm',
      '',
    ],
  ];
  for (const [field, block, ok, bad] of skill) {
    assert.doesNotThrow(
      () => parseSkillPluginsConfig({ sources, ...block(ok) }),
      field,
    );
    const err = fieldError(() =>
      parseSkillPluginsConfig({ sources, ...block(bad) }),
    );
    assert.equal(err.issues.length, 1, `${field}: ${err.message}`);
    assert.ok(err.issues[0].startsWith(`${field} `), err.issues[0]);
  }
  assert.equal(
    parseSkillPluginsConfig({ sources, strict: 'false' }).strict,
    false,
  ); // 30.1.0: Boolean("false") → true
  assert.equal(parseSkillPluginsConfig({ sources }).strict, true); // Task 4L's default
  // The stepper's section (public parser, same signature).
  const stepper: [string, string, unknown, unknown][] = [
    ['stepper.maxParallelSteps', 'maxParallelSteps', '8', 0],
    ['stepper.maxDepth', 'maxDepth', 0, 'x'],
    ['stepper.tokenBudget', 'tokenBudget', '500000', 0],
  ];
  for (const [field, key, ok, bad] of stepper) {
    assert.doesNotThrow(
      () =>
        parseStepperCoordinatorConfig({
          mode: 'planned-react',
          stepper: { [key]: ok },
        }),
      field,
    );
    const err = fieldError(() =>
      parseStepperCoordinatorConfig({
        mode: 'planned-react',
        stepper: { [key]: bad },
      }),
    );
    assert.deepEqual(err.issues.length, 1, field);
    assert.ok(err.issues[0].startsWith(`${field} `), err.issues[0]);
  }
  assert.equal(
    parseStepperCoordinatorConfig({
      mode: 'planned-react',
      stepper: { maxParallelSteps: '8' },
    }).maxParallelSteps,
    8,
  );
});

test('D83 (8): a reload substitutes ${VAR} exactly as the start does — the same function, syntax and environment', async (t) => {
  const env: NodeJS.ProcessEnv = { MAX_ITER: '25' };
  const h = reloadHarness(t, env);
  let e = await h.save(LLM_SECTION + 'agent:\n  maxIterations: ${MAX_ITER}\n');
  assert.equal(e.event, 'config_reload_applied'); // 30.1.0: Number("${MAX_ITER}") → NaN applied
  assert.equal(h.agent.maxIterations, 25);
  assert.equal(h.queue.notApplied, undefined);

  // Unset, no default: "" — on a reload as at start — and the field's rule refuses it.
  delete env.MAX_ITER;
  e = await h.save(
    LLM_SECTION + '# unset\nagent:\n  maxIterations: ${MAX_ITER}\n',
  );
  assert.equal(e.event, 'config_reload_failed');
  assert.match(
    h.queue.notApplied?.reason ?? '',
    /agent\.maxIterations must be a finite number, got ""/,
  );
  assert.equal(h.agent.maxIterations, 25); // nothing applied
  const dir = mkdtempSync(join(tmpdir(), 'reload-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'smart-server.yaml');
  writeFileSync(file, 'agent:\n  maxIterations: ${MAX_ITER}\n');
  assert.deepEqual(
    fieldError(() => validateStartConfig(loadYamlConfig(file, env), {})).issues,
    ['agent.maxIterations must be a finite number, got ""'],
  ); // the start from the same file: the same issue

  // ${VAR:-default} → the default; ${VAR:-} → "", refused by a non-empty-string field.
  e = await h.save(LLM_SECTION + 'agent:\n  maxIterations: ${MAX_ITER:-12}\n');
  assert.equal(e.event, 'config_reload_applied');
  assert.equal(h.agent.maxIterations, 12);
  e = await h.save(
    LLM_SECTION + 'agent:\n  maxIterations: 12\nprompts:\n  system: ${SYS:-}\n',
  );
  assert.equal(e.event, 'config_reload_failed');
  assert.match(
    h.queue.notApplied?.reason ?? '',
    /prompts\.system must be a non-empty string, got ""/,
  );
});

test("D83 (8): the watcher resolves the whole file before it reads a field — the start's input and the reload's event are equal", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reload-parity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'smart-server.yaml');
  const env: NodeJS.ProcessEnv = { MAX: '7', W: '0.4' };
  const yaml = [
    'agent:',
    '  maxIterations: ${MAX}',
    'rag:',
    '  store: { type: "${STORE:-in-memory}", vectorWeight: "${W}" }',
    'prompts: { system: "${SYS:-S}" }',
    '',
  ].join('\n');
  const eventOf = async (
    options: ConstructorParameters<typeof ConfigWatcher>[1],
  ) => {
    writeFileSync(file, 'agent: {}\n');
    const watcher = new ConfigWatcher(file, options);
    const event = new Promise<HotReloadableInput>((resolve) =>
      watcher.once('reload', resolve),
    );
    watcher.start();
    t.after(() => watcher.stop());
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(file, yaml);
    const got = await event;
    watcher.stop();
    return got;
  };
  const resolved = await eventOf({
    debounceMs: 50,
    resolveDocument: (doc) => resolveEnvVars(doc, env),
  });
  assert.deepEqual(resolved, startConfigInput(loadYamlConfig(file, env)));
  // `rag.store.type: ${STORE:-in-memory}` is in-memory on both paths, so the weight is read.
  assert.deepEqual(resolved, {
    maxIterations: '7',
    vectorWeight: '0.4',
    prompts: { system: 'S' },
  });
  // Without the resolver (a direct consumer of the watcher): the text as written, the weight not read.
  assert.deepEqual(await eventOf({ debounceMs: 50 }), {
    maxIterations: '${MAX}',
    prompts: { system: '${SYS:-S}' },
  });
});

test('D83 (9): every cast-read field of the main file — one valid and one invalid value, named at its path', () => {
  const llm = { provider: 'ollama', model: 'm' };
  const http = (f: Record<string, unknown>) => ({
    mcp: { type: 'http', url: 'http://m', ...f },
  });
  const entry = (f: Record<string, unknown>) => ({
    mcp: [{ type: 'http', url: 'http://m', ...f }],
  });
  const agent = (f: Record<string, unknown>) => ({ agent: f });
  // [the field the error names, a YAML with a valid value, the same YAML with an invalid one]
  const rows: [string, YamlConfig, YamlConfig][] = [
    ['agent.retry', agent({ retry: { maxAttempts: 3 } }), agent({ retry: 3 })],
    [
      'agent.retry.retryon',
      agent({ retry: { retryOn: [429] } }),
      agent({ retry: { retryon: [429] } }),
    ],
    [
      'agent.retry.maxAttempts',
      agent({ retry: { maxAttempts: '0' } }),
      agent({ retry: { maxAttempts: -1 } }),
    ],
    [
      'agent.retry.backoffMs',
      agent({ retry: { backoffMs: 2000 } }),
      agent({ retry: { backoffMs: 2147483648 } }),
    ],
    [
      'agent.retry.retryOn',
      agent({ retry: { retryOn: [] } }),
      agent({ retry: { retryOn: 429 } }),
    ],
    [
      'agent.retry.retryOn[1]',
      agent({ retry: { retryOn: [429, '503'] } }),
      agent({ retry: { retryOn: [429, 'x'] } }),
    ],
    [
      'agent.retry.retryOnMidStream[0]',
      agent({ retry: { retryOnMidStream: ['SSE stream'] } }),
      agent({ retry: { retryOnMidStream: [''] } }),
    ],
    [
      'agent.toolSelection.strategy',
      agent({ toolSelection: { strategy: 'top-k' } }),
      agent({ toolSelection: { strategy: '' } }),
    ],
    [
      'agent.toolSelection.minScore',
      agent({ toolSelection: { strategy: 'threshold', minScore: '0.5' } }),
      agent({ toolSelection: { strategy: 'top-k', minScore: 0.5 } }),
    ],
    [
      'agent.toolSelection.mode',
      agent({ toolSelection: { strategy: 'top-k' } }),
      agent({ toolSelection: { strategy: 'top-k', mode: 'x' } }),
    ],
    [
      'agent.externalToolsValidationMode',
      agent({ externalToolsValidationMode: 'strict' }),
      agent({ externalToolsValidationMode: 'lenient' }),
    ],
    ['mcp.type', http({}), { mcp: { type: 'sse', url: 'http://m' } }],
    ['mcp.url', http({}), { mcp: { url: '' } }], // 30.1.0: no type, "" → started without MCP
    [
      'mcp.command',
      { mcp: { type: 'stdio', command: 'x' } },
      { mcp: { type: 'stdio', command: 5 } },
    ],
    [
      'mcp.headers.Authorization',
      http({ headers: { Authorization: 'Bearer t' } }),
      http({ headers: { Authorization: '' } }),
    ],
    [
      'mcp.headers.X-Port',
      http({ headers: { 'X-Port': '8080' } }),
      http({ headers: { 'X-Port': 8080 } }),
    ],
    [
      'mcp.toolTimeouts.GetTable',
      http({ toolTimeouts: { GetTable: '60000' } }),
      http({ toolTimeouts: { GetTable: 0 } }),
    ],
    ['mcp.name', http({}), http({ name: 'a' })],
    ['mcp[0]', entry({}), { mcp: ['http://m'] }],
    [
      'mcp[0].type',
      entry({ type: 'http' }),
      { mcp: [{ type: 'none', url: 'http://m' }] },
    ],
    ['mcp[0].url', entry({}), { mcp: [{ type: 'http', url: '' }] }],
    [
      'mcp[0].args',
      { mcp: [{ type: 'stdio', command: 'x', args: ['--a', ''] }] },
      { mcp: [{ type: 'stdio', command: 'x', args: '--a' }] },
    ],
    [
      'mcp[0].headers.Accept',
      entry({ headers: { Accept: 'application/json' } }),
      entry({ headers: { Accept: 1 } }),
    ],
    [
      'mcp[0].toolTimeouts.GetTable',
      entry({ toolTimeouts: { GetTable: 1000 } }),
      entry({ toolTimeouts: { GetTable: 'soon' } }),
    ],
    ['mcp[0].env', entry({ name: 'a' }), entry({ env: { A: 'b' } })],
    [
      'llm.url',
      { llm: { ...llm, url: 'http://o:11434/v1' } },
      { llm: { ...llm, url: '' } },
    ],
    [
      'llm.model',
      { llm: { ...llm, model: 'qwen2.5:14b' } },
      { llm: { ...llm, model: 3.5 } },
    ],
    [
      'llm.main.url',
      { llm: { main: { ...llm, url: 'http://o' } } },
      { llm: { main: { ...llm, url: '' } } },
    ],
    [
      'llm.main.model',
      { llm: { main: { ...llm, model: 'm' } } },
      { llm: { main: { ...llm, model: 4 } } },
    ],
    ['host', { host: '127.0.0.1' }, { host: '' }],
    ['mode', { mode: 'pass' }, { mode: 'fast' }],
    ['pluginDir', { pluginDir: './p' }, { pluginDir: 7 }],
    ['plugins', { plugins: ['a', 'b'] }, { plugins: 'a' }],
    ['plugins[1]', { plugins: ['a', 'b'] }, { plugins: ['a', 3] }],
    ['skills', { skills: { type: 'claude' } }, { skills: 'claude' }],
    [
      'skills.type',
      { skills: { type: 'codex' } },
      { skills: { type: 'cursor' } },
    ],
    [
      'skills.dirs[0]',
      { skills: { type: 'filesystem', dirs: ['d'] } },
      { skills: { type: 'filesystem', dirs: [''] } },
    ],
    [
      'skills.projectRoot',
      { skills: { projectRoot: '/p' } },
      { skills: { projectRoot: '' } },
    ],
    [
      'pipeline.config',
      { pipeline: { name: 'flat', config: {} } },
      { pipeline: { name: 'flat', config: 'x' } },
    ],
  ];
  for (const [field, ok, bad] of rows) {
    acceptsField(() => resolveSmartServerConfig({}, { llm, ...ok }, {}), field);
    const err = fieldError(() =>
      resolveSmartServerConfig({}, { llm, ...bad }, {}),
    );
    assert.equal(err.issues.length, 1, `${field}: ${err.message}`);
    assert.ok(err.issues[0].startsWith(`${field} `), err.issues[0]);
  }
  // The overrides are named so.
  assert.ok(
    fieldError(() =>
      resolveSmartServerConfig({ host: '' }, { llm }, {}),
    ).issues[0].startsWith('args.host '),
  );
  // The validated values reach the consumers: numbers parsed, the shapes as written.
  const cfg = resolveSmartServerConfig(
    {},
    {
      llm,
      agent: {
        retry: {
          maxAttempts: '2',
          retryOn: ['429', 503],
          retryOnMidStream: ['SSE stream'],
        },
        toolSelection: { strategy: 'threshold', minScore: '0.5' },
      },
      mcp: {
        type: 'http',
        url: 'http://m',
        headers: { Accept: 'application/json' },
        toolTimeouts: { GetTable: '60000' },
      },
    },
    {},
  );
  assert.deepEqual(cfg.agent?.retry, {
    maxAttempts: 2,
    retryOn: [429, 503],
    retryOnMidStream: ['SSE stream'],
  });
  assert.deepEqual(cfg.agent?.toolSelection, {
    strategy: 'threshold',
    minScore: 0.5,
  });
  assert.deepEqual((cfg.mcp as { toolTimeouts?: unknown }).toolTimeouts, {
    GetTable: 60000,
  });
  // A section key with no value is an error, named once (spec D83 (13)).
  assert.deepEqual(
    fieldError(() =>
      resolveSmartServerConfig(
        {},
        { llm, agent: { retry: null }, skills: null },
        {},
      ),
    ).issues,
    ['agent.retry has no value', 'skills has no value'],
  );
});

test('D83 (9): the pipeline sections — linear, DAG, controller, stepper — every cast-read field', () => {
  const check = <T>(
    parse: (raw: Record<string, unknown>) => T,
    rows: [string, Record<string, unknown>, Record<string, unknown>][],
  ) => {
    for (const [field, ok, bad] of rows) {
      assert.doesNotThrow(() => parse(ok), field);
      const err = fieldError(() => parse(bad));
      assert.equal(err.issues.length, 1, `${field}: ${err.message}`);
      assert.ok(err.issues[0].startsWith(`${field} `), err.issues[0]);
    }
  };
  check(parseLinearSettings, [
    ['maxSteps', { maxSteps: '8' }, { maxSteps: 0 }],
    ['maxRetriesPerStep', { maxRetriesPerStep: 0 }, { maxRetriesPerStep: -1 }],
    ['failPolicy', { failPolicy: 'continue' }, { failPolicy: 'ignore' }],
  ]);
  assert.equal(parseLinearSettings({ maxSteps: '8' }).maxSteps, 8);
  const planner = { planner: { type: 'llm', plannerLlm: 'main' } }; // `type` is not read: an open mapping
  check(
    (raw) => parseDagSettings(raw, () => {}),
    [
      ['planner', planner, { planner: 'main' }],
      ['reviewer', { ...planner, reviewer: {} }, { ...planner, reviewer: 'r' }],
      [
        'errorStrategy.type',
        { ...planner, errorStrategy: { type: 'abort' } },
        { ...planner, errorStrategy: { type: 'retry' } },
      ],
      [
        'errorStrategy.maxReplans',
        { ...planner, errorStrategy: { type: 'replan', maxReplans: '2' } },
        { ...planner, errorStrategy: { type: 'abort', maxReplans: 2 } },
      ],
      [
        'maxRoundTrips',
        { ...planner, maxRoundTrips: 3 },
        { ...planner, maxRoundTrips: '3x' },
      ],
      [
        'stateOracle',
        { ...planner, stateOracle: 'inspector' },
        { ...planner, stateOracle: 5 },
      ],
      [
        'finalizer.type',
        { ...planner, finalizer: { type: 'template' } },
        { ...planner, finalizer: { type: 'summary' } },
      ],
      [
        'finalizer.systemPrompt',
        { ...planner, finalizer: { type: 'llm', systemPrompt: 'S' } },
        { ...planner, finalizer: { type: 'llm', systemPrompt: '' } },
      ],
    ],
  );
  assert.deepEqual(
    parseDagSettings(
      { ...planner, errorStrategy: { type: 'replan', maxReplans: '2' } },
      () => {},
    ).errorStrategy,
    {
      type: 'replan',
      maxReplans: 2,
    },
  );
  const subagents = { evaluator: {}, planner: {}, executor: {} };
  const keys = new Set(['main']);
  check(
    (raw) => parseControllerSettings({ subagents, ...raw }, keys),
    [
      [
        'targetState.strategy',
        { targetState: { strategy: 'consumer-confirm' } },
        { targetState: { strategy: 'ask' } },
      ],
      [
        'targetState.distanceThreshold',
        { targetState: { distanceThreshold: '0.7' } },
        { targetState: { distanceThreshold: 2.5 } },
      ],
      [
        'targetState.treshold',
        { targetState: {} },
        { targetState: { treshold: 0.7 } },
      ],
      [
        'sessionMemory.collection',
        { sessionMemory: { collection: 'm' } },
        { sessionMemory: { collection: '' } },
      ],
      [
        'budgets.maxSteps',
        { budgets: { maxSteps: '20' } },
        { budgets: { maxSteps: 0 } },
      ],
      [
        'budgets.maxRetries',
        { budgets: { maxRetries: 0 } },
        { budgets: { maxRetries: '3x' } },
      ],
      [
        'budgets.perStepTimeoutMs',
        { budgets: { perStepTimeoutMs: 0 } },
        { budgets: { perStepTimeoutMs: -1 } },
      ],
      [
        'budgets.maxBoardChars',
        { budgets: { maxBoardChars: 12000 } },
        { budgets: { maxBoardChars: 0 } },
      ],
      [
        'budgets.maxWaitMs',
        { budgets: { maxWaitMs: '600000' } },
        { budgets: { maxWaitMs: ' 600000' } },
      ],
      ['budgets.maxStep', { budgets: {} }, { budgets: { maxStep: 20 } }],
    ],
  );
  assert.equal(
    parseControllerSettings({ subagents, budgets: { maxSteps: '20' } }, keys)
      .budgets.maxSteps,
    20,
  ); // 30.1.0: "20"
  const goal = (f: Record<string, unknown> = {}) => ({ goal: 'g', ...f });
  check(parseStepperCoordinatorConfig, [
    ['stepper', { stepper: {} }, { stepper: 4 }],
    [
      'stepper.reviewer.atDepths',
      { stepper: { reviewer: { atDepths: 'all' } } },
      { stepper: { reviewer: { atDepths: 'some' } } },
    ],
    [
      'stepper.reviewer.atDepths[1]',
      { stepper: { reviewer: { atDepths: [0, '1'] } } },
      { stepper: { reviewer: { atDepths: [0, -1] } } },
    ],
    [
      'flow.evaluator.enabled',
      { flow: { evaluator: { enabled: 'false' } } },
      { flow: { evaluator: { enabled: 'no' } } },
    ],
    [
      'flow.evaluator.atDepths[0]',
      { flow: { evaluator: { atDepths: [2] } } },
      { flow: { evaluator: { atDepths: [1.5] } } },
    ],
    ['flow.planner', { flow: { planner: {} } }, { flow: { planner: 'llm' } }],
    ['formalizeTask', { formalizeTask: 'true' }, { formalizeTask: 'yes' }],
    [
      'knowledgeSeed[1].content',
      { knowledgeSeed: [{ content: 'a' }, { content: 'b' }] },
      { knowledgeSeed: [{ content: 'a' }, { content: '   ' }] },
    ],
    [
      'knowledgeSeed[0].artifactType',
      { knowledgeSeed: [{ content: 'a', artifactType: 'tool-rule' }] },
      { knowledgeSeed: [{ content: 'a', artifactType: '' }] },
    ],
    [
      'flow.plan[0].goal',
      { flow: { planner: { type: 'static' }, plan: [goal()] } },
      { flow: { planner: { type: 'static' }, plan: [{ id: 'a' }] } },
    ],
    [
      'flow.plan[0].dependsOn[0]',
      { flow: { plan: [goal({ dependsOn: ['n1'] })] } },
      { flow: { plan: [goal({ dependsOn: [1] })] } },
    ],
    [
      'flow.nodes[0].flow.nodes[0].goal',
      { flow: { nodes: [goal({ flow: { nodes: [goal()] } })] } },
      { flow: { nodes: [goal({ flow: { nodes: [{ goal: '' }] } })] } },
    ],
  ]);
  const c = parseStepperCoordinatorConfig({
    stepper: { reviewer: { atDepths: [0, '2'] } },
    flow: { evaluator: { enabled: 'false' } },
    formalizeTask: 'true',
  });
  assert.equal(c.reviewerAtDepths.has(2), true); // 30.1.0: "2" never matched
  assert.equal(c.flow.evaluatorEnabled, false); // 30.1.0: "false" !== false → on
  assert.equal(c.formalizeTask, true); // 30.1.0: "true" !== true → off
});

test('D83 (7), (9): every parser checks each field before done — an invalid value fails, never its default', () => {
  // Each field below was read in 30.1.0's return literal or after the
  // cross-field rules: checked there — after done() — its stand-in default
  // would be returned. One invalid field → exactly that field named.
  const rejects = (field: string, parse: () => unknown) => {
    const err = fieldError(parse);
    assert.equal(err.issues.length, 1, `${field}: ${err.message}`);
    assert.ok(err.issues[0].startsWith(`${field} `), err.issues[0]);
  };
  // Linear: every field — an invalid number string each, an unknown failPolicy.
  rejects('maxSteps', () => parseLinearSettings({ maxSteps: '10x' }));
  rejects('maxRetriesPerStep', () =>
    parseLinearSettings({ maxRetriesPerStep: ' 1' }),
  );
  rejects('failPolicy', () => parseLinearSettings({ failPolicy: 'retry' }));
  assert.deepEqual(
    fieldError(() =>
      parseLinearSettings({
        maxSteps: 'x',
        maxRetriesPerStep: '1.5',
        failPolicy: 'retry',
      }),
    ).issues.map((i) => i.split(' ')[0]),
    ['maxSteps', 'maxRetriesPerStep', 'failPolicy'],
    'every field recorded before done — one error naming all three',
  );
  // One per other parser, each a field 30.1.0 read in its return literal (or later).
  rejects('maxRoundTrips', () =>
    parseDagSettings(
      { planner: { plannerLlm: 'main' }, maxRoundTrips: '3x' },
      () => {},
    ),
  );
  rejects('budgets.maxSteps', () =>
    parseControllerSettings(
      {
        subagents: { evaluator: {}, planner: {}, executor: {} },
        budgets: { maxSteps: '20x' },
      },
      new Set(['main']),
    ),
  );
  // The stepper: a plan node without a goal is named — the cross-field rule
  // (`static` requires a plan) runs on valid values only, after done.
  rejects('flow.plan[0].goal', () =>
    parseStepperCoordinatorConfig({
      flow: { planner: { type: 'static' }, plan: [{ id: 'a' }] },
    }),
  );
  rejects('formalizeTask', () =>
    parseStepperCoordinatorConfig({ formalizeTask: 'yes' }),
  );
  const sources = [{ id: 'a', records: [] }];
  rejects('skillPlugins.strict', () =>
    parseSkillPluginsConfig({ sources, strict: 'off' }),
  );
  rejects('skillPlugins.embedder.provider', () =>
    parseSkillPluginsConfig({ sources, embedder: { provider: 5 } }),
  );
  // The cross-field rule never sees a stand-in: 30000 (the default) < 40000 would
  // fail it with a message about a value the file does not hold.
  rejects('skillPlugins.retiredGraceMs', () =>
    parseSkillPluginsConfig({
      sources,
      retiredGraceMs: '5000x',
      recallTimeoutMs: 40000,
    }),
  );
  // A reader that checks after done() is refused where it happens.
  const late = new FieldCheck();
  late.done({});
  assert.throws(
    () => late.number('late', START_NUMBER_RULES.count, 'x'),
    /^Error: FieldCheck: 'late' checked after done\(\)/,
  );
});
