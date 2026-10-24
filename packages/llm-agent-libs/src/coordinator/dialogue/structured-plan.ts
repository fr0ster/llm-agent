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
  items: z.array(z.string().min(1)).optional(),
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
  options: { consent?: boolean; maxItemsPerStep?: number } = {},
): Plan {
  const steps = z.array(stepSchema).parse(input);
  if (status === 'waiting_user' && !question?.trim())
    throw new Error('waiting_user requires question');
  const oldSteps = typeof previous === 'object' ? previous.steps : [];
  const narrowing = oldSteps.some((old) => {
    const next = steps.find((s) => s.id === old.id);
    return (
      (!next && old.state !== 'done' && old.state !== 'skipped') ||
      (old.items?.some((item) => !next?.items?.includes(item)) ?? false)
    );
  });
  if (
    !options.consent &&
    (narrowing ||
      steps.some(
        (s) =>
          s.state === 'skipped' &&
          oldSteps.find((old) => old.id === s.id)?.state !== 'skipped',
      ))
  )
    throw new Error(
      'Skipping or narrowing requires user consent: set waiting_user with a question and wait for a user message before updating the plan',
    );
  for (const step of steps) {
    if (
      options.maxItemsPerStep !== undefined &&
      (step.items?.length ?? 0) > options.maxItemsPerStep
    )
      throw new Error(
        `Step ${step.id} exceeds maxItemsPerStep ${options.maxItemsPerStep}; split the step`,
      );
  }
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
      const ownershipChanged =
        !!old?.check && !!s.check && old.check.by !== s.check.by;
      if (ownershipChanged && (s.state === 'done' || s.state === 'failed'))
        throw new Error(
          'Changing check ownership requires a fresh check before completion',
        );
      if (ownershipChanged && check) {
        delete check.taskId;
        delete check.verdict;
      }
      const items = s.items;
      const effectiveState =
        s.state ??
        (ownershipChanged && (old?.state === 'done' || old?.state === 'failed')
          ? 'checking'
          : old?.state) ??
        'pending';
      const itemsChanged = JSON.stringify(old?.items) !== JSON.stringify(items);
      if (
        (items || old?.items) &&
        old &&
        itemsChanged &&
        effectiveState !== 'pending' &&
        effectiveState !== 'skipped'
      )
        throw new Error(
          'Changed batch items require reopening the step as pending and a fresh work/check attempt',
        );
      if (old && itemsChanged && check) {
        delete check.taskId;
        delete check.verdict;
      }
      if (items && new Set(items).size !== items.length)
        throw new Error('Step items must be unique identifiers');
      if (
        items &&
        (effectiveState === 'running' || effectiveState === 'checking') &&
        !(
          ownershipChanged &&
          s.state === undefined &&
          effectiveState === 'checking'
        ) &&
        effectiveState !== old?.state
      )
        throw new Error(
          'Batch running/checking state follows actual work attempts',
        );
      if (
        items &&
        effectiveState === 'done' &&
        (itemsChanged || !old?.check || old.check.verdict !== 'pass') &&
        old?.state !== 'checking'
      )
        throw new Error(
          'Steps with items require successful work and a passing check before done',
        );
      if (items && !check) throw new Error('Steps with items require a check');
      if (
        items &&
        s.state === 'done' &&
        old?.state !== 'checking' &&
        old?.state !== 'done'
      )
        throw new Error(
          'Steps with items require successful work and a passing check before done',
        );
      if (
        items &&
        s.state === 'done' &&
        check?.by === 'checker' &&
        check.verdict !== 'pass'
      )
        throw new Error('Steps with items require a passing checker verdict');
      if (
        check?.by === 'planner' &&
        (s.state === 'done' || s.state === 'failed')
      )
        check.verdict = s.state === 'done' ? 'pass' : 'fail';
      return {
        ...s,
        state: old
          ? effectiveState
          : s.state === 'skipped'
            ? 'skipped'
            : 'pending',
        taskIds: itemsChanged
          ? []
          : (old?.taskIds ?? []).filter(
              (id) => !ownershipChanged || id !== old?.check?.taskId,
            ),
        workTaskId: itemsChanged ? undefined : old?.workTaskId,
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
  if (step.items && task.budgetExhausted) {
    step.state = 'failed';
    step.note = `Worker hit the tool-call budget ${task.toolCalls ?? '?'}/${task.maxToolCalls ?? '?'}; split the step (${step.items.length} items) before retrying`;
    return;
  }
  if (
    kind === 'done' &&
    !step.items &&
    task.budgetExhausted &&
    currentWorkTaskId(step) === task.id
  ) {
    const note = `Worker hit the tool-call budget ${task.toolCalls ?? '?'}/${task.maxToolCalls ?? '?'}; verify the result is complete or split the step`;
    step.state = 'checking';
    step.check ??= { by: 'planner', goal: note };
    step.note = note;
    return;
  }
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
          count: z.number().optional(),
        })
        .safeParse(verdict);
      if (parsed.success) {
        if (step.items && parsed.data.count === undefined) {
          parsed.data.verdict = 'fail';
          parsed.data.note = `checker did not report count for ${step.items.length} items`;
        } else if (
          step.items &&
          parsed.data.count !== undefined &&
          parsed.data.count < step.items.length
        ) {
          parsed.data.verdict = 'fail';
          parsed.data.note =
            `${parsed.data.note ?? ''} Count ${parsed.data.count}/${step.items.length}: missing item results`.trim();
        }
        step.check.verdict = parsed.data.verdict;
        step.state = parsed.data.verdict === 'pass' ? 'done' : 'failed';
        step.note = parsed.data.note ?? parsed.data.verdict;
      }
    } catch {
      /* The planner decides when a checker has no structured verdict. */
    }
  } else step.state = step.check || step.items ? 'checking' : 'done';
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
      return `${s.id} ${s.state === 'pending' && dependenciesDone(plan, s) ? 'ready' : s.state} ${s.goal.replace(/\s+/g, ' ')}${s.dependsOn?.length ? ` (depends on ${s.dependsOn.join(', ')})` : ''}${attempts.length ? ` (${attempts.join(', ')})` : ''}${s.items ? `; items: ${s.items.length}` : ''}${s.check ? `; check by ${s.check.by}: ${s.check.goal.replace(/\s+/g, ' ').trim()}` : ''}${s.note ? ` \u00b7 ${s.note}` : ''}`;
    }),
  ]
    .filter(Boolean)
    .join('\n');
}
