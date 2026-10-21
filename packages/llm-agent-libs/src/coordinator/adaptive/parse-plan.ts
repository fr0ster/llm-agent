import type {
  AdaptivePlan,
  AdaptiveStep,
  Result,
  Verdict,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';

/** Maximum executions accepted for a step. */
export const MAX_RUNS_CAP = 5;
const context = z.object({
  spec: z.boolean().optional(),
  history: z.enum(['none', 'last-turn', 'all']).optional(),
  results: z.array(z.string().min(1)).optional(),
  note: z.string().optional(),
});
const id = z.string().min(1);
const maxRuns = z.number().int().min(1).max(MAX_RUNS_CAP);
const stepSchema = z.discriminatedUnion('kind', [
  z.object({
    id,
    kind: z.literal('work'),
    goal: z.string(),
    worker: id,
    context: context.optional(),
    maxRuns: maxRuns.default(1),
  }),
  z.object({
    id,
    kind: z.literal('check'),
    goal: z.string(),
    worker: id,
    targets: z.array(id),
    context: context.optional(),
    onPass: id,
    onFail: id,
    onPartial: id.optional(),
    maxRuns: maxRuns.default(3),
  }),
  z.object({ id, kind: z.literal('ask'), question: z.string() }),
  z.object({
    id,
    kind: z.literal('revise'),
    reason: z.string(),
    maxRuns: maxRuns.default(1),
  }),
  z.object({
    id,
    kind: z.literal('answer'),
    from: id.optional(),
    text: z.string().optional(),
  }),
]);
const specSchema = z.object({
  objective: z.string(),
  scope: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  deliverable: z.string().optional(),
  raw: z.string().default(''),
});

// Scan balanced top-level objects, ignoring braces and escaped quotes in strings.
function lastObject(raw: string): unknown {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let last: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (depth === 0) {
      if (char === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) last = raw.slice(start, i + 1);
  }
  // A trailing unbalanced '{' after a complete object does not discard it.
  if (last === undefined) throw new Error('No complete JSON object');
  return JSON.parse(last);
}

/** Validate step shapes, worker names, run caps, and all plan references. */
export function validateSteps(
  steps: unknown,
  opts: {
    workers: readonly string[];
    takenIds?: ReadonlySet<string>;
    knownIds?: ReadonlySet<string>;
  },
): Result<AdaptiveStep[], string> {
  if (!Array.isArray(steps) || steps.length === 0)
    return { ok: false, error: 'steps must be a non-empty array' };
  const parsed: AdaptiveStep[] = [];
  const ids = new Set<string>();
  for (const value of steps) {
    const label =
      typeof value === 'object' && value !== null && 'id' in value
        ? String(value.id)
        : '<unknown>';
    const result = stepSchema.safeParse(value);
    if (!result.success)
      return { ok: false, error: `step ${label}: ${result.error.message}` };
    const step = result.data;
    if (
      step.id === 'next' ||
      step.id === 'end' ||
      ids.has(step.id) ||
      opts.takenIds?.has(step.id)
    )
      return { ok: false, error: `step ${step.id}: reserved or duplicate id` };
    ids.add(step.id);
    parsed.push(step);
  }
  const known = (ref: string) => ids.has(ref) || opts.knownIds?.has(ref);
  for (const step of parsed) {
    const fail = (message: string): Result<AdaptiveStep[], string> => ({
      ok: false,
      error: `step ${step.id}: ${message}`,
    });
    if (step.kind === 'work' || step.kind === 'check') {
      if (
        !opts.workers.includes(step.worker) &&
        !(step.kind === 'check' && step.worker === 'self')
      )
        return fail(`unknown worker ${step.worker}`);
      for (const ref of step.context?.results ?? [])
        if (!known(ref)) return fail(`unknown result ${ref}`);
    }
    if (step.kind === 'check') {
      for (const ref of step.targets)
        if (!known(ref)) return fail(`unknown target ${ref}`);
      for (const ref of [step.onPass, step.onFail, step.onPartial])
        if (ref !== undefined && ref !== 'next' && ref !== 'end' && !known(ref))
          return fail(`unknown branch ${ref}`);
    }
    if (step.kind === 'answer') {
      if ((step.from !== undefined) === (step.text !== undefined))
        return fail('answer requires exactly one of from or text');
      if (step.from !== undefined && !known(step.from))
        return fail(`unknown answer source ${step.from}`);
    }
  }
  return { ok: true, value: parsed };
}

/** Parse the last top-level JSON object in a controller response. */
export function parsePlan(
  raw: string,
  opts: { workers: readonly string[]; now?: number },
): Result<AdaptivePlan, string> {
  try {
    const shape = z
      .object({ steps: z.unknown(), spec: specSchema.optional() })
      .safeParse(lastObject(raw));
    if (!shape.success) return { ok: false, error: shape.error.message };
    const steps = validateSteps(shape.data.steps, opts);
    if (!steps.ok) return steps;
    return {
      ok: true,
      value: {
        ...(shape.data.spec ? { spec: shape.data.spec } : {}),
        steps: steps.value,
        createdAt: opts.now ?? Date.now(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Parse a worker's structured check verdict, if valid. */
export function parseVerdict(raw: string): Verdict | undefined {
  try {
    const result = z
      .object({
        verdict: z.enum(['pass', 'fail', 'partial']),
        reason: z.string().default(''),
      })
      .safeParse(lastObject(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Preserve single-worker execution when controller planning fails. */
export function fallbackPlan(
  request: string,
  worker: string,
  now = Date.now(),
): AdaptivePlan {
  return {
    createdAt: now,
    steps: [
      {
        id: 'exec',
        kind: 'work',
        goal: request,
        worker,
        context: { history: 'all' },
      },
      { id: 'answer', kind: 'answer', from: 'exec' },
    ],
  };
}
