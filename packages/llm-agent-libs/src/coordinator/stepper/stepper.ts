import type {
  IExecutor,
  IReviewStrategy,
  IStepper,
  IStepperInput,
  IStepperInterpreter,
  IStepperPlanner,
  IStepperResult,
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
  depth: number;
  maxParallelSteps: number;
  mintStepperId: () => string;
  parentPath?: string[];
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
      depth,
      maxParallelSteps,
      mintStepperId,
      parentPath,
    } = this.deps;
    const plan = await planner.plan({
      prompt: input.prompt,
      knowledgeRag: input.knowledgeRag,
      toolsRag: input.toolsRag,
      parentPath: parentPath ?? [this.name],
      identity: input.identity,
      signal: input.signal,
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
    return interpreter.interpret(plan, {
      prompt: input.prompt,
      knowledgeRag: input.knowledgeRag,
      toolsRag: input.toolsRag,
      childSteppers,
      executor,
      budget: input.budget,
      identity: input.identity,
      toolSafety: input.toolSafety,
      maxParallelSteps,
      mintStepperId,
      signal: input.signal,
      sessionLogger: input.sessionLogger,
      onProgress: input.onProgress,
    });
  }
}
