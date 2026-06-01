import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { RunIdentity } from './stepper.js';
import type { ITaskSpec } from './task-spec.js';

/**
 * The Evaluator's verdict on a (sub-)prompt — the 18.1 control spine. Distinct
 * from the planner (decomposes the task) and the reviewer (reviews OUTPUT): the
 * Evaluator judges the INPUT — whether the (sub-)prompt is complete/executable —
 * WITH the RAG context, and the coordinator routes on the result.
 */
export type EvaluatorRoute = 'executable' | 'needs-work' | 'needs-consumer';

export interface EvaluatorVerdict {
  route: EvaluatorRoute;
  /**
   * For `needs-work`: the named gaps (what to gather/do first), fed to the
   * planner as hints. For `needs-consumer`: the question(s) to ask the consumer.
   * Empty for `executable`.
   */
  missing: string[];
  /** One-line rationale (logged; surfaced to the consumer only on needs-consumer). */
  reason?: string;
}

/**
 * Per-level task assessor. Runs in `Stepper.run` before planning and returns a
 * verdict that drives the coordinator:
 *  - `executable`    → terminal executor leaf (the recursion termination condition);
 *  - `needs-work`    → plan gather/sub-steps and proceed (verdict.missing = gaps);
 *  - `needs-consumer`→ return to the consumer with clarifying questions.
 *
 * It MUST consult the RAG context: `knowledgeRag` (what is already known/gathered)
 * and `toolsRag` (what CAN be obtained) — the needs-work vs needs-consumer split
 * hinges on whether a listed tool could obtain the missing fact. "What
 * completeness means" is agnostic: it comes from the consumer's RAG skills.
 */
export interface IEvaluator {
  readonly name: string;
  readonly model?: string;
  evaluate(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    taskSpec?: ITaskSpec;
    identity: RunIdentity;
    signal?: AbortSignal;
  }): Promise<EvaluatorVerdict>;
}
