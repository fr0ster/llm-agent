import {
  ClarifySignal,
  type IEvaluator,
  type IExecutor,
  type IReviewStrategy,
  type IStepper,
  type IStepperInput,
  type IStepperInterpreter,
  type IStepperPlanner,
  type IStepperResult,
} from '@mcp-abap-adt/llm-agent';

export interface StepperDeps {
  name: string;
  planner: IStepperPlanner;
  interpreter: IStepperInterpreter;
  executor: IExecutor;
  childSteppers: ReadonlyMap<string, IStepper>;
  reviewer?: IReviewStrategy;
  /** Depth-membership predicate (NOT a Set) so config `atDepths: 'all'`
   *  works — see Task 14. A plain `new Set([0,1])` also satisfies this
   *  shape, so tests can pass a Set directly. */
  reviewerAtDepths: { has(depth: number): boolean };
  /** 18.1 Evaluator (optional): judges the INPUT (sub-)prompt completeness WITH
   *  the RAG context before planning. Absent → behaves as 18.0 (plan → interpret). */
  evaluator?: IEvaluator;
  /** Depths at which the Evaluator runs (same predicate shape as reviewer). */
  evaluatorAtDepths?: { has(depth: number): boolean };
  depth: number;
  maxParallelSteps: number;
  mintStepperId: () => string;
  parentPath?: string[];
  /**
   * Names + descriptions of the child worker Steppers this Stepper may delegate
   * to (the keys of `childSteppers`, enriched with descriptions). Passed to the
   * planner so it can emit `agent`-bearing nodes that the interpreter recurses
   * into. Empty/omitted → planner emits only executor leaves.
   */
  childAgentCatalog?: ReadonlyArray<{ name: string; description?: string }>;
}

export class Stepper implements IStepper {
  readonly name: string;
  constructor(private readonly deps: StepperDeps) {
    this.name = deps.name;
  }

  async run(input: IStepperInput): Promise<IStepperResult> {
    const {
      planner,
      interpreter,
      executor,
      childSteppers,
      reviewer,
      reviewerAtDepths,
      evaluator,
      evaluatorAtDepths,
      depth,
      maxParallelSteps,
      mintStepperId,
      parentPath,
      childAgentCatalog,
    } = this.deps;

    // Shared interpret context (same for the executable-terminal and the
    // planned paths). The top-level prompt drives composeTask; plan nodes carry
    // the decomposition.
    const interpretCtx = {
      prompt: input.prompt,
      knowledgeRag: input.knowledgeRag,
      toolsRag: input.toolsRag,
      childSteppers,
      executor,
      budget: input.budget,
      identity: input.identity,
      taskSpec: input.taskSpec,
      externalTools: input.externalTools,
      maxParallelSteps,
      mintStepperId,
      signal: input.signal,
      sessionLogger: input.sessionLogger,
      onProgress: input.onProgress,
    };

    // 18.1 Evaluator: assess the INPUT (sub-)prompt WITH the RAG context BEFORE
    // planning, and route. Absent / not-at-this-depth → 18.0 behaviour.
    let plannerPrompt = input.prompt;
    if (evaluator && (evaluatorAtDepths?.has(depth) ?? true)) {
      const verdict = await evaluator.evaluate({
        prompt: input.prompt,
        knowledgeRag: input.knowledgeRag,
        toolsRag: input.toolsRag,
        taskSpec: input.taskSpec,
        identity: input.identity,
        signal: input.signal,
      });
      input.sessionLogger?.logStep('evaluator_verdict', {
        depth,
        route: verdict.route,
        missing: verdict.missing,
        reason: verdict.reason,
      });
      if (verdict.route === 'needs-consumer') {
        // Only the consumer can resolve this → surface a clarify up the stack
        // (the coordinator handler turns it into a clarify response).
        throw new ClarifySignal(
          verdict.missing.join('; ') ||
            'additional information is required to proceed',
        );
      }
      if (verdict.route === 'executable') {
        // Terminal: run the prompt as ONE executor leaf; do NOT plan/recurse.
        return interpreter.interpret(
          {
            objective: input.prompt,
            nodes: [{ id: 'root', goal: input.prompt }],
            createdAt: 0,
          },
          interpretCtx,
        );
      }
      // needs-work → feed the named gaps to the planner as prerequisites.
      if (verdict.missing.length > 0)
        plannerPrompt = `${input.prompt}\n\n[Prerequisites to address FIRST: ${verdict.missing.join('; ')}]`;
    }

    const plan = await planner.plan({
      prompt: plannerPrompt,
      knowledgeRag: input.knowledgeRag,
      toolsRag: input.toolsRag,
      parentPath: parentPath ?? [this.name],
      identity: input.identity,
      agents: childAgentCatalog,
      taskSpec: input.taskSpec,
      signal: input.signal,
    });
    // Log the parsed plan GRAPH (id, goal, dependsOn, agent) so the executed DAG
    // — including dependsOn EDGES — is observable, not just the node goals from
    // stepper-spawned events. Edges are what the Phase 3 dataflow keys off.
    input.sessionLogger?.logStep('coordinator_plan', {
      depth,
      stepperId: input.identity.stepperId,
      objective: plan.objective,
      nodes: plan.nodes.map((n) => ({
        id: n.id,
        goal: n.goal,
        ...(n.dependsOn ? { dependsOn: n.dependsOn } : {}),
        ...(n.agent ? { agent: n.agent } : {}),
      })),
    });
    if (reviewer && reviewerAtDepths.has(depth)) {
      const result = await reviewer.review({
        prompt: input.prompt,
        plan,
        agents: [],
        sessionId: input.identity.sessionId,
        signal: input.signal,
      } as never);
      // On rejection, a bounded replan could be added here (17.0 semantics).
      // v1: log and proceed if reviewer has no hard-fail contract.
      void result;
    }
    return interpreter.interpret(plan, interpretCtx);
  }
}
