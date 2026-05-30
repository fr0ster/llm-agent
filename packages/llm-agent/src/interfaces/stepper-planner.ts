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
     * Child worker Steppers available for delegation (deep-stepper mode). The
     * planner renders these into its prompt and may set a node's `agent` to one
     * of these names to recurse into that child. Empty/omitted → the planner
     * emits only leaves (executor-handled), i.e. flat planned-react behaviour.
     */
    agents?: ReadonlyArray<{ name: string; description?: string }>;
    signal?: AbortSignal;
  }): Promise<DagPlan>;
}
