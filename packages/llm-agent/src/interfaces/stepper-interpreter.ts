import type { DagPlan } from './dag-plan.js';
import type { IExecutor } from './executor.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type {
  Budget,
  IStepper,
  IStepperResult,
  RunIdentity,
} from './stepper.js';
import type { StreamChunk } from './streaming.js';
import type { ITaskSpec } from './task-spec.js';
import type { LlmTool } from './types.js';

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
      taskSpec?: ITaskSpec;
      /** Client external tools, threaded to each executor (issue #167). */
      externalTools?: readonly LlmTool[];
      /** Evaluator's named gaps, threaded to the executor for needs-driven
       *  tool-search (18.1). */
      evaluatorNeeds?: readonly string[];
      maxParallelSteps: number;
      mintStepperId: () => string;
      signal?: AbortSignal;
      sessionLogger?: {
        logStep(name: string, data: unknown, area?: string): void;
      };
      onProgress?: (event: StreamChunk) => void;
    },
  ): Promise<IStepperResult>;
}
