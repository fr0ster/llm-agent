/**
 * Stepper coordinator configuration: types, constants, and parser.
 * Extracted from config.ts (R6) — byte-for-byte move.
 */

import type { PlanNode } from '@mcp-abap-adt/llm-agent';
import {
  checkKnowledgeSeed,
  FieldCheck,
  present,
  START_NUMBER_RULES,
} from './config-fields.js';

/**
 * Stepper coordinator modes.
 */
// `deep-stepper` (18.1): flow + demand-driven recursion. Re-enabled now that the
// runaway is fenced — the Evaluator is the per-level TERMINATION judge (executable
// → leaf, needs-work → recurse), identity-dedup stops re-doing work, and maxDepth
// + the token ledger bound it. Recursion is REJECTED unless the Evaluator is on.
export type StepperMode = 'cyclic-react' | 'planned-react' | 'deep-stepper';

/**
 * Configuration for the recursive Stepper coordinator.
 */
/**
 * A node of a declared composition tree. A leaf executes via the executor; a
 * node with a nested `flow` runs as a child Stepper (structural recursion —
 * the sub-cycle is declared and visible).
 */
export interface CompositionNode {
  id: string;
  goal: string;
  dependsOn?: string[];
  flow?: StepperCompositionSpec;
}

/**
 * Front-end-agnostic description of a Stepper composition. Produced by BOTH the
 * yaml parser (`toCompositionSpec`) and a code builder; consumed by the runtime
 * (`buildFromComposition`). Recursive via `nodes[].flow`.
 */
export interface StepperCompositionSpec {
  planner: 'none' | 'llm' | 'static';
  granularity: 'shallow' | 'detailed';
  plan?: PlanNode[];
  /** Declared composition nodes; a node with a nested `flow` is a sub-Stepper. */
  nodes?: CompositionNode[];
  executor: 'simple' | 'cyclic-react' | 'recursive';
  finalizer: 'llm';
  /** Optional system-prompt overrides (consumer-supplied via yaml/builder).
   *  Undefined → the built-in STEPPER_PLANNER_SYSTEM / EXECUTOR_SYSTEM. */
  plannerSystemPrompt?: string;
  executorSystemPrompt?: string;
  /** 18.1 Evaluator: ON by default at all depths. Judges (sub-)prompt
   *  completeness WITH the RAG context before planning. */
  evaluatorEnabled: boolean;
  evaluatorAtDepths: { has(depth: number): boolean };
  evaluatorSystemPrompt?: string;
  reviewerAtDepths: { has(depth: number): boolean };
  maxParallelSteps: number;
  maxDepth: number;
  tokenBudget: number;
  formalizeTask: boolean;
}

export interface StepperCoordinatorConfig {
  mode: StepperMode;
  reviewerAtDepths: { has(depth: number): boolean };
  maxParallelSteps: number;
  maxDepth: number;
  tokenBudget: number;
  /**
   * Session-scope knowledge entries written into a NEW session's knowledge-RAG
   * before planning. A deployment/config PARAMETER (not agent code) — the
   * operator fills it with guidance for THEIR actual MCP tools (e.g. which read
   * tool reads what). Surfaced to the planner/executor as "Known facts", and the
   * executor enriches its tool-search query with these facts, so a tool named in
   * a seed takes priority over tools the bare-prompt MCP search would surface.
   * The runtime stays MCP-agnostic: tool knowledge lives here as data.
   */
  knowledgeSeed: ReadonlyArray<{ content: string; artifactType: string }>;
  /**
   * Opt-in (default false): formalize the raw prompt into a compact TaskSpec
   * (objective + scope + constraints + deliverable) ONCE at the root, then
   * thread it down to every planner and executor as a persistent anchor and as
   * the overall-intent prefix for tool search. Off → behaves exactly as before.
   */
  formalizeTask: boolean;
  /**
   * Resolved program flow (the composition the coordinator runs). Always
   * present: parsed from an explicit `coordinator.flow` block when given, else
   * derived from `mode` as a preset (so `mode` is now just a preset alias).
   *
   *  - planner  'none'   → trivial single-node plan (node goal = prompt)
   *             'llm'    → LlmStepperPlanner (LLM decomposition)
   *             'static' → StaticPlanner (declarative `flow.plan`, no LLM)
   *  - executor 'cyclic-react' → leaf ReAct loop, no recursion
   *             'recursive'    → may spawn child Steppers up to maxDepth
   *  - finalizer 'llm' (RootFinalizer). 'passthrough' is reserved (not yet built).
   */
  flow: {
    planner: 'none' | 'llm' | 'static';
    /** How much the LLM planner decomposes up front (eager): 'shallow' (few
     *  high-level steps) | 'detailed' (full concrete-leaf decomposition).
     *  Ignored by 'none'/'static'. Default 'shallow'. */
    granularity: 'shallow' | 'detailed';
    /** Leaf executor profile: 'simple' (single pass) | 'cyclic-react' (ReAct
     *  loop) | 'recursive' (spawns child Steppers — lazy decomposition). */
    executor: 'simple' | 'cyclic-react' | 'recursive';
    finalizer: 'llm';
    /** Optional per-role system-prompt overrides:
     *  `flow.planner.systemPrompt` / `flow.executor.systemPrompt`. */
    plannerSystemPrompt?: string;
    executorSystemPrompt?: string;
    /** 18.1 Evaluator (ON by default at all depths). Configure via
     *  `flow.evaluator: { enabled?, atDepths?, systemPrompt? }`. */
    evaluatorEnabled: boolean;
    evaluatorAtDepths: { has(depth: number): boolean };
    evaluatorSystemPrompt?: string;
    /** Declarative plan nodes, required when planner === 'static'. */
    plan?: PlanNode[];
    /**
     * Declared composition nodes (the "yaml is a tree" shape). A node with a
     * nested `flow` is a sub-Stepper. When present at the root, the planner is
     * effectively static over these nodes.
     */
    nodes?: CompositionNode[];
  };
}

const MODES = new Set<StepperMode>([
  'cyclic-react',
  'planned-react',
  'deep-stepper',
]);

/**
 * Preset expansion: each `mode` maps to a default `flow` composition.
 * An explicit `coordinator.flow` block overrides these per-component.
 * `deep-stepper` = llm planner + RECURSIVE executor (demand-driven recursion),
 * relying on the Evaluator as terminator (enforced below).
 */
const MODE_FLOW_PRESET: Record<
  StepperMode,
  { planner: 'none' | 'llm'; executor: 'cyclic-react' | 'recursive' }
> = {
  'cyclic-react': { planner: 'none', executor: 'cyclic-react' },
  'planned-react': { planner: 'llm', executor: 'cyclic-react' },
  'deep-stepper': { planner: 'llm', executor: 'recursive' },
};

type Section = Readonly<Record<string, unknown>>;

/** `v` checked as a mapping when written; `undefined` when not written (spec D83 (9), (12)). */
function optionalSection(
  check: FieldCheck,
  field: string,
  v: unknown,
): Section | undefined {
  return present(v) ? (check.section(field, v) ?? {}) : undefined;
}

/**
 * One plan / composition node at `f` (spec D83 (9)): a mapping, `goal` a
 * non-empty string, `id` / `agent` non-empty strings when written,
 * `dependsOn` a list of non-empty strings when written — never dropped.
 */
function parseNodeBase(
  check: FieldCheck,
  f: string,
  v: unknown,
  index: number,
):
  | {
      node: Section;
      id: string;
      goal: string;
      dependsOn?: string[];
      agent?: string;
    }
  | undefined {
  const node = check.section(f, v);
  if (!node) return undefined;
  const goal = check.text(`${f}.goal`, node.goal);
  const id =
    node.id !== undefined ? check.text(`${f}.id`, node.id) : `n${index}`;
  const agent =
    node.agent !== undefined ? check.text(`${f}.agent`, node.agent) : undefined;
  const dependsOn =
    node.dependsOn !== undefined
      ? check.list(`${f}.dependsOn`, node.dependsOn, (g, d) => check.text(g, d))
      : undefined;
  if (goal === undefined || id === undefined) return undefined;
  return {
    node,
    id,
    goal,
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(agent !== undefined ? { agent } : {}),
  };
}

/** Parse declarative `flow.plan` nodes (for the static planner). */
function parseFlowPlan(
  raw: unknown,
  check: FieldCheck,
  field: string,
): PlanNode[] | undefined {
  if (!present(raw)) return undefined;
  let index = 0;
  const nodes = check.list(field, raw, (f, v) => {
    const base = parseNodeBase(check, f, v, index++);
    if (!base) return undefined;
    const { node: _node, ...planNode } = base;
    return planNode as PlanNode;
  });
  // A list that is present but empty stays "no plan", as in 30.1.0.
  return nodes && nodes.length > 0 ? nodes : undefined;
}

/** Bounds a nested composition flow inherits from the root. */
type FlowBounds = Pick<
  StepperCompositionSpec,
  | 'reviewerAtDepths'
  | 'evaluatorEnabled'
  | 'evaluatorAtDepths'
  | 'evaluatorSystemPrompt'
  | 'maxParallelSteps'
  | 'maxDepth'
  | 'tokenBudget'
  | 'formalizeTask'
>;

/**
 * Parse a (possibly nested) `flow` block into a full StepperCompositionSpec,
 * inheriting bounds from the root. Mutually recursive with
 * parseCompositionNodes (function declarations are hoisted). `flowCfg` is a
 * checked section (spec D83 (9)); its blocks are checked before a field of
 * them is read, and read through `?.` (D83 (14)).
 */
function parseNestedFlowSpec(
  flowCfg: Section,
  bounds: FlowBounds,
  check: FieldCheck,
  field: string,
): StepperCompositionSpec {
  const planner = optionalSection(check, `${field}.planner`, flowCfg.planner);
  const executorCfg = optionalSection(
    check,
    `${field}.executor`,
    flowCfg.executor,
  );
  const plannerType = (planner?.type ?? 'llm') as string;
  if (!['none', 'llm', 'static'].includes(plannerType))
    throw new Error(`flow.planner.type must be none|llm|static`);
  const granularity = (planner?.granularity ?? 'shallow') as string;
  if (!['shallow', 'detailed'].includes(granularity))
    throw new Error(`flow.planner.granularity must be shallow|detailed`);
  const executor = (executorCfg?.type ?? 'cyclic-react') as string;
  if (!['simple', 'cyclic-react', 'recursive'].includes(executor))
    throw new Error(`flow.executor.type must be simple|cyclic-react|recursive`);
  const plannerSystemPrompt = parseSystemPromptOverride(
    planner?.systemPrompt,
    'flow.planner.systemPrompt',
  );
  const executorSystemPrompt = parseSystemPromptOverride(
    executorCfg?.systemPrompt,
    'flow.executor.systemPrompt',
  );
  const plan = parseFlowPlan(flowCfg.plan, check, `${field}.plan`);
  const nodes = parseCompositionNodes(
    flowCfg.nodes,
    bounds,
    check,
    `${field}.nodes`,
  );
  return {
    // Declared nodes ARE the plan ⇒ this level is static (keep the spec honest:
    // buildFromComposition routes a node-bearing level to a StaticPlanner).
    planner: (nodes ? 'static' : plannerType) as 'none' | 'llm' | 'static',
    granularity: granularity as 'shallow' | 'detailed',
    ...(plan ? { plan } : {}),
    ...(nodes ? { nodes } : {}),
    executor: executor as 'simple' | 'cyclic-react' | 'recursive',
    finalizer: 'llm',
    ...(plannerSystemPrompt ? { plannerSystemPrompt } : {}),
    ...(executorSystemPrompt ? { executorSystemPrompt } : {}),
    ...bounds,
  };
}

/** Validate an optional system-prompt override: must be a non-empty string. */
function parseSystemPromptOverride(
  raw: unknown,
  label: string,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '')
    throw new Error(`coordinator.${label} must be a non-empty string`);
  return raw;
}

/** Parse composition nodes; a node with a nested `flow` recurses into a sub-spec. */
function parseCompositionNodes(
  raw: unknown,
  bounds: FlowBounds,
  check: FieldCheck,
  field: string,
): CompositionNode[] | undefined {
  if (!present(raw)) return undefined;
  let index = 0;
  const nodes = check.list(field, raw, (f, v) => {
    const base = parseNodeBase(check, f, v, index++);
    if (!base) return undefined;
    const { node, id, goal, dependsOn } = base;
    const flow = optionalSection(check, `${f}.flow`, node.flow);
    const out: CompositionNode = {
      id,
      goal,
      ...(dependsOn !== undefined ? { dependsOn } : {}),
      ...(flow !== undefined
        ? { flow: parseNestedFlowSpec(flow, bounds, check, `${f}.flow`) }
        : {}),
    };
    return out;
  });
  // A list that is present but empty stays "no nodes", as in 30.1.0.
  return nodes && nodes.length > 0 ? nodes : undefined;
}

/**
 * Parse stepper coordinator configuration from a raw config object.
 *
 * Supports:
 * - `mode` (string) — default 'planned-react'; one of cyclic-react | planned-react
 * - `stepper.maxParallelSteps` (number) — default 4
 * - `stepper.maxDepth` (number) — default 4
 * - `stepper.tokenBudget` (number) — default 1,000,000
 * - `stepper.reviewer.atDepths` (number[] | 'all') — default [0,1]; 'all' means accept any depth
 */
export function parseStepperCoordinatorConfig(
  coord: Record<string, unknown>,
): StepperCoordinatorConfig {
  const mode = (coord.mode as StepperMode | undefined) ?? 'planned-react';
  if (!MODES.has(mode))
    throw new Error(`unknown coordinator.mode '${String(coord.mode)}'`);
  // Spec D83 (7), (9): every checked field first — named as the key inside the
  // pipeline's `config` — then done, the only way they leave the check.
  const check = new FieldCheck();
  const R = START_NUMBER_RULES;

  // Tool permissioning is the MCP SERVER's responsibility — whatever it exposes
  // via tools/list is allowed. The agent does not classify tools (read-only vs
  // mutating); there is no agent-side gate. The consumer wires the agent to a
  // server that exposes only the permitted tools (e.g. a read-only MCP proxy).

  const stepper = optionalSection(check, 'stepper', coord.stepper) ?? {};
  const reviewerCfg =
    optionalSection(check, 'stepper.reviewer', stepper.reviewer) ?? {};
  const depths = (field: string, v: unknown): 'all' | number[] =>
    v === 'all'
      ? 'all'
      : (check.list(field, v, (f, d) => check.number(f, R.depth, d)) ?? []);
  const atDepths =
    reviewerCfg.atDepths !== undefined
      ? depths('stepper.reviewer.atDepths', reviewerCfg.atDepths)
      : [0, 1];
  const reviewerAtDepths =
    atDepths === 'all'
      ? { has: () => true }
      : (() => {
          const s = new Set(atDepths);
          return { has: (d: number) => s.has(d) };
        })();

  const knowledgeSeed = present(coord.knowledgeSeed)
    ? checkKnowledgeSeed(check, 'knowledgeSeed', coord.knowledgeSeed)
    : [];

  // Resolve the program flow: explicit `coordinator.flow` overrides the
  // mode-derived preset per component. `mode` thus becomes a preset alias.
  const preset = MODE_FLOW_PRESET[mode];
  const flowCfg = optionalSection(check, 'flow', coord.flow);
  const plannerCfg = optionalSection(check, 'flow.planner', flowCfg?.planner);
  const executorCfg = optionalSection(
    check,
    'flow.executor',
    flowCfg?.executor,
  );
  const finalizerCfg = optionalSection(
    check,
    'flow.finalizer',
    flowCfg?.finalizer,
  );
  const evaluatorCfg = optionalSection(
    check,
    'flow.evaluator',
    flowCfg?.evaluator,
  );
  const plannerType = (plannerCfg?.type ?? preset.planner) as string;
  if (!['none', 'llm', 'static'].includes(plannerType))
    throw new Error(`coordinator.flow.planner.type must be none|llm|static`);
  const granularity = (plannerCfg?.granularity ?? 'shallow') as string;
  if (!['shallow', 'detailed'].includes(granularity))
    throw new Error(
      `coordinator.flow.planner.granularity must be shallow|detailed`,
    );
  const executorType = (executorCfg?.type ?? preset.executor) as string;
  if (!['simple', 'cyclic-react', 'recursive'].includes(executorType))
    throw new Error(
      `coordinator.flow.executor.type must be simple|cyclic-react|recursive`,
    );
  const finalizerType = finalizerCfg?.type ?? 'llm';
  if (finalizerType !== 'llm')
    throw new Error(
      `coordinator.flow.finalizer.type 'passthrough' is not yet implemented (use 'llm')`,
    );
  const plannerSystemPrompt = parseSystemPromptOverride(
    plannerCfg?.systemPrompt,
    'flow.planner.systemPrompt',
  );
  const executorSystemPrompt = parseSystemPromptOverride(
    executorCfg?.systemPrompt,
    'flow.executor.systemPrompt',
  );
  // 18.1 Evaluator: ON by default at all depths (per design). Disable via
  // `flow.evaluator.enabled: false`; narrow via `flow.evaluator.atDepths`.
  const evaluatorEnabled = check.flagOr(
    'flow.evaluator.enabled',
    evaluatorCfg?.enabled,
    true,
  );
  const evalAtDepths =
    evaluatorCfg?.atDepths !== undefined
      ? depths('flow.evaluator.atDepths', evaluatorCfg.atDepths)
      : 'all';
  const evaluatorAtDepths =
    evalAtDepths === 'all'
      ? { has: () => true }
      : (() => {
          const s = new Set(evalAtDepths);
          return { has: (d: number) => s.has(d) };
        })();
  const evaluatorSystemPrompt = parseSystemPromptOverride(
    evaluatorCfg?.systemPrompt,
    'flow.evaluator.systemPrompt',
  );
  const plan = parseFlowPlan(flowCfg?.plan, check, 'flow.plan');

  // Spec D83 (7): the stepper's numbers, the shared grammar and rules — named as
  // the key inside the pipeline's `config` (30.1.0: Number("x") → NaN).
  const maxParallelSteps = check.numberOr(
    'stepper.maxParallelSteps',
    R.count,
    stepper.maxParallelSteps,
    4,
  );
  const maxDepth = check.numberOr(
    'stepper.maxDepth',
    R.depth,
    stepper.maxDepth,
    4,
  );
  const tokenBudget = check.numberOr(
    'stepper.tokenBudget',
    R.count,
    stepper.tokenBudget,
    1_000_000,
  );
  const formalizeTask = check.flagOr(
    'formalizeTask',
    coord.formalizeTask,
    false,
  );

  // Nested composition nodes inherit the root bounds (a sub-cycle uses the same
  // parallelism / depth / budget / safety unless the runtime threads otherwise).
  const bounds: FlowBounds = {
    reviewerAtDepths,
    evaluatorEnabled,
    evaluatorAtDepths,
    ...(evaluatorSystemPrompt ? { evaluatorSystemPrompt } : {}),
    maxParallelSteps,
    maxDepth,
    tokenBudget,
    formalizeTask,
  };
  const nodes = parseCompositionNodes(
    flowCfg?.nodes,
    bounds,
    check,
    'flow.nodes',
  );

  const result: StepperCoordinatorConfig = {
    mode,
    reviewerAtDepths,
    maxParallelSteps,
    maxDepth,
    tokenBudget,
    knowledgeSeed,
    formalizeTask,
    flow: {
      // Declared root nodes ARE the plan ⇒ static at the root (honest spec).
      planner: (nodes ? 'static' : plannerType) as 'none' | 'llm' | 'static',
      granularity: granularity as 'shallow' | 'detailed',
      executor: executorType as 'simple' | 'cyclic-react' | 'recursive',
      finalizer: 'llm',
      ...(plannerSystemPrompt ? { plannerSystemPrompt } : {}),
      ...(executorSystemPrompt ? { executorSystemPrompt } : {}),
      evaluatorEnabled,
      evaluatorAtDepths,
      ...(evaluatorSystemPrompt ? { evaluatorSystemPrompt } : {}),
      ...(plan ? { plan } : {}),
      ...(nodes ? { nodes } : {}),
    },
  };
  // The only way the checked values leave the check; nothing after it checks a
  // field. The cross-field rules read valid values only.
  const valid = check.done(result);

  // RUNAWAY GUARD: demand-driven recursion (executor:recursive / deep-stepper)
  // terminates via the Evaluator (executable → leaf, needs-work → recurse).
  // Without it recursion has no termination judge — that is exactly the 18.0
  // runaway (141 spawns). So recursion REQUIRES the Evaluator enabled.
  if (valid.flow.executor === 'recursive' && !valid.flow.evaluatorEnabled)
    throw new Error(
      'coordinator.flow.executor.type "recursive" (deep-stepper) requires the Evaluator ' +
        '(it is the recursion terminator) — do not set coordinator.flow.evaluator.enabled: false',
    );
  // Static planner needs an explicit plan OR declared nodes (nodes ARE the plan).
  if (plannerType === 'static' && !valid.flow.plan && !valid.flow.nodes)
    throw new Error(
      `coordinator.flow.planner.type 'static' requires coordinator.flow.plan or coordinator.flow.nodes`,
    );
  return valid;
}
