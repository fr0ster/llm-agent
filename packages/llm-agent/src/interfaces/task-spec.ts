/**
 * TaskSpec — the formalized overall task.
 *
 * Produced ONCE at the coordinator root by an {@link ITaskFormalizer} and then
 * threaded down through every planner and executor (as a compact anchor) so no
 * level "forgets" it is part of the overall task. It is BOUNDED on purpose — a
 * few short fields, never the full conversation — to anchor context without a
 * context explosion. Optional everywhere: when absent, the runtime behaves
 * exactly as before (backward-compatible).
 */
export interface ITaskSpec {
  /** The overall objective in one sentence. */
  objective: string;
  /** What the task should cover (optional). */
  scope?: string;
  /** Hard constraints the work must respect (optional). */
  constraints?: readonly string[];
  /** Expected shape of the final deliverable (optional). */
  deliverable?: string;
  /** The original user request, verbatim — the ground truth. */
  raw: string;
}

/**
 * Turns a raw prompt into a {@link ITaskSpec}. Implemented once with the
 * strong (planner-tier) model at the coordinator root. MUST never throw on a
 * bad LLM response — fall back to `{ objective: prompt, raw: prompt }`.
 */
export interface ITaskFormalizer {
  readonly name: string;
  formalize(input: {
    prompt: string;
    signal?: AbortSignal;
  }): Promise<ITaskSpec>;
}

/**
 * Render a TaskSpec as a compact, bounded anchor block for planner/executor
 * prompts. A few lines — NOT the full history. Used both as a persistent
 * "main task" reminder in the executor and as the overall-intent prefix for the
 * tool-search query.
 */
export function renderTaskSpec(spec: ITaskSpec): string {
  const lines = [`Overall task: ${spec.objective}`];
  if (spec.scope) lines.push(`Scope: ${spec.scope}`);
  if (spec.constraints && spec.constraints.length > 0)
    lines.push(`Constraints: ${spec.constraints.join('; ')}`);
  if (spec.deliverable) lines.push(`Deliverable: ${spec.deliverable}`);
  return lines.join('\n');
}
