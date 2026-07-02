/**
 * Stepper coordinator configuration: types, constants, and parser.
 * Extracted from config.ts (R6) — byte-for-byte move.
 */

import type { PlanNode } from '@mcp-abap-adt/llm-agent';

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

/** Parse declarative `flow.plan` nodes (for the static planner). */
function parseFlowPlan(raw: unknown): PlanNode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const nodes = raw
    .filter(
      (n): n is Record<string, unknown> =>
        !!n && typeof (n as { goal?: unknown }).goal === 'string',
    )
    .map((n, i) => ({
      id: typeof n.id === 'string' && n.id ? n.id : `n${i}`,
      goal: n.goal as string,
      ...(Array.isArray(n.dependsOn)
        ? {
            dependsOn: (n.dependsOn as unknown[]).filter(
              (d) => typeof d === 'string',
            ) as string[],
          }
        : {}),
      ...(typeof n.agent === 'string' ? { agent: n.agent } : {}),
    }));
  return nodes.length > 0 ? nodes : undefined;
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
 * parseCompositionNodes (function declarations are hoisted).
 */
function parseNestedFlowSpec(
  flowCfg:
    | {
        planner?: {
          type?: string;
          granularity?: string;
          systemPrompt?: string;
        };
        executor?: { type?: string; systemPrompt?: string };
        plan?: unknown;
        nodes?: unknown;
      }
    | undefined,
  bounds: FlowBounds,
): StepperCompositionSpec {
  const plannerType = flowCfg?.planner?.type ?? 'llm';
  if (!['none', 'llm', 'static'].includes(plannerType))
    throw new Error(`flow.planner.type must be none|llm|static`);
  const granularity = flowCfg?.planner?.granularity ?? 'shallow';
  if (!['shallow', 'detailed'].includes(granularity))
    throw new Error(`flow.planner.granularity must be shallow|detailed`);
  const executor = flowCfg?.executor?.type ?? 'cyclic-react';
  if (!['simple', 'cyclic-react', 'recursive'].includes(executor))
    throw new Error(`flow.executor.type must be simple|cyclic-react|recursive`);
  const plannerSystemPrompt = parseSystemPromptOverride(
    flowCfg?.planner?.systemPrompt,
    'flow.planner.systemPrompt',
  );
  const executorSystemPrompt = parseSystemPromptOverride(
    flowCfg?.executor?.systemPrompt,
    'flow.executor.systemPrompt',
  );
  const plan = parseFlowPlan(flowCfg?.plan);
  const nodes = parseCompositionNodes(flowCfg?.nodes, bounds);
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
): CompositionNode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const nodes = raw
    .filter(
      (n): n is Record<string, unknown> =>
        !!n && typeof (n as { goal?: unknown }).goal === 'string',
    )
    .map((n, i) => ({
      id: typeof n.id === 'string' && n.id ? n.id : `n${i}`,
      goal: n.goal as string,
      ...(Array.isArray(n.dependsOn)
        ? {
            dependsOn: (n.dependsOn as unknown[]).filter(
              (d) => typeof d === 'string',
            ) as string[],
          }
        : {}),
      ...(n.flow ? { flow: parseNestedFlowSpec(n.flow as never, bounds) } : {}),
    }));
  return nodes.length > 0 ? nodes : undefined;
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

  // Tool permissioning is the MCP SERVER's responsibility — whatever it exposes
  // via tools/list is allowed. The agent does not classify tools (read-only vs
  // mutating); there is no agent-side gate. The consumer wires the agent to a
  // server that exposes only the permitted tools (e.g. a read-only MCP proxy).

  const stepper = (coord.stepper as Record<string, unknown> | undefined) ?? {};
  const reviewerCfg =
    (stepper.reviewer as { atDepths?: number[] | 'all' } | undefined) ?? {};
  const atDepths = reviewerCfg.atDepths ?? [0, 1];
  const reviewerAtDepths =
    atDepths === 'all'
      ? { has: () => true }
      : (() => {
          const s = new Set(atDepths as number[]);
          return { has: (d: number) => s.has(d) };
        })();

  const knowledgeSeed = Array.isArray(coord.knowledgeSeed)
    ? (
        coord.knowledgeSeed as Array<{
          content?: unknown;
          artifactType?: unknown;
        }>
      )
        .filter(
          (e) => e && typeof e.content === 'string' && e.content.trim() !== '',
        )
        .map((e) => ({
          content: e.content as string,
          artifactType:
            typeof e.artifactType === 'string' && e.artifactType
              ? e.artifactType
              : 'guidance',
        }))
    : [];

  // Resolve the program flow: explicit `coordinator.flow` overrides the
  // mode-derived preset per component. `mode` thus becomes a preset alias.
  const preset = MODE_FLOW_PRESET[mode];
  const flowCfg = coord.flow as
    | {
        planner?: {
          type?: string;
          granularity?: string;
          systemPrompt?: string;
        };
        executor?: { type?: string; systemPrompt?: string };
        finalizer?: { type?: string };
        evaluator?: {
          enabled?: boolean;
          atDepths?: number[] | 'all';
          systemPrompt?: string;
        };
        plan?: unknown;
        nodes?: unknown;
      }
    | undefined;
  const plannerType = flowCfg?.planner?.type ?? preset.planner;
  if (!['none', 'llm', 'static'].includes(plannerType))
    throw new Error(`coordinator.flow.planner.type must be none|llm|static`);
  const granularity = flowCfg?.planner?.granularity ?? 'shallow';
  if (!['shallow', 'detailed'].includes(granularity))
    throw new Error(
      `coordinator.flow.planner.granularity must be shallow|detailed`,
    );
  const executorType = flowCfg?.executor?.type ?? preset.executor;
  if (!['simple', 'cyclic-react', 'recursive'].includes(executorType))
    throw new Error(
      `coordinator.flow.executor.type must be simple|cyclic-react|recursive`,
    );
  const finalizerType = flowCfg?.finalizer?.type ?? 'llm';
  if (finalizerType !== 'llm')
    throw new Error(
      `coordinator.flow.finalizer.type 'passthrough' is not yet implemented (use 'llm')`,
    );
  const plannerSystemPrompt = parseSystemPromptOverride(
    flowCfg?.planner?.systemPrompt,
    'flow.planner.systemPrompt',
  );
  const executorSystemPrompt = parseSystemPromptOverride(
    flowCfg?.executor?.systemPrompt,
    'flow.executor.systemPrompt',
  );
  // 18.1 Evaluator: ON by default at all depths (per design). Disable via
  // `flow.evaluator.enabled: false`; narrow via `flow.evaluator.atDepths`.
  const evaluatorEnabled = flowCfg?.evaluator?.enabled !== false;
  // RUNAWAY GUARD: demand-driven recursion (executor:recursive / deep-stepper)
  // terminates via the Evaluator (executable → leaf, needs-work → recurse).
  // Without it recursion has no termination judge — that is exactly the 18.0
  // runaway (141 spawns). So recursion REQUIRES the Evaluator enabled.
  if (executorType === 'recursive' && !evaluatorEnabled)
    throw new Error(
      'coordinator.flow.executor.type "recursive" (deep-stepper) requires the Evaluator ' +
        '(it is the recursion terminator) — do not set coordinator.flow.evaluator.enabled: false',
    );
  const evalAtDepths = flowCfg?.evaluator?.atDepths ?? 'all';
  const evaluatorAtDepths =
    evalAtDepths === 'all'
      ? { has: () => true }
      : (() => {
          const s = new Set(evalAtDepths as number[]);
          return { has: (d: number) => s.has(d) };
        })();
  const evaluatorSystemPrompt = parseSystemPromptOverride(
    flowCfg?.evaluator?.systemPrompt,
    'flow.evaluator.systemPrompt',
  );
  const plan = parseFlowPlan(flowCfg?.plan);

  const maxParallelSteps = Number(stepper.maxParallelSteps ?? 4);
  const maxDepth = Number(stepper.maxDepth ?? 4);
  const tokenBudget = Number(stepper.tokenBudget ?? 1_000_000);
  const formalizeTask = coord.formalizeTask === true;

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
  const nodes = parseCompositionNodes(flowCfg?.nodes, bounds);

  // Static planner needs an explicit plan OR declared nodes (nodes ARE the plan).
  if (plannerType === 'static' && !plan && !nodes)
    throw new Error(
      `coordinator.flow.planner.type 'static' requires coordinator.flow.plan or coordinator.flow.nodes`,
    );

  return {
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
}
