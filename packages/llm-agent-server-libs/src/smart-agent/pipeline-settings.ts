import { parseControllerSubagents } from '../pipelines/controller-subagents.js';
import type { FinalizerYaml } from '../pipelines/coordinator-resolvers.js';
import {
  CAST_NUMBER_RULES as C,
  CONTROLLER_BUDGET_RULES,
  DAG_ERROR_STRATEGIES,
  FAIL_POLICIES,
  FINALIZER_TYPES,
  FieldCheck,
  present,
  START_NUMBER_RULES,
  TARGET_STATE_STRATEGIES,
} from './config-fields.js';
import type { ControllerConfig } from './controller/types.js';
import {
  type NormalizedLlmMap,
  resolveReviewerLlmName,
} from './llm-config-map.js';
import {
  parseStepperCoordinatorConfig,
  type StepperCoordinatorConfig,
} from './stepper-config.js';

/**
 * The server's parsers for the built-in pipelines' sections (§4.6.7). A plugin reads
 * no configuration: SmartServer parses the selected section here at startup and
 * constructs the plugin with the typed result. Exported so a consumer composing a
 * built-in in code parses exactly as the server does.
 */

type Section = Record<string, unknown>;

function asSection(raw: unknown, pipeline: string): Section {
  if (raw === undefined) return {};
  if (raw === null) {
    // Spec D83 (13): a section written with no value is that, never its
    // default — the check names it and `done` throws.
    const check = new FieldCheck();
    check.refuse('pipeline.config', 'has no value', raw);
    return check.done({});
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `pipeline '${pipeline}': 'pipeline.config' must be an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`,
    );
  }
  return raw as Section;
}

function optionalKey(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `${where} must name an llm: key (a non-empty string), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ---- linear -------------------------------------------------------------

const PLANNING = ['one-shot', 'replan-on-error', 'skill-steps'] as const;
const DISPATCH = ['subagent', 'self', 'hybrid'] as const;

export interface LinearPipelineSettings {
  planning: (typeof PLANNING)[number];
  /** Omitted → `resolveCoordinatorDispatchKind`'s default. */
  dispatch?: (typeof DISPATCH)[number];
  maxSteps: number;
  maxRetriesPerStep: number;
  failPolicy: 'abort' | 'continue';
}

export function parseLinearSettings(raw: unknown): LinearPipelineSettings {
  const cfg = asSection(raw, 'linear');
  const planning = cfg.planning ?? 'one-shot';
  if (!(PLANNING as readonly unknown[]).includes(planning)) {
    throw new Error(
      `Unknown coordinator.planning strategy: '${String(planning)}'. Allowed: ${PLANNING.join(', ')}.`,
    );
  }
  if (
    cfg.dispatch !== undefined &&
    !(DISPATCH as readonly unknown[]).includes(cfg.dispatch)
  ) {
    throw new Error(
      `Unknown coordinator.dispatch strategy: '${String(cfg.dispatch)}'. Allowed: ${DISPATCH.join(', ')}.`,
    );
  }
  // Spec D83 (9): every checked field first; done is the only way out.
  const check = new FieldCheck();
  const maxSteps = check.numberOr(
    'maxSteps',
    START_NUMBER_RULES.count,
    cfg.maxSteps,
    10,
  );
  const maxRetriesPerStep = check.numberOr(
    'maxRetriesPerStep',
    C.countOrNone,
    cfg.maxRetriesPerStep,
    1,
  );
  const failPolicy =
    cfg.failPolicy !== undefined
      ? (check.oneOf('failPolicy', FAIL_POLICIES, cfg.failPolicy) ?? 'abort')
      : 'abort';
  const result: LinearPipelineSettings = {
    planning: planning as LinearPipelineSettings['planning'],
    ...(cfg.dispatch !== undefined
      ? { dispatch: cfg.dispatch as LinearPipelineSettings['dispatch'] }
      : {}),
    maxSteps,
    maxRetriesPerStep,
    failPolicy,
  };
  return check.done(result);
}

// ---- stepper ------------------------------------------------------------

export function parseStepperSettings(raw: unknown): StepperCoordinatorConfig {
  return parseStepperCoordinatorConfig(asSection(raw, 'stepper'));
}

// ---- dag ----------------------------------------------------------------

export interface DagPipelineSettings {
  /** `planner.plannerLlm` — an `llm:` key; omitted → the `planner` role's default. */
  plannerLlm?: string;
  /** Present iff the section has a `reviewer:` block; an omitted key → the role default. */
  reviewer?: { reviewerLlm?: string };
  finalizer?: FinalizerYaml;
  stateOracle?: string;
  activation: 'auto' | 'explicit';
  errorStrategy?: { type: 'replan'; maxReplans?: number } | { type: 'abort' };
  maxRoundTrips?: number;
}

export function parseDagSettings(
  raw: unknown,
  warn: (msg: string) => void,
): DagPipelineSettings {
  const cfg = asSection(raw, 'dag');
  if (cfg.planner === undefined) {
    throw new Error("pipeline 'dag' requires a 'planner' in its config");
  }
  // Spec D83 (9): every checked field first; done is the only way out.
  const check = new FieldCheck();
  // `planner`, `reviewer` — open mappings: the examples carry a `type` the
  // parser does not read.
  const block = (field: string, v: unknown): Section =>
    present(v) ? (check.section(field, v) ?? {}) : {};

  const plannerLlm = optionalKey(
    block('planner', cfg.planner).plannerLlm,
    "pipeline 'dag': 'planner.plannerLlm'",
  );

  let reviewer: DagPipelineSettings['reviewer'];
  if (cfg.reviewer !== undefined) {
    const name = resolveReviewerLlmName(
      block('reviewer', cfg.reviewer) as {
        reviewerLlm?: string;
        plannerLlm?: string;
      },
      warn,
    );
    const reviewerLlm = optionalKey(
      name,
      "pipeline 'dag': 'reviewer.reviewerLlm'",
    );
    reviewer = reviewerLlm !== undefined ? { reviewerLlm } : {};
  }

  const activation = cfg.activation ?? 'explicit';
  if (activation !== 'auto' && activation !== 'explicit') {
    throw new Error(
      `Unknown coordinator.activation strategy: '${String(activation)}'. Allowed: auto, explicit.`,
    );
  }

  let errorStrategy: DagPipelineSettings['errorStrategy'];
  if (present(cfg.errorStrategy)) {
    const es = check.section('errorStrategy', cfg.errorStrategy) ?? {};
    const type = check.oneOf(
      'errorStrategy.type',
      DAG_ERROR_STRATEGIES,
      es.type,
    );
    const maxReplans =
      es.maxReplans === undefined
        ? undefined
        : type === 'replan'
          ? check.number(
              'errorStrategy.maxReplans',
              C.countOrNone,
              es.maxReplans,
            )
          : check.refuse(
              'errorStrategy.maxReplans',
              'only applies to type replan',
              es.maxReplans,
            );
    errorStrategy =
      type === 'replan'
        ? {
            type: 'replan',
            ...(maxReplans !== undefined ? { maxReplans } : {}),
          }
        : type === 'abort'
          ? { type: 'abort' }
          : undefined;
  }

  let finalizer: FinalizerYaml | undefined;
  if (present(cfg.finalizer)) {
    const f = check.section('finalizer', cfg.finalizer) ?? {};
    const type =
      f.type !== undefined
        ? check.oneOf('finalizer.type', FINALIZER_TYPES, f.type)
        : undefined;
    const finalizerLlm = optionalKey(
      f.finalizerLlm,
      "pipeline 'dag': 'finalizer.finalizerLlm'",
    );
    const systemPrompt =
      f.systemPrompt !== undefined
        ? check.text('finalizer.systemPrompt', f.systemPrompt)
        : undefined;
    finalizer = {
      ...(type !== undefined ? { type } : {}),
      ...(finalizerLlm !== undefined ? { finalizerLlm } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    };
  }
  const stateOracle =
    cfg.stateOracle !== undefined
      ? check.text('stateOracle', cfg.stateOracle)
      : undefined;
  const maxRoundTrips =
    cfg.maxRoundTrips !== undefined
      ? check.number(
          'maxRoundTrips',
          START_NUMBER_RULES.count,
          cfg.maxRoundTrips,
        )
      : undefined;

  const result: DagPipelineSettings = {
    ...(plannerLlm !== undefined ? { plannerLlm } : {}),
    ...(reviewer !== undefined ? { reviewer } : {}),
    ...(finalizer !== undefined ? { finalizer } : {}),
    ...(stateOracle !== undefined ? { stateOracle } : {}),
    activation: activation as DagPipelineSettings['activation'],
    ...(errorStrategy !== undefined ? { errorStrategy } : {}),
    ...(maxRoundTrips !== undefined ? { maxRoundTrips } : {}),
  };
  return check.done(result);
}

/** The `llm:` keys a dag section NAMED — each must exist, checked at startup. */
export function dagNamedLlmKeys(settings: DagPipelineSettings): string[] {
  const keys: string[] = [];
  if (settings.plannerLlm !== undefined) keys.push(settings.plannerLlm);
  if (settings.reviewer?.reviewerLlm !== undefined)
    keys.push(settings.reviewer.reviewerLlm);
  const kind = settings.finalizer?.type ?? 'passthrough';
  const finalizerLlm = settings.finalizer?.finalizerLlm;
  if (
    kind !== 'passthrough' &&
    kind !== 'template' &&
    finalizerLlm !== undefined
  ) {
    keys.push(finalizerLlm);
  }
  return keys;
}

/**
 * Refuse, at startup, a key a built-in section named that has no `llm:` entry — the
 * same answer `resolveNamedLlm` would give at the first session, given while the
 * operator is still watching (§4.6.7). Task B15 adds controller's and the worker
 * files' keys to the callers.
 */
export function assertNamedLlmKeys(
  keys: readonly string[],
  map: NormalizedLlmMap | undefined,
  where: string,
): void {
  for (const key of keys) {
    if (map && Object.hasOwn(map, key)) continue;
    throw new Error(
      `${where} names llm: key '${key}', but llm: has no entry of that name ` +
        `(declared: ${map ? Object.keys(map).join(', ') : 'none'})`,
    );
  }
}

// ---- controller ---------------------------------------------------------

/** Moved from `ControllerPipelinePlugin.parseConfig` (`controller.ts:83-150`) with only
 *  the section guard changed. `subagents.<role>` names an `llm:` key; a named key
 *  with no entry is refused here, at startup. */
export function parseControllerSettings(
  raw: unknown,
  llmKeys: ReadonlySet<string>,
): ControllerConfig {
  const cfg = asSection(raw, 'controller');

  if ('planner' in cfg) {
    throw new Error(
      'controller: `planner:` removed — capability is preset-encoded. Select ' +
        'pipeline: { name: controller } (smart-executor) or ' +
        '{ name: controller-weak } (weak-executor), or pass the kind to ' +
        '`new ControllerFactory().build(config, deps, "weak-executor")` when ' +
        'composing in code. No `planner:` alias exists.',
    );
  }

  // Spec D83 (9): every checked field first; done is the only way out. The
  // three blocks are closed mappings; their values are validated, then spread
  // over the defaults (never the raw ones).
  const check = new FieldCheck();
  const closed = (field: string, v: unknown, keys: readonly string[]) =>
    present(v) ? (check.closed(field, v, keys) ?? {}) : {};
  const targetStateRaw = closed('targetState', cfg.targetState, [
    'strategy',
    'distanceThreshold',
  ]);
  const sessionMemoryRaw = closed('sessionMemory', cfg.sessionMemory, [
    'collection',
  ]);
  const budgetsRaw = closed(
    'budgets',
    cfg.budgets,
    Object.keys(CONTROLLER_BUDGET_RULES),
  );
  const targetState: Record<string, unknown> = {};
  if (targetStateRaw.strategy !== undefined) {
    targetState.strategy = check.oneOf(
      'targetState.strategy',
      TARGET_STATE_STRATEGIES,
      targetStateRaw.strategy,
    );
  }
  if (targetStateRaw.distanceThreshold !== undefined) {
    targetState.distanceThreshold = check.number(
      'targetState.distanceThreshold',
      C.cosineDistance,
      targetStateRaw.distanceThreshold,
    );
  }
  const sessionMemory: Record<string, unknown> = {};
  if (sessionMemoryRaw.collection !== undefined) {
    sessionMemory.collection = check.text(
      'sessionMemory.collection',
      sessionMemoryRaw.collection,
    );
  }
  const budgets: Record<string, unknown> = {};
  for (const k of Object.keys(CONTROLLER_BUDGET_RULES) as Array<
    keyof typeof CONTROLLER_BUDGET_RULES
  >) {
    if (budgetsRaw[k] !== undefined) {
      budgets[k] = check.number(
        `budgets.${k}`,
        CONTROLLER_BUDGET_RULES[k],
        budgetsRaw[k],
      );
    }
  }
  const subagents = parseControllerSubagents(cfg.subagents, llmKeys);

  const result: ControllerConfig = {
    subagents,
    targetState: {
      strategy: 'auto',
      distanceThreshold: 0.25,
      ...targetState,
    } as ControllerConfig['targetState'],
    sessionMemory: {
      collection: 'session-memory',
      ...sessionMemory,
    } as ControllerConfig['sessionMemory'],
    budgets: {
      maxSteps: 20,
      maxRetries: 3,
      maxRewinds: 5,
      maxToolCalls: 10,
      maxDigestChars: 500,
      maxIntentChars: 120,
      maxActiveSteps: 16,
      maxBoardChars: 12000,
      keepRecentDigests: 8,
      maxWaitMs: 600_000,
      maxTotalWaitMs: 1_800_000,
      ...budgets,
    } as ControllerConfig['budgets'],
  };
  return check.done(result);
}
