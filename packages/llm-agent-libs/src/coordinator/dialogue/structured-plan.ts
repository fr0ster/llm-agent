import type {
  DialoguePlan as Plan,
  DialoguePlanStep as PlanStep,
  TaskEvent,
  TaskRecord,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';

export const stepSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  worker: z.string().optional(),
  items: z.array(z.string().min(1)).optional(),
  state: z
    .enum(['pending', 'running', 'done', 'failed', 'skipped', 'blocked'])
    .optional(),
  note: z.string().optional(),
});
export function mergePlan(
  previous: string | Plan | undefined,
  input: unknown,
  status: Plan['status'],
  question?: string,
  options: {
    consent?: boolean;
    maxItemsPerStep?: number;
    getTask?: (id: string) => TaskRecord | undefined;
  } = {},
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
      const persisted =
        typeof previous === 'object'
          ? previous.steps.find((o) => o.id === s.id)
          : undefined;
      const old = persisted ? { ...persisted } : undefined;
      if (old && options.getTask) restoreSuccessfulWork(old, options.getTask);
      const items = s.items;
      const effectiveState = s.state ?? old?.state ?? 'pending';
      const roleChanged =
        (s.worker === 'checker') !== (old?.worker === 'checker');
      const dependenciesChanged =
        JSON.stringify(s.dependsOn ?? []) !==
        JSON.stringify(old?.dependsOn ?? []);
      if (
        old &&
        (roleChanged || dependenciesChanged) &&
        effectiveState !== 'pending' &&
        effectiveState !== 'skipped'
      )
        throw new Error(
          'Changing worker role or dependencies requires reopening the step as pending',
        );
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
      if (items && new Set(items).size !== items.length)
        throw new Error('Step items must be unique identifiers');
      if (effectiveState === 'running' && effectiveState !== old?.state)
        throw new Error('Running state follows actual work attempts');
      if (s.state === 'done' && old?.state !== 'done')
        throw new Error('Done requires a successful current task result');
      return {
        ...s,
        state: old
          ? effectiveState
          : s.state === 'skipped'
            ? 'skipped'
            : 'pending',
        taskIds: itemsChanged ? [] : (old?.taskIds ?? []),
        workTaskId: itemsChanged ? undefined : old?.workTaskId,
        successfulWorkTaskId:
          itemsChanged || effectiveState === 'pending'
            ? undefined
            : old?.successfulWorkTaskId,
        checkedTaskIds:
          itemsChanged || effectiveState === 'pending'
            ? undefined
            : old?.checkedTaskIds,
        note: s.note ?? old?.note,
        verdict:
          itemsChanged || effectiveState === 'pending'
            ? undefined
            : old?.verdict,
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
  return step.workTaskId ?? step.taskIds.at(-1);
}
// Only verified current persisted work may supply the optional legacy marker.
export function restoreSuccessfulWork(
  step: PlanStep,
  getTask: (id: string) => TaskRecord | undefined,
): void {
  if (step.successfulWorkTaskId !== undefined || step.state === 'pending')
    return;
  const id = currentWorkTaskId(step);
  const task = id ? getTask(id) : undefined;
  if (
    id &&
    step.taskIds.includes(id) &&
    task?.state === 'done' &&
    !(step.items && task.budgetExhausted)
  ) {
    step.workTaskId = id;
    step.successfulWorkTaskId = id;
  }
}
export function currentAttemptIds(step: PlanStep): string[] {
  const id = currentWorkTaskId(step);
  return id ? [id] : [];
}
/** Normalize persisted pre-check-step plans without changing their work history. */
export function restoreLegacyStep(step: PlanStep): void {
  if ('check' in step) {
    const legacy = z
      .object({ taskId: z.string().optional() })
      .safeParse(step.check);
    if (!step.workTaskId)
      step.workTaskId = step.taskIds
        .filter(
          (id) => id !== (legacy.success ? legacy.data.taskId : undefined),
        )
        .at(-1);
    delete step.check;
  }
  if (String(step.state) === 'checking') {
    step.state = 'done';
    step.note = [
      step.note,
      'Legacy check was not run; plan a separate check step if needed',
    ]
      .filter(Boolean)
      .join('; ');
  }
}

export function recomputePlanStatus(plan?: Plan): void {
  if (!plan?.steps.length || plan.status === 'waiting_user') return;
  if (plan.steps.every((s) => s.state === 'done' || s.state === 'skipped')) {
    plan.status = 'done';
    delete plan.question;
  } else if (plan.status === 'done') plan.status = 'active';
}
// The verdict is the whole output or the outermost JSON objects in prose or
// fences. Nested objects are evidence; conflicting verdicts are unusable.
const verdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  count: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});
type CheckerVerdict = z.infer<typeof verdictSchema>;
function checkerVerdict(output: string): CheckerVerdict | undefined {
  const parse = (text: string): CheckerVerdict | undefined => {
    try {
      const value = verdictSchema.safeParse(JSON.parse(text));
      return value.success ? value.data : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = parse(output.trim());
  if (whole !== undefined) return whole;
  const candidates: CheckerVerdict[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < output.length; i++) {
    const char = output[i];
    if (depth === 0) {
      if (char === '{') {
        depth = 1;
        start = i;
      }
    } else if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      const value = parse(output.slice(start, i + 1));
      if (value === undefined) return undefined;
      candidates.push(value);
    }
  }
  if (depth !== 0) return undefined;
  // Every outcome field must agree: quoted evidence cannot change the result.
  const outcome = (c: CheckerVerdict) => JSON.stringify([c.verdict, c.count]);
  if (new Set(candidates.map(outcome)).size !== 1) return undefined;
  return candidates.at(-1);
}
function checkSourcesCurrent(plan: Plan, step: PlanStep): boolean {
  return (step.dependsOn ?? []).every((id) => {
    const source = plan.steps.find((s) => s.id === id);
    return (
      source?.successfulWorkTaskId !== undefined &&
      step.checkedTaskIds?.[id] === source.successfulWorkTaskId
    );
  });
}
function resetStaleCheck(step: PlanStep): void {
  step.state = 'pending';
  delete step.verdict;
  delete step.successfulWorkTaskId;
  delete step.checkedTaskIds;
  step.note =
    'Checked results changed; delegate this check again for the current results';
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
  if (
    !step ||
    step.state === 'skipped' ||
    kind === 'started' ||
    kind === 'long_running'
  )
    return;
  // Older retry outcomes cannot overwrite the current attempt.
  if (!currentAttemptIds(step).includes(task.id)) return;
  if (step.worker === 'checker' && plan && !checkSourcesCurrent(plan, step)) {
    resetStaleCheck(step);
    return;
  }
  if (currentWorkTaskId(step) === task.id) {
    step.workTaskId = task.id;
    step.successfulWorkTaskId =
      kind === 'done' &&
      task.state === 'done' &&
      !(step.items && task.budgetExhausted)
        ? task.id
        : undefined;
  }
  if (step.successfulWorkTaskId && plan) {
    for (const check of plan.steps) {
      if (
        check.worker === 'checker' &&
        check.state !== 'skipped' &&
        check.dependsOn?.includes(step.id) &&
        !checkSourcesCurrent(plan, check)
      )
        resetStaleCheck(check);
    }
  }
  if (step.items && task.budgetExhausted) {
    step.state = 'failed';
    step.note = `Worker hit the tool-call budget ${task.toolCalls ?? '?'}/${task.maxToolCalls ?? '?'}; split the step (${step.items.length} items) before retrying`;
    return;
  }
  if (kind !== 'done') {
    if (step.worker === 'checker') step.verdict = 'fail';
    step.state = 'failed';
    step.note = task.error ?? kind;
    return;
  }
  if (step.worker === 'checker') {
    const output = task.output?.trim() ?? '';
    const verdict = /^(PASS|FAIL)$/i.test(output)
      ? { verdict: output.toLowerCase() }
      : checkerVerdict(output);
    const parsed = z
      .object({
        verdict: z.enum(['pass', 'fail']),
        note: z.string().optional(),
        count: z.number().int().nonnegative().optional(),
      })
      .safeParse(verdict);
    const expected = (step.dependsOn ?? []).flatMap(
      (id) => plan?.steps.find((s) => s.id === id)?.items ?? [],
    );
    if (!parsed.success) {
      step.verdict = 'fail';
      step.state = 'failed';
      step.note =
        'Checker returned an unusable verdict; plan a fix step and a new check';
    } else {
      const short =
        expected.length > 0 && (parsed.data.count ?? -1) < expected.length;
      step.verdict = short ? 'fail' : parsed.data.verdict;
      step.state = step.verdict === 'pass' ? 'done' : 'failed';
      step.note = short
        ? `Count ${parsed.data.count ?? 'missing'}/${expected.length}: missing item results`
        : (parsed.data.note ?? parsed.data.verdict);
    }
  } else {
    step.state = 'done';
    if (task.budgetExhausted)
      step.note = `Worker hit the tool-call budget ${task.toolCalls ?? '?'}/${task.maxToolCalls ?? '?'}; verify the result is complete or split the step`;
  }
}
/** Require a passing check and no failing latest check attempts. */
export function deliveryChecksPassed(plan: Plan, stepId: string): boolean {
  const checks = plan.steps.filter(
    (s) => s.worker === 'checker' && s.dependsOn?.includes(stepId),
  );
  if (!checks.length) return true;
  const latest = checks.filter(
    (s) => !checks.some((next) => next.dependsOn?.includes(s.id)),
  );
  return (
    latest.some(
      (s) =>
        s.state === 'done' &&
        s.verdict === 'pass' &&
        checkSourcesCurrent(plan, s),
    ) && !latest.some((s) => s.state === 'failed' || s.verdict === 'fail')
  );
}

export function planView(plan?: Plan): string {
  if (!plan) return '[plan] status: active\nnone';
  const priority = (step: PlanStep): number => {
    if (step.state === 'pending' && dependenciesDone(plan, step)) return 0;
    if (step.state === 'running') return 1;
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
      const older = s.taskIds.filter((id) => !current.includes(id)).length;
      const attempts = [
        work ? `work ${work}` : '',
        older ? `${older} older attempts` : '',
      ].filter(Boolean);
      return `${s.id} ${s.state === 'pending' && dependenciesDone(plan, s) ? 'ready' : s.state} ${s.goal.replace(/\s+/g, ' ')}${s.dependsOn?.length ? ` (depends on ${s.dependsOn.join(', ')})` : ''}${attempts.length ? ` (${attempts.join(', ')})` : ''}${s.items ? `; items: ${s.items.length}` : ''}${s.note ? ` \u00b7 ${s.note}` : ''}`;
    }),
  ]
    .filter(Boolean)
    .join('\n');
}
