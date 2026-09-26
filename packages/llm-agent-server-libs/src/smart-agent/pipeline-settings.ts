import type { FinalizerYaml } from '../pipelines/coordinator-resolvers.js';
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
  if (raw === undefined || raw === null) return {};
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
  return {
    planning: planning as LinearPipelineSettings['planning'],
    ...(cfg.dispatch !== undefined
      ? { dispatch: cfg.dispatch as LinearPipelineSettings['dispatch'] }
      : {}),
    maxSteps: (cfg.maxSteps as number | undefined) ?? 10,
    maxRetriesPerStep: (cfg.maxRetriesPerStep as number | undefined) ?? 1,
    failPolicy: (cfg.failPolicy as 'abort' | 'continue' | undefined) ?? 'abort',
  };
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
  const block = (v: unknown): Section =>
    typeof v === 'object' && v !== null ? (v as Section) : {};

  const plannerLlm = optionalKey(
    block(cfg.planner).plannerLlm,
    "pipeline 'dag': 'planner.plannerLlm'",
  );

  let reviewer: DagPipelineSettings['reviewer'];
  if (cfg.reviewer !== undefined) {
    const name = resolveReviewerLlmName(
      block(cfg.reviewer) as { reviewerLlm?: string; plannerLlm?: string },
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

  const es = block(cfg.errorStrategy);
  const errorStrategy: DagPipelineSettings['errorStrategy'] =
    es.type === 'replan'
      ? {
          type: 'replan',
          ...(typeof es.maxReplans === 'number'
            ? { maxReplans: es.maxReplans }
            : {}),
        }
      : es.type === 'abort'
        ? { type: 'abort' }
        : undefined;

  const finalizer = cfg.finalizer as FinalizerYaml | undefined;
  optionalKey(
    finalizer?.finalizerLlm,
    "pipeline 'dag': 'finalizer.finalizerLlm'",
  );

  return {
    ...(plannerLlm !== undefined ? { plannerLlm } : {}),
    ...(reviewer !== undefined ? { reviewer } : {}),
    ...(finalizer !== undefined ? { finalizer } : {}),
    ...(typeof cfg.stateOracle === 'string'
      ? { stateOracle: cfg.stateOracle }
      : {}),
    activation: activation as DagPipelineSettings['activation'],
    ...(errorStrategy !== undefined ? { errorStrategy } : {}),
    ...(typeof cfg.maxRoundTrips === 'number'
      ? { maxRoundTrips: cfg.maxRoundTrips }
      : {}),
  };
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
 *  the section guard changed. `subagents.<role>` is still an inline LLM configuration;
 *  Task B15 makes it name an `llm:` key. */
export function parseControllerSettings(raw: unknown): ControllerConfig {
  const cfg = asSection(raw, 'controller');
  const subagents = (cfg.subagents ?? {}) as Record<string, unknown>;
  for (const role of ['evaluator', 'planner', 'executor'] as const) {
    if (subagents[role] === undefined) {
      throw new Error(
        `pipeline 'controller' requires 'subagents.${role}' (each an LLM config with at least a 'provider')`,
      );
    }
  }

  const targetStateRaw = (cfg.targetState ?? {}) as Record<string, unknown>;
  const sessionMemoryRaw = (cfg.sessionMemory ?? {}) as Record<string, unknown>;
  const budgetsRaw = (cfg.budgets ?? {}) as Record<string, unknown>;

  if ('planner' in cfg) {
    throw new Error(
      'controller: `planner:` removed — capability is preset-encoded. Select ' +
        'pipeline: { name: controller } (smart-executor) or ' +
        '{ name: controller-weak } (weak-executor), or pass the kind to ' +
        '`new ControllerFactory().build(config, deps, "weak-executor")` when ' +
        'composing in code. No `planner:` alias exists.',
    );
  }

  const requireInt = (
    key: 'maxWaitMs' | 'maxTotalWaitMs',
    min: number,
  ): void => {
    const v = budgetsRaw[key];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
      throw new Error(
        `controller: 'budgets.${key}' must be a ${min > 0 ? 'positive' : 'non-negative'} finite integer (ms), got ${JSON.stringify(v)}`,
      );
    }
  };
  requireInt('maxWaitMs', 1);
  requireInt('maxTotalWaitMs', 0);

  return {
    subagents: subagents as ControllerConfig['subagents'],
    targetState: {
      strategy: 'auto',
      distanceThreshold: 0.25,
      ...targetStateRaw,
    } as ControllerConfig['targetState'],
    sessionMemory: {
      collection: 'session-memory',
      ...sessionMemoryRaw,
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
      ...budgetsRaw,
    } as ControllerConfig['budgets'],
  };
}
