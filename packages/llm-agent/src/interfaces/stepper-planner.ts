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
    signal?: AbortSignal;
  }): Promise<DagPlan>;
}
