import type { DagPlan } from './dag-plan.js';
import type { IExecutor } from './executor.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type {
  Budget,
  IStepper,
  IStepperResult,
  RunIdentity,
  ToolSafetyPolicy,
} from './stepper.js';
import type { StreamChunk } from './streaming.js';

export interface IStepperInterpreter {
  readonly name: string;
  interpret(
    plan: DagPlan,
    ctx: {
      prompt: string;
      knowledgeRag: IKnowledgeRagHandle;
      toolsRag: IToolsRagHandle;
      childSteppers: ReadonlyMap<string, IStepper>;
      executor: IExecutor;
      budget: Budget;
      identity: RunIdentity;
      toolSafety: ToolSafetyPolicy;
      maxParallelSteps: number;
      mintStepperId: () => string;
      signal?: AbortSignal;
      sessionLogger?: { logStep(name: string, data: unknown): void };
      onProgress?: (event: StreamChunk) => void;
    },
  ): Promise<IStepperResult>;
}
