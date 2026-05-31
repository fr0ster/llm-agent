import type { DagPlan } from './dag-plan.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { RunIdentity } from './stepper.js';

export interface IStepperPlanner {
  readonly name: string;
  plan(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    parentPath: string[];
    identity: RunIdentity;
    /**
     * Child worker Steppers available for delegation. Reserved for the recursive
     * deep-stepper mode (feature/recursive-deep-stepper branch): the planner
     * would render these into its prompt and set a node's `agent` to recurse.
     * In 18.0 it is always empty/omitted → the planner emits only leaves
     * (executor-handled), i.e. flat planned-react behaviour.
     */
    agents?: ReadonlyArray<{ name: string; description?: string }>;
    signal?: AbortSignal;
  }): Promise<DagPlan>;
}
