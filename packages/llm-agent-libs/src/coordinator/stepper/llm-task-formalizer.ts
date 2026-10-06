import type { ILlm, ITaskFormalizer, ITaskSpec } from '@mcp-abap-adt/llm-agent';
import { coordinatorError } from '../coordinator-error.js';

export const TASK_FORMALIZER_SYSTEM = `You formalize a user's request into a COMPACT task specification for a multi-step agent that works on a system through tools.
Extract ONLY what is needed to keep every later step aligned to the overall task. Be terse — a few lines, not an essay. Do NOT invent requirements the user did not state; do NOT plan steps or name tools.
Respond with ONLY this JSON:
{"objective":"one sentence — the overall goal","scope":"what must be covered (optional)","constraints":["hard constraints that every step must respect"],"deliverable":"shape of the final answer (optional)"}
The "constraints" array must capture everything that must be known throughout the run (e.g. "analyse the complete source including all includes", "read-only", required dimensions). Keep each entry short.`;

/**
 * Formalizes the raw prompt into a compact {@link ITaskSpec} with one LLM call
 * (use the strong/planner-tier model). An LLM error (an `ok: false` answer or a
 * rejection) or unparseable output fails the plan (`COORDINATOR_PLAN_FAILED`,
 * spec §10.5.7 C7) — never a raw-prompt spec standing in for a formalized one.
 */
export class LlmTaskFormalizer implements ITaskFormalizer {
  readonly name = 'llm-task-formalizer';
  readonly model?: string;

  constructor(private readonly llm: ILlm) {
    this.model = llm.model;
  }

  async formalize(input: {
    prompt: string;
    signal?: AbortSignal;
  }): Promise<ITaskSpec> {
    let res: Awaited<ReturnType<ILlm['chat']>>;
    try {
      res = await this.llm.chat(
        [
          { role: 'system', content: TASK_FORMALIZER_SYSTEM },
          { role: 'user', content: input.prompt },
        ],
        [],
        { signal: input.signal },
      );
    } catch (err) {
      throw coordinatorError(
        'task formalizer: LLM call failed',
        err,
        'COORDINATOR_PLAN_FAILED',
      );
    }
    if (res.ok === false)
      throw coordinatorError(
        'task formalizer: LLM call failed',
        res.error,
        'COORDINATOR_PLAN_FAILED',
      );
    const spec = parseTaskSpec(res.value.content, input.prompt);
    if (!spec)
      throw coordinatorError(
        'task formalizer',
        new Error(`unparseable output: ${res.value.content.slice(0, 200)}`),
        'COORDINATOR_PLAN_FAILED',
      );
    return spec;
  }
}

/** Parse the formalizer's JSON reply into an ITaskSpec. Returns null on failure
 *  (the formalizer then fails the plan). Tolerates ```json fences and
 *  surrounding prose. */
export function parseTaskSpec(content: string, raw: string): ITaskSpec | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const objective =
    typeof obj.objective === 'string' && obj.objective.trim()
      ? obj.objective.trim()
      : raw;
  const scope =
    typeof obj.scope === 'string' && obj.scope.trim()
      ? obj.scope.trim()
      : undefined;
  const deliverable =
    typeof obj.deliverable === 'string' && obj.deliverable.trim()
      ? obj.deliverable.trim()
      : undefined;
  const constraints = Array.isArray(obj.constraints)
    ? obj.constraints
        .filter(
          (c): c is string => typeof c === 'string' && c.trim().length > 0,
        )
        .map((c) => c.trim())
    : undefined;
  return {
    objective,
    raw,
    ...(scope ? { scope } : {}),
    ...(deliverable ? { deliverable } : {}),
    ...(constraints && constraints.length > 0 ? { constraints } : {}),
  };
}
