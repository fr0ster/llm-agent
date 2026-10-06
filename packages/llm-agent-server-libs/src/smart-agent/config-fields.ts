/**
 * The one validator of every config field a running server changes (spec
 * §10.5.9 V6, V10, *Config field rules*, D83): the file reload and
 * PUT /v1/config apply a field only after it passed here. Nothing is coerced —
 * a value of the wrong type or outside its range is an error naming the field,
 * never NaN or a guess. Every invalid field of one input is named in one error.
 * Internal — not exported from the package.
 */
import type {
  HotReloadableConfig,
  HotReloadableInput,
} from '@mcp-abap-adt/llm-agent-libs';
import type {
  SmartServerAgentConfig,
  SmartServerMcpConfig,
  SmartServerSkillsConfig,
} from './smart-server.js';
import type { YamlConfig } from './yaml-loader.js';

/** A number's rule: what the code that reads the field can work with. */
export interface NumberRule {
  readonly integer: boolean;
  readonly min: number;
  readonly max?: number;
}

/**
 * A number written as text (spec §10.5.9, D83 (6)) — how `${VAR}` substitution and a
 * quoted YAML / JSON value arrive. JSON's number grammar over the whole string: an
 * optional `-`, an integer part without leading zeros, an optional fraction, an
 * optional exponent. No spaces, no `+`, no `.5` / `5.`, no hex, no `_`, no `NaN` /
 * `Infinity`. The sign is grammar for every field; a field's range refuses it.
 */
export const NUMBER_LITERAL =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * A numeric field's value as a number (spec D83 (6)): a number as it is, a
 * `NUMBER_LITERAL` string parsed; anything else `undefined`. Finiteness and the
 * field's rule are the caller's (`"1e999"` parses to `Infinity`).
 */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && NUMBER_LITERAL.test(value)
    ? Number(value)
    : undefined;
}

/** A flag's value (spec D83 (6)): `true` / `false`, or exactly `"true"` / `"false"`; anything else `undefined`. */
export function flagOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

/** The numeric `agent.*` fields the file reload reads. */
const AGENT_NUMBER_FIELDS = [
  'maxIterations',
  'maxToolCalls',
  'ragQueryK',
  'toolUnavailableTtlMs',
  'historyAutoSummarizeLimit',
  'toolResultCacheTtlMs',
  'sessionTokenBudget',
] as const;
type AgentNumberField = (typeof AGENT_NUMBER_FIELDS)[number];

const AGENT_NUMBER_RULES: { readonly [K in AgentNumberField]: NumberRule } = {
  // The loop ends when `iteration >= maxIterations`: 0 answers nothing, NaN never ends it.
  maxIterations: { integer: true, min: 1 },
  // A budget of tool calls (`maxToolCalls - toolCallCount`); 0 = no tool call.
  maxToolCalls: { integer: true, min: 0 },
  // How many results a retrieval asks for.
  ragQueryK: { integer: true, min: 1 },
  // Durations in ms; 0 disables the cache.
  toolUnavailableTtlMs: { integer: false, min: 0 },
  toolResultCacheTtlMs: { integer: false, min: 0 },
  // A history longer than this is summarized; 0 = always.
  historyAutoSummarizeLimit: { integer: true, min: 0 },
  // A token count; 0 disables.
  sessionTokenBudget: { integer: true, min: 0 },
};

/** The `agent.*` switches the file reload reads. */
const AGENT_FLAG_FIELDS = [
  'showReasoning',
  'classificationEnabled',
  'queryExpansionEnabled',
] as const;

/** The `agent` fields PUT /v1/config may change — its whitelist (spec V10); each has its rule above. */
const UPDATABLE_AGENT_NUMBER_FIELDS = [
  'maxIterations',
  'maxToolCalls',
  'ragQueryK',
  'toolUnavailableTtlMs',
  'historyAutoSummarizeLimit',
] as const satisfies readonly AgentNumberField[];
const UPDATABLE_AGENT_FLAG_FIELDS = [
  'showReasoning',
  'classificationEnabled',
] as const satisfies readonly (typeof AGENT_FLAG_FIELDS)[number][];
export const UPDATABLE_AGENT_FIELDS: readonly string[] = [
  ...UPDATABLE_AGENT_NUMBER_FIELDS,
  ...UPDATABLE_AGENT_FLAG_FIELDS,
];
/** PUT /v1/config's `agent` section, validated. */
export type AgentUpdate = Partial<
  Pick<
    HotReloadableConfig,
    | (typeof UPDATABLE_AGENT_NUMBER_FIELDS)[number]
    | (typeof UPDATABLE_AGENT_FLAG_FIELDS)[number]
  >
>;

/** `rag.store.*` weights (in-memory store only): `WeightedFusionStrategy` adds
 *  `cosine · vectorWeight` and the normalized BM25 · `keywordWeight`, both in [0, 1]. */
const WEIGHT_FIELDS = ['vectorWeight', 'keywordWeight'] as const;
const WEIGHT_RULE: NumberRule = { integer: false, min: 0, max: 1 };

const PROMPT_FIELDS = [
  'system',
  'classifier',
  'reasoning',
  'ragTranslate',
  'historySummary',
] as const;

const CIRCUIT_BREAKER_FIELDS = [
  'failureThreshold',
  'recoveryWindowMs',
] as const;
const CIRCUIT_BREAKER_RULES: {
  readonly [K in (typeof CIRCUIT_BREAKER_FIELDS)[number]]: NumberRule;
} = {
  failureThreshold: { integer: true, min: 1 }, // a count of failures
  recoveryWindowMs: { integer: false, min: 0 }, // a duration in ms
};

/**
 * Every field of the reload table at its YAML path (spec D83 (14)) — generated
 * from the lists above, so the wrong-shape test covers a field added to them.
 */
export const RELOAD_FIELD_PATHS: readonly string[] = [
  ...[...AGENT_NUMBER_FIELDS, ...AGENT_FLAG_FIELDS].map((k) => `agent.${k}`),
  ...WEIGHT_FIELDS.map((k) => `rag.store.${k}`),
  ...PROMPT_FIELDS.map((k) => `prompts.${k}`),
  ...CIRCUIT_BREAKER_FIELDS.map((k) => `circuitBreaker.${k}`),
  'logDir',
];

/** PUT /v1/config's `models` keys — its whitelist (spec V10). */
export const MODEL_FIELDS = [
  'mainModel',
  'classifierModel',
  'helperModel',
] as const;
/** PUT /v1/config's `models` section, validated. */
export type ModelUpdate = { [K in (typeof MODEL_FIELDS)[number]]?: string };

/** Node clamps a timer delay above 2^31 − 1 ms to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The rules of the fields read at start only (spec §10.5.9 *Start-only fields*,
 * D83 (7)), keyed by meaning — the reader passes the field's name. Applied by the
 * section readers with the start's `FieldCheck`, and by `parseSkillPluginsConfig` and
 * `parseStepperCoordinatorConfig` with their own.
 */
export const START_NUMBER_RULES = {
  // A TCP port; 0 lets the OS pick one (`port`).
  port: { integer: true, min: 0, max: 65_535 },
  // `rag.store.port`.
  storePort: { integer: true, min: 1, max: 65_535 },
  // A token budget; 0 = no limit (`agent.contextBudgetTokens`).
  contextBudgetTokens: { integer: true, min: 0 },
  // The last N client messages; 0 would `slice(-0)` — keep every one (`agent.historyRecencyWindow`).
  historyRecencyWindow: { integer: true, min: 1 },
  // A timer delay; 0 disables the keep-alive, as documented (`agent.heartbeatIntervalMs`).
  heartbeatIntervalMs: { integer: true, min: 0, max: MAX_TIMER_MS },
  // Timer delays in ms (`agent.healthTimeoutMs`, `mcp.timeout`, `mcp[i].timeout`, `rag.store.timeoutMs`).
  timerMs: { integer: true, min: 1, max: MAX_TIMER_MS },
  // A sampling temperature; the upper bound is the provider's (`llm.*temperature`).
  temperature: { integer: false, min: 0 },
  // Counts and sizes (`llm.*maxTokens`, `whenThrottled.maxAttempts`, `rag.store.poolMax`,
  // `rag.store.dimension`, `rag.embedder.maxBatchSize`, the `skillPlugins` counts and
  // durations, `stepper.maxParallelSteps`, `stepper.tokenBudget`).
  count: { integer: true, min: 1 },
  // ms; 0 = the driver's "no timeout" (`rag.store.connectTimeout`).
  connectTimeout: { integer: true, min: 0 },
  // A similarity threshold (`rag.store.dedupThreshold`, `skillPlugins.threshold`).
  unitInterval: { integer: false, min: 0, max: 1 },
  // Its 30.1.0 rule (`skillPlugins.retiredGraceMs`).
  retiredGraceMs: { integer: true, min: 1000 },
  // A recursion depth; 0 = none (`stepper.maxDepth`).
  depth: { integer: true, min: 0 },
} as const satisfies Readonly<Record<string, NumberRule>>;

/** `agent.streamMode`. */
export const STREAM_MODES = ['full', 'final'] as const;
/** `agent.llmCallStrategy`. */
export const LLM_CALL_STRATEGIES = [
  'streaming',
  'non-streaming',
  'fallback',
] as const;
/** `rag.embedder.scenario`. */
export const EMBEDDER_SCENARIOS = [
  'orchestration',
  'foundation-models',
] as const;

/**
 * The cast-read fields' number rules not already in `START_NUMBER_RULES` (spec
 * §10.5.9 *Cast-read fields*), keyed by meaning. Counts where 0 runs nothing
 * (`maxSteps`, `maxRoundTrips`, the controller's caps) use `START_NUMBER_RULES.count`,
 * request timers (`mcp.toolTimeouts.*`, `budgets.maxWaitMs`) `.timerMs`, depths `.depth`.
 */
export const CAST_NUMBER_RULES = {
  // Counts where 0 means none (retries, rewinds, resumes, `maxRetriesPerStep`, `maxReplans`, …).
  countOrNone: { integer: true, min: 0 },
  // A timer delay; 0 = none (`agent.retry.backoffMs`, `budgets.perStepTimeoutMs`).
  delayMs: { integer: true, min: 0, max: MAX_TIMER_MS },
  // An HTTP status code `isRetryableStatus` compares (`agent.retry.retryOn[i]`).
  httpStatus: { integer: true, min: 100, max: 599 },
  // A cosine distance, `1 − cosine` (`targetState.distanceThreshold`).
  cosineDistance: { integer: false, min: 0, max: 2 },
  // A score on the store's scale — no range (`agent.toolSelection.minScore`).
  score: { integer: false, min: Number.NEGATIVE_INFINITY },
} as const satisfies Readonly<Record<string, NumberRule>>;

/** `mcp.type` (single form; `none` = no MCP) and an `mcp[]` entry's (absent = `http`). */
export const MCP_TYPES = ['http', 'stdio', 'none'] as const;
const MCP_ENTRY_TYPES = ['http', 'stdio'] as const;
/** The keys `resolveMcpSection` reads (single form) and an entry carries (`SmartServerMcpConfig`). */
export const MCP_KEYS = [
  'type',
  'url',
  'command',
  'args',
  'headers',
  'timeout',
  'toolTimeouts',
] as const;
const MCP_ENTRY_KEYS = [...MCP_KEYS, 'name'] as const;
/** `mcp[i].name` (spec D83 (14)) — IToolNamespace's exposed-name charset, so a bad label fails at config parse. */
const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const TOOLS_VALIDATION_MODES = ['permissive', 'strict'] as const;
export const SERVER_MODES = ['hard', 'pass', 'smart'] as const;
const SKILLS_TYPES = ['claude', 'codex', 'filesystem'] as const;
export const FAIL_POLICIES = ['abort', 'continue'] as const;
export const DAG_ERROR_STRATEGIES = ['replan', 'abort'] as const;
export const FINALIZER_TYPES = ['passthrough', 'llm', 'template'] as const;
export const TARGET_STATE_STRATEGIES = [
  'consumer-confirm',
  'semantic-distance',
  'auto',
] as const;
const RETRY_KEYS = [
  'maxAttempts',
  'backoffMs',
  'retryOn',
  'retryOnMidStream',
] as const;
const TOOL_SELECTION_STRATEGIES = ['top-k', 'threshold'] as const;

/** The controller's budgets and their rules — its closed key list (spec D83 (9)). */
export const CONTROLLER_BUDGET_RULES = {
  maxSteps: START_NUMBER_RULES.count,
  maxStepAttempts: START_NUMBER_RULES.count,
  maxDigestChars: START_NUMBER_RULES.count,
  maxIntentChars: START_NUMBER_RULES.count,
  maxActiveSteps: START_NUMBER_RULES.count,
  maxBoardChars: START_NUMBER_RULES.count,
  maxRetries: CAST_NUMBER_RULES.countOrNone,
  maxRewinds: CAST_NUMBER_RULES.countOrNone,
  maxToolCalls: CAST_NUMBER_RULES.countOrNone,
  maxStepResumes: CAST_NUMBER_RULES.countOrNone,
  maxPlannerResumes: CAST_NUMBER_RULES.countOrNone,
  maxEvalResumes: CAST_NUMBER_RULES.countOrNone,
  maxFinalizeRetries: CAST_NUMBER_RULES.countOrNone,
  maxReviewRetries: CAST_NUMBER_RULES.countOrNone,
  keepRecentDigests: CAST_NUMBER_RULES.countOrNone,
  perStepTimeoutMs: CAST_NUMBER_RULES.delayMs,
  maxWaitMs: START_NUMBER_RULES.timerMs,
  maxTotalWaitMs: CAST_NUMBER_RULES.countOrNone,
} as const satisfies Readonly<Record<string, NumberRule>>;

/** Every invalid field of one input (spec D83): `<field> <rule>, got <value>`, or `<field> has no value` (D83 (13)). */
export class ConfigFieldError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid config — ${issues.join('; ')}`);
    this.name = 'ConfigFieldError';
  }

  /** The message alone — `invalid config — …`, as the CLI and a log print it. */
  override toString(): string {
    return this.message;
  }
}

/** A value as the error shows it: a number as written (NaN, Infinity), the rest as JSON. */
function describe(value: unknown): string {
  return typeof value === 'number'
    ? String(value)
    : (JSON.stringify(value) ?? String(value));
}

/**
 * Collects every invalid field of one input, then throws them together (spec D83).
 * Each check returns the validated value, or `undefined` after recording an issue.
 * A caller that needs a value of the field's type before `done()` uses a stand-in
 * (`numberOr` / `flagOr`, or `?? ''`); `done()` throws whenever an issue was
 * recorded, so a stand-in for an invalid value never outlives it.
 *
 * `done()` is a reader's last check and the only way its checked values leave
 * it: compute every checked field first, build the result from them, then
 * `return check.done(result)` — or, when cross-field rules must read valid
 * values, `const valid = check.done(result)`, the rules on `valid`, `return
 * valid`. A field checked after `done()` would be recorded too late and its
 * stand-in returned as the value, so an issue recorded after `done()` throws at
 * once (a reader's ordering bug, never a silent default).
 */
export class FieldCheck {
  private readonly issues: string[] = [];
  private finished = false;

  number(field: string, rule: NumberRule, value: unknown): number | undefined {
    // D83 (6): a number, or a string that is exactly a number literal.
    const n = numberOf(value);
    if (n === undefined || !Number.isFinite(n))
      return this.bad(field, 'must be a finite number', value);
    if (rule.integer && !Number.isInteger(n))
      return this.bad(field, 'must be an integer', value);
    if (n < rule.min) return this.bad(field, `must be >= ${rule.min}`, value);
    if (rule.max !== undefined && n > rule.max)
      return this.bad(field, `must be <= ${rule.max}`, value);
    return n;
  }

  /** `absent` when `value` is absent; otherwise `number(…)`, with `absent` as the stand-in for an invalid one. */
  numberOr(
    field: string,
    rule: NumberRule,
    value: unknown,
    absent: number,
  ): number {
    return value === undefined
      ? absent
      : (this.number(field, rule, value) ?? absent);
  }

  flag(field: string, value: unknown): boolean | undefined {
    // D83 (6): `true` / `false`, or exactly "true" / "false".
    return flagOf(value) ?? this.bad(field, 'must be true or false', value);
  }

  /** `absent` when `value` is absent; otherwise `flag(…)`, with `absent` as the stand-in for an invalid one. */
  flagOr(field: string, value: unknown, absent: boolean): boolean {
    return value === undefined ? absent : (this.flag(field, value) ?? absent);
  }

  /** One of `names`, exactly (spec D83 (7): `agent.streamMode`, `agent.llmCallStrategy`, `rag.embedder.scenario`). */
  oneOf<T extends string>(
    field: string,
    names: readonly T[],
    value: unknown,
  ): T | undefined {
    return (
      names.find((n) => n === value) ??
      this.bad(field, `must be one of ${names.join(', ')}`, value)
    );
  }

  text(field: string, value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== ''
      ? value
      : this.bad(field, 'must be a non-empty string', value);
  }

  section(
    field: string,
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value));
    }
    return this.bad(field, 'must be a mapping', value);
  }

  /** Records `<field> <problem>, got <value>` — a rule a caller states itself (spec D83 (9)). */
  refuse(field: string, problem: string, value: unknown): undefined {
    return this.bad(field, problem, value);
  }

  /** A closed mapping (spec D83 (9)): `section(…)`, after recording each key not in `keys`. */
  closed(
    field: string,
    value: unknown,
    keys: readonly string[],
  ): Readonly<Record<string, unknown>> | undefined {
    const section = this.section(field, value);
    for (const [k, v] of Object.entries(section ?? {})) {
      if (!keys.includes(k)) this.bad(`${field}.${k}`, 'is not a known key', v);
    }
    return section;
  }

  /** A list (spec D83 (9)): each item through `item`, named `<field>[i]`; `undefined` when any failed. */
  list<T>(
    field: string,
    value: unknown,
    item: (field: string, v: unknown) => T | undefined,
  ): T[] | undefined {
    if (!Array.isArray(value)) return this.bad(field, 'must be a list', value);
    const out: T[] = [];
    let ok = true;
    value.forEach((v: unknown, i) => {
      const r = item(`${field}[${i}]`, v);
      if (r === undefined) ok = false;
      else out.push(r);
    });
    return ok ? out : undefined;
  }

  /** A map of non-empty key → value (spec D83 (9)): each value through `item`, named `<field>.<key>`. */
  map<T>(
    field: string,
    value: unknown,
    item: (field: string, v: unknown) => T | undefined,
  ): Record<string, T> | undefined {
    const section = this.section(field, value);
    if (!section) return undefined;
    const out: Record<string, T> = {};
    let ok = true;
    for (const [k, v] of Object.entries(section)) {
      const r =
        k.trim() === ''
          ? this.bad(field, 'must not have an empty key', k)
          : item(`${field}.${k}`, v);
      if (r === undefined) ok = false;
      else out[k] = r;
    }
    return ok ? out : undefined;
  }

  /**
   * `value` when every field passed; otherwise one error naming every invalid
   * field. The last check of the reader: pass it the result built from every
   * checked field, and return what it returns.
   */
  done<T>(value: T): T {
    this.finished = true;
    if (this.issues.length > 0) throw new ConfigFieldError(this.issues);
    return value;
  }

  private bad(field: string, problem: string, value: unknown): undefined {
    // Spec D83: after done() an issue would never be reported — the reader
    // would return its stand-in. The reader's bug, refused where it happens.
    if (this.finished)
      throw new Error(
        `FieldCheck: '${field}' checked after done() — a reader checks every field before done()`,
      );
    // Spec D83 (13): a key written with no value is that, whatever its rule —
    // named once (checkNoValue's walk and the reader of the key both hand it here).
    if (value === null) {
      const issue = `${field} has no value`;
      if (!this.issues.includes(issue)) this.issues.push(issue);
      return undefined;
    }
    this.issues.push(`${field} ${problem}, got ${describe(value)}`);
    return undefined;
  }
}

/**
 * Every field of the reload table at the paths `ConfigWatcher` reads (applied
 * or not — the file is the whole config), into `check`. Run only by
 * `checkStartConfig`: the start and the file reload validate a document with
 * the same function — there is no reloadable-only validator (D83, D83 (5), (10)).
 */
function checkReloadable(
  check: FieldCheck,
  input: HotReloadableInput,
): HotReloadableConfig {
  const out: HotReloadableConfig = {};
  for (const k of AGENT_NUMBER_FIELDS) {
    if (input[k] !== undefined)
      out[k] = check.number(`agent.${k}`, AGENT_NUMBER_RULES[k], input[k]);
  }
  for (const k of AGENT_FLAG_FIELDS) {
    if (input[k] !== undefined) out[k] = check.flag(`agent.${k}`, input[k]);
  }
  for (const k of WEIGHT_FIELDS) {
    if (input[k] !== undefined)
      out[k] = check.number(`rag.store.${k}`, WEIGHT_RULE, input[k]);
  }
  if (input.prompts !== undefined) {
    const section = check.section('prompts', input.prompts);
    if (section) {
      const prompts: NonNullable<HotReloadableConfig['prompts']> = {};
      for (const k of PROMPT_FIELDS) {
        if (section[k] !== undefined)
          prompts[k] = check.text(`prompts.${k}`, section[k]);
      }
      out.prompts = prompts;
    }
  }
  if (input.circuitBreaker !== undefined) {
    const section = check.section('circuitBreaker', input.circuitBreaker);
    if (section) {
      const breaker: NonNullable<HotReloadableConfig['circuitBreaker']> = {};
      for (const k of CIRCUIT_BREAKER_FIELDS) {
        if (section[k] !== undefined) {
          breaker[k] = check.number(
            `circuitBreaker.${k}`,
            CIRCUIT_BREAKER_RULES[k],
            section[k],
          );
        }
      }
      out.circuitBreaker = breaker;
    }
  }
  if (input.logDir !== undefined)
    out.logDir = check.text('logDir', input.logDir);
  return out;
}

/** The YAML's `agent` section as `ConfigWatcher` reads it — absent, empty or with no value (an error, D83 (13)) → no fields. */
function agentOf(yaml: YamlConfig): Readonly<Record<string, unknown>> {
  return (yaml.agent ?? {}) as Readonly<Record<string, unknown>>;
}

/**
 * The start config's values of every field above, at the paths the file reload
 * reads (`ConfigWatcher._extractReloadable`): a reload of the same file applies
 * exactly these values, validated (spec D83 (5), (10); pinned against the real
 * watcher).
 */
export function startConfigInput(yaml: YamlConfig): HotReloadableInput {
  const agent = agentOf(yaml);
  const ragStore = ((yaml.rag as Readonly<Record<string, unknown>> | undefined)
    ?.store ?? {}) as Readonly<Record<string, unknown>>;
  const input: HotReloadableInput = {};
  for (const k of [...AGENT_NUMBER_FIELDS, ...AGENT_FLAG_FIELDS]) {
    if (agent[k] !== undefined) input[k] = agent[k];
  }
  if (ragStore.type === 'in-memory') {
    for (const k of WEIGHT_FIELDS) {
      if (ragStore[k] !== undefined) input[k] = ragStore[k];
    }
  }
  // Spec D83 (13): a key written with no value is passed as read — its check names it.
  if (yaml.prompts !== undefined) input.prompts = yaml.prompts;
  if (yaml.circuitBreaker !== undefined)
    input.circuitBreaker = yaml.circuitBreaker;
  if (yaml.logDir !== undefined) input.logDir = yaml.logDir;
  return input;
}

/** The validated start values of the fields above (spec D83 (5)). */
export type StartConfigFields = HotReloadableConfig;

/**
 * The start config's fields of the reload table into `check` (spec §10.5.9 *The
 * start config*, D83 (5)): the YAML the server starts from — the same rules as a
 * reload — and the two `ResolveConfigArgs` overrides that replace a field, checked in
 * place and applied over it. Collects only: `resolveSmartServerConfig` goes on with
 * the same `check` through the section readers (D83 (7)) and calls `done()` once.
 */
export function checkStartConfig(
  check: FieldCheck,
  yaml: YamlConfig,
  args: {
    readonly 'agent-show-reasoning'?: unknown;
    readonly 'log-dir'?: unknown;
  },
): StartConfigFields {
  // Spec D83 (13): a key written with no value is an error anywhere in the
  // document — named before any section is read, so no reader sees a null.
  checkNoValue(check, yaml);
  // Spec D83 (10): the two top-level sections whose shape no other rule checks
  // (30.1.0 read `agent: broken` as no agent fields, `subagents: w` as no
  // workers). A key with no value was named above (D83 (13)).
  if (yaml.agent !== undefined) check.section('agent', yaml.agent);
  if (yaml.subagents !== undefined && !Array.isArray(yaml.subagents)) {
    check.refuse('subagents', 'must be a list', yaml.subagents);
  }
  const out: StartConfigFields = checkReloadable(check, startConfigInput(yaml));
  if (args['agent-show-reasoning'] !== undefined) {
    out.showReasoning = check.flag(
      'args.agent-show-reasoning',
      args['agent-show-reasoning'],
    );
  }
  if (args['log-dir'] !== undefined)
    out.logDir = check.text('args.log-dir', args['log-dir']);
  return out;
}

/**
 * `checkStartConfig` on its own check — throws `ConfigFieldError` naming every
 * invalid field. The file reload reads its typed values with it, after the
 * start's whole validation of the same document passed (D83 (10)).
 */
export function validateStartConfig(
  yaml: YamlConfig,
  args: {
    readonly 'agent-show-reasoning'?: unknown;
    readonly 'log-dir'?: unknown;
  },
): StartConfigFields {
  const check = new FieldCheck();
  return check.done(checkStartConfig(check, yaml, args));
}

/** PUT /v1/config's `agent` section (spec V10, D83); its keys are whitelisted by the route. */
export function validateAgentUpdate(
  agent: Readonly<Record<string, unknown>>,
): AgentUpdate {
  const check = new FieldCheck();
  const out: AgentUpdate = {};
  for (const k of UPDATABLE_AGENT_NUMBER_FIELDS) {
    if (agent[k] !== undefined)
      out[k] = check.number(`agent.${k}`, AGENT_NUMBER_RULES[k], agent[k]);
  }
  for (const k of UPDATABLE_AGENT_FLAG_FIELDS) {
    if (agent[k] !== undefined) out[k] = check.flag(`agent.${k}`, agent[k]);
  }
  return check.done(out);
}

/** PUT /v1/config's `models` section (spec V10, D83); its keys are whitelisted by the route. */
export function validateModelUpdate(
  models: Readonly<Record<string, unknown>>,
): ModelUpdate {
  const check = new FieldCheck();
  const out: ModelUpdate = {};
  for (const k of MODEL_FIELDS) {
    if (models[k] !== undefined) out[k] = check.text(`models.${k}`, models[k]);
  }
  return check.done(out);
}

const C = CAST_NUMBER_RULES;
/** `agent.retry` as `RetryLlm` merges it over its defaults (spec D83 (9)). */
type AgentRetry = {
  maxAttempts?: number;
  backoffMs?: number;
  retryOn?: number[];
  retryOnMidStream?: string[];
};
type AgentToolSelection = NonNullable<SmartServerAgentConfig['toolSelection']>;

/**
 * A key is present when it is written (spec D83 (13)): a `null` — a key written
 * with no value — is present, and the check it is handed names it `<path> has
 * no value`. Only a key not written takes its default.
 */
export function present(value: unknown): boolean {
  return value !== undefined;
}

/**
 * Every key written with no value (`null`) anywhere in `value` — a mapping's
 * entry or a list's item — as `<path> has no value` (spec D83 (13)): never
 * absent, never its default. Run first by `checkStartConfig` over the whole
 * document (the start, the reload, every worker file) and by PUT /v1/config
 * over its body; a reader that hands the same `null` to its check adds nothing
 * (`FieldCheck` names a key once).
 */
export function checkNoValue(
  check: FieldCheck,
  value: unknown,
  path = '',
): void {
  const at = (p: string, v: unknown): void => {
    if (v === null) check.refuse(p, 'has no value', v);
    else checkNoValue(check, v, p);
  };
  if (Array.isArray(value)) {
    value.forEach((v: unknown, i) => {
      at(`${path}[${i}]`, v);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value))
      at(path === '' ? k : `${path}.${k}`, v);
  }
}

/** `agent.retry` (spec D83 (9)): what `RetryLlm` merges over its defaults. */
export function checkRetry(check: FieldCheck, value: unknown): AgentRetry {
  const s = check.closed('agent.retry', value, RETRY_KEYS) ?? {};
  const out: AgentRetry = {};
  if (s.maxAttempts !== undefined)
    out.maxAttempts = check.number(
      'agent.retry.maxAttempts',
      C.countOrNone,
      s.maxAttempts,
    );
  if (s.backoffMs !== undefined)
    out.backoffMs = check.number(
      'agent.retry.backoffMs',
      C.delayMs,
      s.backoffMs,
    );
  if (s.retryOn !== undefined) {
    out.retryOn = check.list('agent.retry.retryOn', s.retryOn, (f, v) =>
      check.number(f, C.httpStatus, v),
    );
  }
  if (s.retryOnMidStream !== undefined) {
    out.retryOnMidStream = check.list(
      'agent.retry.retryOnMidStream',
      s.retryOnMidStream,
      (f, v) => check.text(f, v),
    );
  }
  return out;
}

/** `agent.toolSelection` (spec D83 (9)): what `resolveToolSelectionStrategy` takes. */
export function checkToolSelection(
  check: FieldCheck,
  value: unknown,
): AgentToolSelection {
  const s =
    check.closed('agent.toolSelection', value, ['strategy', 'minScore']) ?? {};
  const strategy = check.oneOf(
    'agent.toolSelection.strategy',
    TOOL_SELECTION_STRATEGIES,
    s.strategy,
  );
  if (strategy === 'top-k' && s.minScore !== undefined) {
    check.refuse(
      'agent.toolSelection.minScore',
      'only applies to strategy threshold',
      s.minScore,
    );
  }
  const minScore =
    strategy === 'threshold'
      ? s.minScore === undefined
        ? check.refuse(
            'agent.toolSelection.minScore',
            'is required for strategy threshold',
            s.minScore,
          )
        : check.number('agent.toolSelection.minScore', C.score, s.minScore)
      : undefined;
  return {
    strategy: strategy ?? '',
    ...(minScore !== undefined ? { minScore } : {}),
  };
}

/** `headers` / `toolTimeouts` of one MCP server, at `field` (`mcp` or `mcp[i]`). */
export function checkMcpMaps(
  check: FieldCheck,
  field: string,
  s: Readonly<Record<string, unknown>>,
): Pick<SmartServerMcpConfig, 'headers' | 'toolTimeouts'> {
  return {
    ...(s.headers !== undefined
      ? {
          headers: check.map(`${field}.headers`, s.headers, (f, v) =>
            check.text(f, v),
          ),
        }
      : {}),
    ...(s.toolTimeouts !== undefined
      ? {
          toolTimeouts: check.map(
            `${field}.toolTimeouts`,
            s.toolTimeouts,
            (f, v) => check.number(f, START_NUMBER_RULES.timerMs, v),
          ),
        }
      : {}),
  };
}

/**
 * One `mcp[]` entry at `field` (`mcp[i]`; spec D83 (9), (14)), as
 * `connectMcpClientsWithDescriptorsFromConfig` reads it. The entry's shape is
 * checked first — every field is read from the checked mapping, or from the
 * `{}` stand-in after a recorded issue (`mcp: [null]` → `mcp[0] has no value`,
 * never a TypeError: readers run before `done()`, D83 (14)).
 */
export function checkMcpEntry(
  check: FieldCheck,
  field: string,
  value: unknown,
): SmartServerMcpConfig {
  const s = check.closed(field, value, MCP_ENTRY_KEYS) ?? {};
  // Absent = http: the consumer connects every entry that is not stdio as http.
  const type =
    s.type === undefined
      ? 'http'
      : (check.oneOf(`${field}.type`, MCP_ENTRY_TYPES, s.type) ?? 'http');
  return {
    type,
    ...(s.url !== undefined ? { url: check.text(`${field}.url`, s.url) } : {}),
    ...(s.command !== undefined
      ? { command: check.text(`${field}.command`, s.command) }
      : {}),
    ...(s.args !== undefined
      ? {
          args: check.list(`${field}.args`, s.args, (f, v) =>
            typeof v === 'string' ? v : check.refuse(f, 'must be a string', v),
          ),
        }
      : {}),
    ...checkMcpMaps(check, field, s),
    ...(s.timeout !== undefined
      ? {
          timeout: check.number(
            `${field}.timeout`,
            START_NUMBER_RULES.timerMs,
            s.timeout,
          ),
        }
      : {}),
    // Spec D83 (14): the label rule is this check's (30.1.0 read the raw
    // `entry.name` before the entry's shape — `mcp: [null]` was a TypeError).
    ...(s.name !== undefined
      ? {
          name:
            typeof s.name === 'string' && MCP_NAME_PATTERN.test(s.name)
              ? s.name
              : check.refuse(
                  `${field}.name`,
                  'must be a label of letters, digits, _ and -',
                  s.name,
                ),
        }
      : {}),
  };
}

/**
 * `mcp` in its list form (spec D83 (9), (14)): the list first, each item through
 * `checkMcpEntry`, then the labels unique among the checked entries — every
 * issue in the same check, none thrown. An entry without a name takes the
 * namespace's `s<slot>` fallback, as in 30.1.0.
 */
export function checkMcpList(
  check: FieldCheck,
  value: unknown,
): SmartServerMcpConfig[] {
  const entries =
    check.list('mcp', value, (f, v) => checkMcpEntry(check, f, v)) ?? [];
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    if (e.name === undefined) return;
    if (seen.has(e.name))
      check.refuse(
        `mcp[${i}].name`,
        'must be unique among the mcp entries',
        e.name,
      );
    seen.add(e.name);
  });
  return entries;
}

/**
 * The config document (spec D83 (14)): a mapping, checked before anything of it
 * is read — `config must be a mapping, got <value>`, `config has no value` for a
 * `null` handed in code. A file with no document is `{}` (`loadYamlConfig`, the
 * watcher's `document ?? {}`); 30.1.0 threw a TypeError on it at start and read
 * a scalar or a list as no keys (a worker's string or list through its indices).
 */
export function checkDocument(value: unknown): YamlConfig {
  const check = new FieldCheck();
  return check.done(check.section('config', value) ?? {});
}

/**
 * `skills` (spec D83 (9)), as `resolveSkillManager` reads it. The ONE rule for
 * `skills.type` (spec D89, S-10): `validateResolvedConfig` has none (Task 4L added
 * none), so an unknown type is one issue of the ConfigFieldError.
 */
export function checkSkills(
  check: FieldCheck,
  value: unknown,
): SmartServerSkillsConfig {
  const s = check.section('skills', value) ?? {};
  return {
    type:
      s.type === undefined
        ? 'claude'
        : (check.oneOf('skills.type', SKILLS_TYPES, s.type) ?? 'claude'),
    ...(s.dirs !== undefined
      ? { dirs: check.list('skills.dirs', s.dirs, (f, v) => check.text(f, v)) }
      : {}),
    ...(s.projectRoot !== undefined
      ? { projectRoot: check.text('skills.projectRoot', s.projectRoot) }
      : {}),
  };
}

/** `knowledgeSeed` (spec D83 (9), (12)): the stepper's parser, `resolvePipelineSelection` and the server's session seeding read it with this rule. */
export function checkKnowledgeSeed(
  check: FieldCheck,
  field: string,
  value: unknown,
): Array<{ content: string; artifactType: string }> {
  return (
    check.list(field, value, (f, e) => {
      const m = check.section(f, e);
      if (!m) return undefined;
      const content = check.text(`${f}.content`, m.content);
      const artifactType =
        m.artifactType !== undefined
          ? check.text(`${f}.artifactType`, m.artifactType)
          : 'guidance';
      return content !== undefined && artifactType !== undefined
        ? { content, artifactType }
        : undefined;
    }) ?? []
  );
}
