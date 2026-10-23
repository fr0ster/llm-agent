import type {
  DialoguePlan as Plan,
  DialoguePlanStep as PlanStep,
  TaskEvent,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';

export const stepSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  worker: z.string().optional(),
  state: z
    .enum([
      'pending',
      'running',
      'checking',
      'done',
      'failed',
      'skipped',
      'blocked',
    ])
    .optional(),
  note: z.string().optional(),
  check: z
    .object({ by: z.enum(['planner', 'checker']), goal: z.string().min(1) })
    .optional(),
});
export function mergePlan(
  previous: string | Plan | undefined,
  input: unknown,
  status: Plan['status'],
  question?: string,
): Plan {
  const steps = z.array(stepSchema).parse(input);
  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) throw new Error('duplicate step id');
  for (const s of steps) {
    if (s.dependsOn?.some((id) => !ids.has(id) || id === s.id))
      throw new Error('invalid dependency');
    if (s.state === 'skipped' && !s.note?.trim())
      throw new Error('skipped requires a note');
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('cyclic dependencies');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of steps.find((s) => s.id === id)?.dependsOn ?? [])
      visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return {
    version: 1,
    status,
    question,
    steps: steps.map((s) => {
      const old =
        typeof previous === 'object'
          ? previous.steps.find((o) => o.id === s.id)
          : undefined;
      if (
        old?.state === 'checking' &&
        (s.state === 'done' || s.state === 'failed') &&
        !s.note?.trim()
      )
        throw new Error('closing a check requires a note');
      const check = s.check
        ? { ...old?.check, ...s.check }
        : old?.check
          ? { ...old.check }
          : undefined;
      if (
        check?.by === 'planner' &&
        (s.state === 'done' || s.state === 'failed')
      )
        check.verdict = s.state === 'done' ? 'pass' : 'fail';
      return {
        ...s,
        state: old ? (s.state ?? old.state) : 'pending',
        taskIds: old?.taskIds ?? [],
        workTaskId: old?.workTaskId,
        note: s.note ?? old?.note,
        check,
      };
    }),
  };
}
export function dependenciesDone(plan: Plan, step: PlanStep): boolean {
  return (step.dependsOn ?? []).every((id) =>
    plan.steps.some((s) => s.id === id && s.state === 'done'),
  );
}
export function readySteps(plan?: Plan): PlanStep[] {
  return (
    plan?.steps.filter(
      (s) => s.state === 'pending' && dependenciesDone(plan, s),
    ) ?? []
  );
}
export function currentWorkTaskId(step: PlanStep): string | undefined {
  return (
    step.workTaskId ??
    step.taskIds.filter((id) => id !== step.check?.taskId).at(-1)
  );
}
export function currentAttemptIds(step: PlanStep): string[] {
  const work = currentWorkTaskId(step);
  const check = step.check?.taskId;
  return [
    work,
    check && step.taskIds.indexOf(check) > step.taskIds.indexOf(work ?? '')
      ? check
      : undefined,
  ].filter((id): id is string => id !== undefined);
}
export function recomputePlanStatus(plan?: Plan): void {
  if (!plan?.steps.length) return;
  if (plan.steps.every((s) => s.state === 'done' || s.state === 'skipped')) {
    plan.status = 'done';
    delete plan.question;
  } else if (plan.status === 'done') plan.status = 'active';
}
export function applyTaskEvent(
  plan: Plan | undefined,
  { task, kind }: TaskEvent,
  taskSteps?: ReadonlyMap<string, string>,
): void {
  const owner = taskSteps?.get(task.id);
  const step = plan?.steps.find((s) =>
    owner === undefined ? s.taskIds.includes(task.id) : s.id === owner,
  );
  if (!step || step.state === 'skipped' || kind === 'started') return;
  // Older retry outcomes cannot overwrite the current attempt.
  if (!currentAttemptIds(step).includes(task.id)) return;
  if (kind !== 'done') {
    step.state = 'failed';
    step.note = task.error ?? kind;
    return;
  }
  if (step.check?.taskId === task.id) {
    step.state = 'checking';
    try {
      const verdict: unknown = JSON.parse(task.output ?? '');
      const parsed = z
        .object({
          verdict: z.enum(['pass', 'fail']),
          note: z.string().optional(),
        })
        .safeParse(verdict);
      if (parsed.success) {
        step.check.verdict = parsed.data.verdict;
        step.state = parsed.data.verdict === 'pass' ? 'done' : 'failed';
        step.note = parsed.data.note ?? parsed.data.verdict;
      }
    } catch {
      /* The planner decides when a checker has no structured verdict. */
    }
  } else step.state = step.check ? 'checking' : 'done';
}
export function planView(plan?: Plan): string {
  if (!plan) return '[plan] status: active\nnone';
  const priority = (step: PlanStep): number => {
    if (step.state === 'pending' && dependenciesDone(plan, step)) return 0;
    if (step.state === 'running' || step.state === 'checking') return 1;
    if (step.state === 'pending') return 2;
    if (step.state === 'failed' || step.state === 'blocked') return 3;
    return 4;
  };
  const sorted = [...plan.steps].sort((a, b) => priority(a) - priority(b));
  const visible = sorted.slice(0, 40);
  const collapsed = new Map<string, number>();
  for (const step of sorted.slice(visible.length))
    collapsed.set(step.state, (collapsed.get(step.state) ?? 0) + 1);
  return [
    `[plan] status: ${plan.status}`,
    plan.question,
    plan.note,
    ...[...collapsed].map(
      ([state, count]) => `(${count} ${state} steps collapsed; use get_plan)`,
    ),
    ...visible.map((s) => {
      const current = currentAttemptIds(s);
      const work = currentWorkTaskId(s);
      const check = s.check?.taskId;
      const older = s.taskIds.filter((id) => !current.includes(id)).length;
      const attempts = [
        work ? `work ${work}` : '',
        check && current.includes(check) ? `check ${check}` : '',
        older ? `${older} older attempts` : '',
      ].filter(Boolean);
      return `${s.id} ${s.state === 'pending' && dependenciesDone(plan, s) ? 'ready' : s.state} ${s.goal.replace(/\s+/g, ' ')}${s.dependsOn?.length ? ` (depends on ${s.dependsOn.join(', ')})` : ''}${attempts.length ? ` (${attempts.join(', ')})` : ''}${s.check ? `; check by ${s.check.by}: ${s.check.goal.replace(/\s+/g, ' ').trim()}` : ''}${s.note ? ` ? ${s.note}` : ''}`;
    }),
  ]
    .filter(Boolean)
    .join('\n');
}
