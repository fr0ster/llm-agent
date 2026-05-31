import type { ILlm, ITaskFormalizer, ITaskSpec } from '@mcp-abap-adt/llm-agent';

export const TASK_FORMALIZER_SYSTEM = `You formalize a user's request into a COMPACT task specification for a multi-step agent that works on a system through tools.
Extract ONLY what is needed to keep every later step aligned to the overall task. Be terse — a few lines, not an essay. Do NOT invent requirements the user did not state; do NOT plan steps or name tools.
Respond with ONLY this JSON:
{"objective":"one sentence — the overall goal","scope":"what must be covered (optional)","constraints":["hard constraints that every step must respect"],"deliverable":"shape of the final answer (optional)"}
The "constraints" array must capture everything that must be known throughout the run (e.g. "analyse the complete source including all includes", "read-only", required dimensions). Keep each entry short.`;

/**
 * Formalizes the raw prompt into a compact {@link ITaskSpec} with one LLM call
 * (use the strong/planner-tier model). NEVER throws: on any LLM or parse error
 * it falls back to `{ objective: prompt, raw: prompt }`, so the run proceeds
 * exactly as if no formalizer were configured.
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
    const fallback: ITaskSpec = { objective: input.prompt, raw: input.prompt };
    try {
      const res = await this.llm.chat(
        [
          { role: 'system', content: TASK_FORMALIZER_SYSTEM },
          { role: 'user', content: input.prompt },
        ] as never,
        [] as never,
        { signal: input.signal },
      );
      if ((res as { ok: boolean }).ok === false) return fallback;
      const content = (res as { value: { content: string } }).value.content;
      return parseTaskSpec(content, input.prompt) ?? fallback;
    } catch {
      return fallback;
    }
  }
}

/** Parse the formalizer's JSON reply into an ITaskSpec. Returns null on failure
 *  so the caller falls back. Tolerates ```json fences and surrounding prose. */
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
