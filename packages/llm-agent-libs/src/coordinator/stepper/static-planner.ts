import type {
  DagPlan,
  IStepperPlanner,
  PlanNode,
} from '@mcp-abap-adt/llm-agent';

/**
 * StaticPlanner — emits a plan declared in yaml (`coordinator.flow.plan`)
 * verbatim, with NO LLM call. This is the declarative end of the plan-depth
 * axis: the operator describes the exact sequence of node goals + dependencies
 * and the interpreter walks it. Deterministic, fully inspectable from the
 * config (answers "what is the system doing" without a trace).
 *
 * The objective is taken from the formalized TaskSpec when present, else from
 * the incoming prompt — so the executor anchor and the plan share one objective.
 */
export class StaticPlanner implements IStepperPlanner {
  readonly name = 'static';

  constructor(private readonly nodes: readonly PlanNode[]) {}

  async plan(input: {
    prompt: string;
    taskSpec?: { objective: string };
  }): Promise<DagPlan> {
    return {
      objective: input.taskSpec?.objective ?? input.prompt,
      nodes: this.nodes.map((n) => ({ ...n })),
      createdAt: 0,
    };
  }
}
